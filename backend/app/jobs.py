"""Background execution of simulation runs.

Independent runs execute concurrently on a thread pool (numpy releases the GIL
for most of the heavy work). Status and progress are written to the database
only when the engine reports them, so the interface never shows invented
progress.
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .config import settings
from .db import SessionLocal
from .domain.retail import validate_spec
from .engine.analysis import run_sensitivity, run_stress_test
from .engine.simulation import SimulationCancelled, simulate
from .models import AuditEvent, ModelVersion, SimulationRun, utcnow
from .telemetry import RUN_DURATION, RUNS_ACTIVE, RUNS_FINISHED

log = logging.getLogger("startup.jobs")
ACTIVE = ("queued", "preparing", "running")


class JobManager:
    def __init__(self, workers: int) -> None:
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="sim")
        self.cancel_events: dict[int, threading.Event] = {}
        self.lock = threading.Lock()

    def submit(self, run_id: int) -> None:
        ev = threading.Event()
        with self.lock:
            self.cancel_events[run_id] = ev
        self.pool.submit(self._execute, run_id, ev)

    def cancel(self, run_id: int) -> bool:
        with self.lock:
            ev = self.cancel_events.get(run_id)
        if ev is None:
            return False
        ev.set()
        return True

    def _update(self, run_id: int, **fields) -> None:
        db = SessionLocal()
        try:
            run = db.get(SimulationRun, run_id)
            if run is None:
                return
            for k, v in fields.items():
                setattr(run, k, v)
            db.commit()
        finally:
            db.close()

    def _execute(self, run_id: int, cancel: threading.Event) -> None:
        db = SessionLocal()
        started = time.monotonic()
        RUNS_ACTIVE.inc()
        kind = "scenario"
        try:
            run = db.get(SimulationRun, run_id)
            if run is None:
                return
            if cancel.is_set():
                run.status, run.finished_at, run.stage = "cancelled", utcnow(), "Cancelled before start"
                db.commit()
                return
            kind = run.kind
            run.status, run.started_at, run.stage, run.progress = "preparing", utcnow(), "Loading model version and validating inputs", 0.0
            db.commit()

            version = db.get(ModelVersion, run.model_version_id)
            if version is None:
                raise ValueError("The model version for this run no longer exists.")
            spec = version.spec
            validation = validate_spec(spec, spec.get("sales_history_days"))
            if validation["status"] == "invalid":
                errs = "; ".join(i["message"] for i in validation["issues"] if i["severity"] == "error")
                raise ValueError(f"The model has errors that must be fixed first: {errs}")
            pre_warnings = []
            if validation["status"] == "exploratory":
                pre_warnings.append("Exploratory run: the model still has warnings or default values, so treat results as indicative.")
            run.inputs = {"model_version": version.version, "validation_status": validation["status"],
                          "validation_counts": validation["counts"], "default_share": validation["default_share"]}
            run.status, run.stage = "running", "Simulating"
            db.commit()

            last = {"t": 0.0, "p": 0.0}

            def progress(frac: float, stage: str) -> None:
                now = time.monotonic()
                if frac >= 1.0 or frac - last["p"] >= 0.05 or now - last["t"] > 0.5:
                    last.update(t=now, p=frac)
                    self._update(run_id, progress=round(min(frac, 1.0), 3), stage=stage[:120])

            if run.kind == "stress":
                results = run_stress_test(spec, run.levers, run.config, run.criteria, run.config.get("shocks", []),
                                          run.config.get("custom_shock"), progress, cancel)
                outcome = None
                warnings = pre_warnings
            elif run.kind == "sensitivity":
                results = run_sensitivity(spec, run.levers, run.config, run.criteria, progress, cancel)
                outcome, warnings = None, pre_warnings
            else:
                results = simulate(spec, run.levers, run.config, run.criteria, progress, cancel)
                outcome = results["outcome"]
                warnings = pre_warnings + results["warnings"]

            db.refresh(run)
            run.results = results
            run.outcome = outcome
            run.warnings = warnings
            run.progress = 1.0
            run.status = "completed_with_warnings" if warnings else "completed"
            run.stage = "Finished"
            run.finished_at = utcnow()
            db.add(AuditEvent(business_id=run.business_id, actor="engine", action=f"run.{run.status}",
                              summary=f"{run.kind.title()} run #{run.id} for '{run.scenario_name}' finished ({run.status.replace('_', ' ')}).",
                              detail={"run_id": run.id, "model_version_id": run.model_version_id, "config": run.config, "outcome": outcome}))
            db.commit()
        except SimulationCancelled:
            db.rollback()
            self._update(run_id, status="cancelled", stage="Cancelled by user", finished_at=utcnow())
        except Exception as exc:  # recorded on the run so the user can see and retry
            log.exception("run %s failed", run_id)
            db.rollback()
            self._update(run_id, status="failed", error=str(exc)[:2000], stage="Failed", finished_at=utcnow())
        finally:
            db.close()
            RUNS_ACTIVE.dec()
            final = SessionLocal()
            try:
                r = final.get(SimulationRun, run_id)
                if r is not None and r.status not in ACTIVE:
                    RUNS_FINISHED.labels(kind, r.status).inc()
                    RUN_DURATION.labels(kind).observe(time.monotonic() - started)
            finally:
                final.close()
            with self.lock:
                self.cancel_events.pop(run_id, None)


jobs = JobManager(settings.max_workers)


def recover_interrupted_runs() -> int:
    """Runs that were active when the server stopped cannot resume; mark them failed."""
    db = SessionLocal()
    try:
        stale = db.query(SimulationRun).filter(SimulationRun.status.in_(ACTIVE)).all()
        for r in stale:
            r.status, r.error, r.finished_at = "failed", "Interrupted by a server restart. Use Retry to run it again.", utcnow()
        db.commit()
        return len(stale)
    finally:
        db.close()
