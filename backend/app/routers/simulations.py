"""Scenarios (parallel worlds), simulation runs, stress tests and comparison."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..agents.workflow import decision_analyst, stress_vulnerabilities
from ..auth import current_workspace
from ..db import get_db
from ..engine.analysis import STRESS_SHOCKS, compare_runs
from ..engine.simulation import DEFAULT_LEVERS, default_criteria, merge_config, merge_levers
from ..jobs import jobs
from ..models import Business, Scenario, SimulationRun, Workspace, utcnow
from ..services import (ACTIVE, active_version, audit, completed_runs, create_standard_worlds, owned,
                        owned_business, queue_run, run_out, scenario_out, submit_after_commit)

router = APIRouter(prefix="/api", tags=["simulations"])


class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=4000)
    decision: str = Field("", max_length=2000)
    kind: str = Field("custom", pattern="^(baseline|inventory|delivery|price|stress|staffing|custom)$")
    levers: dict = Field(default_factory=dict)
    assumptions: list[str] = Field(default_factory=list)
    config: dict = Field(default_factory=dict)
    success_criteria: dict = Field(default_factory=dict)
    base_model_version_id: int | None = None
    origin: str = Field("user", max_length=60)


class ScenarioPatch(BaseModel):
    name: str | None = Field(None, max_length=120)
    description: str | None = None
    decision: str | None = None
    levers: dict | None = None
    assumptions: list[str] | None = None
    config: dict | None = None
    success_criteria: dict | None = None
    base_model_version_id: int | None = None
    archived: bool | None = None


def _clean_levers(levers: dict) -> dict:
    """Keep only known levers so a typo cannot silently do nothing."""
    unknown = [k for k in levers if k not in DEFAULT_LEVERS]
    if unknown:
        raise HTTPException(422, f"Unknown scenario setting(s): {', '.join(unknown)}.")
    merged = merge_levers(levers)
    return {k: v for k, v in merged.items() if v != DEFAULT_LEVERS[k] or k in levers}


@router.get("/scenario-levers")
def lever_catalog():
    return {"defaults": DEFAULT_LEVERS, "shocks": [{"key": k, "label": v["label"], "levers": v["levers"]} for k, v in STRESS_SHOCKS.items()]}


@router.get("/businesses/{business_id}/scenarios")
def list_scenarios(business_id: int, include_archived: bool = False, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    q = select(Scenario).where(Scenario.business_id == b.id)
    if not include_archived:
        q = q.where(Scenario.archived.is_(False))
    return [scenario_out(db, s) for s in db.scalars(q.order_by(Scenario.is_baseline.desc(), Scenario.id))]


@router.post("/businesses/{business_id}/scenarios")
def create_scenario(business_id: int, data: ScenarioIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    active_version(db, b)
    count = len(db.scalars(select(Scenario.id).where(Scenario.business_id == b.id)).all())
    s = Scenario(business_id=b.id, name=data.name, description=data.description, decision=data.decision, kind=data.kind,
                 color_index=count % 8, is_baseline=data.kind == "baseline", levers=_clean_levers(data.levers),
                 assumptions=data.assumptions, config=merge_config(data.config), success_criteria=data.success_criteria,
                 base_model_version_id=data.base_model_version_id, origin=data.origin)
    db.add(s)
    db.flush()
    audit(db, b.id, "user" if data.origin == "user" else data.origin, "scenario.created", f"Scenario '{s.name}' created.", {"scenario_id": s.id}, user.id)
    db.commit()
    return scenario_out(db, s)


@router.post("/businesses/{business_id}/scenarios/standard")
def create_standard(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    created = create_standard_worlds(db, b)
    audit(db, b.id, "user", "scenario.created", f"Added {len(created)} standard retail worlds.", {}, user.id)
    db.commit()
    return [scenario_out(db, s) for s in created]


@router.patch("/scenarios/{scenario_id}")
def patch_scenario(scenario_id: int, data: ScenarioPatch, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    s = owned(db, user, Scenario, scenario_id)
    changes = data.model_dump(exclude_unset=True)
    if "levers" in changes:
        changes["levers"] = _clean_levers(changes["levers"])
    if "config" in changes:
        changes["config"] = merge_config(changes["config"])
    for k, v in changes.items():
        setattr(s, k, v)
    s.updated_at = utcnow()
    audit(db, s.business_id, "user", "scenario.updated", f"Scenario '{s.name}' updated ({', '.join(changes)}).", {"scenario_id": s.id}, user.id)
    db.commit()
    return scenario_out(db, s)


@router.post("/scenarios/{scenario_id}/duplicate")
def duplicate_scenario(scenario_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    s = owned(db, user, Scenario, scenario_id)
    count = len(db.scalars(select(Scenario.id).where(Scenario.business_id == s.business_id)).all())
    c = Scenario(business_id=s.business_id, name=f"{s.name} (copy)"[:120], description=s.description, decision=s.decision,
                 kind="custom" if s.is_baseline else s.kind, color_index=count % 8, is_baseline=False, levers=dict(s.levers),
                 assumptions=list(s.assumptions), config=dict(s.config), success_criteria=dict(s.success_criteria),
                 base_model_version_id=s.base_model_version_id, origin=f"copy of #{s.id}")
    db.add(c)
    db.commit()
    return scenario_out(db, c)


@router.delete("/scenarios/{scenario_id}")
def archive_scenario(scenario_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    s = owned(db, user, Scenario, scenario_id)
    s.archived = True  # runs and reports that reference it are kept
    db.commit()
    return {"ok": True}


# ----------------------------------------------------------------------- runs

class RunIn(BaseModel):
    config: dict = Field(default_factory=dict)


class BatchIn(BaseModel):
    scenario_ids: list[int]
    config: dict = Field(default_factory=dict)


@router.post("/scenarios/{scenario_id}/run")
def run_scenario(scenario_id: int, data: RunIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    s = owned(db, user, Scenario, scenario_id)
    b = db.get(Business, s.business_id)
    run = queue_run(db, b, s, config_override=data.config, user=user)
    db.commit()
    submit_after_commit([run.id])
    return run_out(db, run, include_results=False)


@router.post("/businesses/{business_id}/runs/batch")
def run_batch(business_id: int, data: BatchIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Queue several independent scenarios; they execute in parallel on the worker pool."""
    b = owned_business(db, user, business_id)
    if not data.scenario_ids:
        raise HTTPException(422, "Choose at least one scenario.")
    runs = []
    for sid in data.scenario_ids[:12]:
        s = owned(db, user, Scenario, sid)
        if s.business_id != b.id:
            raise HTTPException(404, "Scenario not found.")
        runs.append(queue_run(db, b, s, config_override=data.config, user=user))
    db.commit()
    submit_after_commit([r.id for r in runs])
    return [run_out(db, r, include_results=False) for r in runs]


@router.get("/businesses/{business_id}/runs")
def list_runs(business_id: int, ids: str | None = None, kind: str | None = None, limit: int = 100,
              user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    q = select(SimulationRun).where(SimulationRun.business_id == b.id)
    if ids:
        q = q.where(SimulationRun.id.in_([int(x) for x in ids.split(",") if x.strip().isdigit()]))
    if kind:
        q = q.where(SimulationRun.kind == kind)
    return [run_out(db, r, include_results=False) for r in db.scalars(q.order_by(SimulationRun.id.desc()).limit(min(500, limit)))]


@router.get("/runs/{run_id}")
def get_run(run_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    return run_out(db, owned(db, user, SimulationRun, run_id))


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = owned(db, user, SimulationRun, run_id)
    if r.status not in ACTIVE:
        raise HTTPException(409, f"Run is already {r.status.replace('_', ' ')}.")
    if not jobs.cancel(r.id):
        r.status, r.stage, r.finished_at = "cancelled", "Cancelled", utcnow()
        db.commit()
    return {"ok": True}


@router.post("/runs/{run_id}/retry")
def retry_run(run_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Rerun with the same configuration and seed against the scenario's current settings."""
    r = owned(db, user, SimulationRun, run_id)
    if r.status in ACTIVE:
        raise HTTPException(409, "The run is still active.")
    s = db.get(Scenario, r.scenario_id) if r.scenario_id else None
    if s is None:
        raise HTTPException(409, "The scenario for this run no longer exists.")
    b = db.get(Business, r.business_id)
    cfg = {k: v for k, v in r.config.items() if k in ("mode", "runs", "horizon_days", "seed", "start_date", "shocks", "custom_shock")}
    new = queue_run(db, b, s, kind=r.kind, config_override=cfg, parent_run_id=r.parent_run_id, user=user)
    db.commit()
    submit_after_commit([new.id])
    return run_out(db, new, include_results=False)


class StressIn(BaseModel):
    shocks: list[str] = Field(default_factory=list)
    custom: dict = Field(default_factory=dict)
    runs: int = 300


@router.post("/runs/{run_id}/stress")
def stress_run(run_id: int, data: StressIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = owned(db, user, SimulationRun, run_id)
    if r.kind != "scenario":
        raise HTTPException(409, "Stress tests start from a scenario run.")
    s = db.get(Scenario, r.scenario_id) if r.scenario_id else None
    if s is None:
        raise HTTPException(409, "The scenario for this run no longer exists.")
    unknown = [k for k in data.shocks if k not in STRESS_SHOCKS]
    if unknown:
        raise HTTPException(422, f"Unknown stress condition(s): {', '.join(unknown)}.")
    if not data.shocks and not any(v not in (None, "", 0) for v in data.custom.values()):
        raise HTTPException(422, "Choose at least one stress condition.")
    b = db.get(Business, r.business_id)
    cfg = {"mode": "monte_carlo", "runs": min(1000, data.runs), "horizon_days": r.config.get("horizon_days", 90),
           "seed": r.config.get("seed"), "start_date": r.config.get("start_date"), "shocks": data.shocks, "custom_shock": data.custom}
    st = queue_run(db, b, s, kind="stress", config_override=cfg, parent_run_id=r.id, user=user)
    db.commit()
    submit_after_commit([st.id])
    return run_out(db, st, include_results=False)


@router.post("/runs/{run_id}/sensitivity")
def sensitivity_run(run_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = owned(db, user, SimulationRun, run_id)
    s = db.get(Scenario, r.scenario_id) if r.scenario_id else None
    if s is None:
        raise HTTPException(409, "The scenario for this run no longer exists.")
    b = db.get(Business, r.business_id)
    cfg = {"horizon_days": r.config.get("horizon_days", 90), "seed": r.config.get("seed"), "start_date": r.config.get("start_date")}
    sr = queue_run(db, b, s, kind="sensitivity", config_override=cfg, parent_run_id=r.id, user=user)
    db.commit()
    submit_after_commit([sr.id])
    return run_out(db, sr, include_results=False)


@router.get("/runs/{run_id}/vulnerabilities")
def vulnerabilities(run_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = owned(db, user, SimulationRun, run_id)
    if r.kind != "stress" or not r.results:
        raise HTTPException(409, "Vulnerabilities come from a completed stress test.")
    return {"agent": "Stress-Test", "mode": "deterministic", "vulnerabilities": stress_vulnerabilities(r.results)}


class CompareIn(BaseModel):
    run_ids: list[int] = Field(min_length=1, max_length=8)


@router.post("/businesses/{business_id}/compare")
def compare(business_id: int, data: CompareIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    runs = completed_runs(db, b, data.run_ids)
    cmp = compare_runs(runs)
    v = active_version(db, b)
    goals = {**v.spec.get("goals", {}), **default_criteria(v.spec)}
    analysis = decision_analyst(cmp, goals)
    audit(db, b.id, "agent:decision_analyst", "agent.compare", f"Compared runs {', '.join(map(str, data.run_ids))}.", {"mode": analysis["mode"]}, user.id)
    db.commit()
    stale = {r["id"]: run_out(db, db.get(SimulationRun, r["id"]), include_results=False)["outdated"] for r in runs}
    return {"comparison": cmp, "analysis": analysis, "outdated": stale}
