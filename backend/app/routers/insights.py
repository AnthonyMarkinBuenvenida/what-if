"""Reports, Failure Museum, Reality Feedback and the overview dashboard."""
from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import current_workspace
from ..db import get_db
from ..engine.analysis import calibrate_spec, compare_actuals
from ..models import (AuditEvent, Business, FailureRecord, FeedbackObservation, ModelVersion, Report, Scenario,
                      SimulationRun, Workspace)
from ..services import (DONE, active_version, audit, build_report, create_version, failure_from_run, owned,
                        owned_business, scenario_out)

router = APIRouter(prefix="/api", tags=["insights"])


# -------------------------------------------------------------------- reports

class ReportIn(BaseModel):
    run_ids: list[int] = Field(min_length=1, max_length=8)
    title: str | None = Field(None, max_length=200)


def _report_out(r: Report, full: bool = True) -> dict:
    out = {"id": r.id, "business_id": r.business_id, "title": r.title, "run_ids": r.run_ids,
           "model_version_ids": r.model_version_ids, "created_at": r.created_at.isoformat()}
    if full:
        out["content"] = r.content
    else:
        rec = (r.content or {}).get("recommendation", {})
        out["recommendation"] = rec.get("recommendation")
        out["is_demo"] = (r.content or {}).get("business", {}).get("is_demo", False)
    return out


@router.post("/businesses/{business_id}/reports")
def create_report(business_id: int, data: ReportIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    r = build_report(db, b, data.run_ids, data.title)
    db.commit()
    return _report_out(r)


@router.get("/businesses/{business_id}/reports")
def list_reports(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    return [_report_out(r, False) for r in db.scalars(select(Report).where(Report.business_id == b.id).order_by(Report.id.desc()))]


@router.get("/reports/{report_id}")
def get_report(report_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    return _report_out(owned(db, user, Report, report_id))


@router.get("/reports/{report_id}/csv")
def report_csv(report_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = owned(db, user, Report, report_id)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["report_id", r.id, "title", r.title, "model_version_ids", " ".join(map(str, r.model_version_ids))])
    w.writerow([])
    metrics = [("revenue", "Revenue"), ("gross_profit", "Gross profit"), ("operating_expenses", "Operating expenses"),
               ("operating_profit", "Operating profit"), ("avg_monthly_operating_profit", "Operating profit per month"),
               ("one_time_costs", "One-time costs"), ("ending_cash", "Ending cash"), ("min_cash", "Lowest cash"),
               ("fill_rate", "Share of demand served"), ("waste_rate", "Waste rate"), ("stockout_rate", "Stockout rate")]
    w.writerow(["scenario", "run_id", "model_version_id", "mode", "runs", "horizon_days", "metric", "mean", "p10", "p50", "p90"])
    for row in r.content["comparison"]["rows"]:
        for key, label in metrics:
            d = row[key]
            w.writerow([row["scenario_name"], row["run_id"], row["model_version_id"], row["mode"], row["runs"], row["horizon_days"],
                        label, round(d["mean"], 4), round(d["p10"], 4), round(d["p50"], 4), round(d["p90"], 4)])
        w.writerow([row["scenario_name"], row["run_id"], row["model_version_id"], row["mode"], row["runs"], row["horizon_days"],
                    "Probability cash below buffer", round(row["cash_below_buffer"], 4), "", "", ""])
    buf.seek(0)
    name = f"startup-report-{r.id}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ------------------------------------------------------------ Failure Museum

def _failure_out(db: Session, f: FailureRecord) -> dict:
    run = db.get(SimulationRun, f.run_id)
    return {"id": f.id, "business_id": f.business_id, "run_id": f.run_id, "scenario_id": f.scenario_id, "title": f.title,
            "category": f.category, "tested": f.tested, "reasons": f.reasons, "limits_exceeded": f.limits_exceeded,
            "contributing_assumptions": f.contributing_assumptions, "lessons": f.lessons, "next_changes": f.next_changes,
            "created_at": f.created_at.isoformat(), "model_version_id": run.model_version_id if run else None,
            "color_index": run.color_index if run else 0,
            "headline": {"avg_monthly_operating_profit": run.results["summary"]["avg_monthly_operating_profit"],
                         "min_cash_p10": run.results["summary"]["min_cash"]["p10"]} if run and run.results else None}


@router.get("/businesses/{business_id}/failures")
def list_failures(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    recorded = [_failure_out(db, f) for f in db.scalars(select(FailureRecord).where(FailureRecord.business_id == b.id).order_by(FailureRecord.id.desc()))]
    recorded_runs = {f["run_id"] for f in recorded}
    # Completed runs that broke a limit but are not yet in the museum.
    candidates = []
    for r in db.scalars(select(SimulationRun).where(SimulationRun.business_id == b.id, SimulationRun.kind == "scenario",
                                                    SimulationRun.outcome == "failed_constraints").order_by(SimulationRun.id.desc()).limit(40)):
        if r.id not in recorded_runs:
            candidates.append({"run_id": r.id, "scenario_name": r.scenario_name, "color_index": r.color_index,
                               "violations": [c["label"] for c in r.results["constraints"] if c["violated"]],
                               "finished_at": r.finished_at.isoformat() if r.finished_at else None})
    return {"records": recorded, "candidates": candidates}


class FailureIn(BaseModel):
    run_id: int
    lessons: str = Field("", max_length=4000)
    rejected_reason: str = Field("", max_length=2000)


@router.post("/businesses/{business_id}/failures")
def create_failure(business_id: int, data: FailureIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    run = owned(db, user, SimulationRun, data.run_id)
    if run.business_id != b.id:
        raise HTTPException(404, "Run not found.")
    if db.scalar(select(FailureRecord).where(FailureRecord.run_id == run.id)):
        raise HTTPException(409, "This run is already in the Failure Museum.")
    f = failure_from_run(db, run, data.lessons, data.rejected_reason)
    db.commit()
    return _failure_out(db, f)


class FailurePatch(BaseModel):
    lessons: str | None = Field(None, max_length=4000)
    next_changes: str | None = Field(None, max_length=4000)


@router.patch("/failures/{failure_id}")
def patch_failure(failure_id: int, data: FailurePatch, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    f = owned(db, user, FailureRecord, failure_id)
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(f, k, v)
    db.commit()
    return _failure_out(db, f)


@router.delete("/failures/{failure_id}")
def delete_failure(failure_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    f = owned(db, user, FailureRecord, failure_id)
    db.delete(f)
    db.commit()
    return {"ok": True}


@router.post("/failures/{failure_id}/revise")
def revise_failure(failure_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Start a new experiment from a failed one: a copy of its scenario to modify and rerun."""
    f = owned(db, user, FailureRecord, failure_id)
    s = db.get(Scenario, f.scenario_id) if f.scenario_id else None
    if s is None:
        run = db.get(SimulationRun, f.run_id)
        levers, name, kind = (run.levers if run else {}), f.title, "custom"
        assumptions, cfg, crit, desc, decision = [], (run.config if run else {}), {}, "", ""
    else:
        levers, name, kind = dict(s.levers), s.name, s.kind
        assumptions, cfg, crit, desc, decision = list(s.assumptions), dict(s.config), dict(s.success_criteria), s.description, s.decision
    count = len(db.scalars(select(Scenario.id).where(Scenario.business_id == f.business_id)).all())
    n = Scenario(business_id=f.business_id, name=f"{name} (revised)"[:120], description=desc, decision=decision,
                 kind="custom" if kind == "baseline" else kind, color_index=count % 8, levers=levers, assumptions=assumptions,
                 config={k: v for k, v in cfg.items() if k in ("mode", "runs", "horizon_days")}, success_criteria=crit,
                 origin=f"revision of failure #{f.id}")
    db.add(n)
    db.flush()
    audit(db, f.business_id, "user", "failure.revised", f"New experiment '{n.name}' created from failure #{f.id}.", {"scenario_id": n.id}, user.id)
    db.commit()
    return scenario_out(db, n)


# ----------------------------------------------------------- Reality Feedback

class FeedbackIn(BaseModel):
    run_id: int
    period_start: date
    period_end: date
    revenue: float | None = Field(None, ge=0)
    costs: float | None = Field(None, ge=0)
    units_sold: float | None = Field(None, ge=0)
    notes: str = Field("", max_length=4000)


def _feedback_out(db: Session, o: FeedbackObservation) -> dict:
    run = db.get(SimulationRun, o.run_id)
    return {"id": o.id, "run_id": o.run_id, "scenario_name": run.scenario_name if run else None,
            "model_version_id": run.model_version_id if run else None, "color_index": run.color_index if run else 0,
            "period_start": o.period_start.isoformat(), "period_end": o.period_end.isoformat(), "actual": o.actual,
            "comparison": o.comparison, "notes": o.notes, "calibration_status": o.calibration_status,
            "applied_version_id": o.applied_version_id, "created_at": o.created_at.isoformat()}


@router.get("/businesses/{business_id}/feedback")
def list_feedback(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    return [_feedback_out(db, o) for o in db.scalars(select(FeedbackObservation).where(FeedbackObservation.business_id == b.id).order_by(FeedbackObservation.id.desc()))]


@router.post("/businesses/{business_id}/feedback")
def create_feedback(business_id: int, data: FeedbackIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    run = owned(db, user, SimulationRun, data.run_id)
    if run.business_id != b.id or run.kind != "scenario" or run.status not in DONE:
        raise HTTPException(409, "Choose a completed scenario run to compare against.")
    if data.revenue is None and data.costs is None and data.units_sold is None:
        raise HTTPException(422, "Enter at least one actual figure (revenue, costs or units sold).")
    sim_start = date.fromisoformat(run.config.get("start_date") or run.created_at.date().isoformat())
    actual = {k: getattr(data, k) for k in ("revenue", "costs", "units_sold") if getattr(data, k) is not None}
    try:
        comparison = compare_actuals({"results": run.results}, data.period_start, data.period_end, sim_start, actual)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    comparison["simulation_start"] = sim_start.isoformat()
    scale = comparison.get("demand_scale_suggestion")
    status = "pending" if scale is not None and abs(scale - 1) > 0.05 else "not_applicable"
    o = FeedbackObservation(business_id=b.id, run_id=run.id, period_start=data.period_start, period_end=data.period_end,
                            actual=actual, comparison=comparison, notes=data.notes, calibration_status=status)
    db.add(o)
    db.flush()
    audit(db, b.id, "user", "feedback.recorded", f"Actual results recorded for {data.period_start}–{data.period_end} against run #{run.id}.", {"feedback_id": o.id}, user.id)
    db.commit()
    return _feedback_out(db, o)


@router.post("/feedback/{feedback_id}/apply")
def apply_feedback(feedback_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Workspace-approved calibration: creates a new model version; earlier versions and reports are untouched."""
    o = owned(db, user, FeedbackObservation, feedback_id)
    if o.calibration_status != "pending":
        raise HTTPException(409, "There is no pending calibration for this observation.")
    b = db.get(Business, o.business_id)
    v = active_version(db, b)
    scale = float(o.comparison["demand_scale_suggestion"])
    new_spec, changes = calibrate_spec(v.spec, scale, f"Feedback #{o.id} ({o.period_start}–{o.period_end})")
    nv = create_version(db, b, new_spec, f"Calibrated demand ×{scale:.3f} from actual results (feedback #{o.id}).", "calibration")
    o.calibration_status, o.applied_version_id = "applied", nv.id
    db.commit()
    return {"feedback": _feedback_out(db, o), "new_version": {"id": nv.id, "version": nv.version}, "changes": changes}


@router.post("/feedback/{feedback_id}/dismiss")
def dismiss_feedback(feedback_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    o = owned(db, user, FeedbackObservation, feedback_id)
    if o.calibration_status == "pending":
        o.calibration_status = "dismissed"
    db.commit()
    return _feedback_out(db, o)


# ------------------------------------------------------------------ dashboard

@router.get("/dashboard")
def dashboard(user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    businesses = db.scalars(select(Business).where(Business.user_id == user.id).order_by(Business.updated_at.desc())).all()
    ids = [b.id for b in businesses]
    if not ids:
        return {"businesses": [], "totals": {"businesses": 0, "scenarios_tested": 0, "completed_runs": 0, "reports": 0,
                                             "open_data_issues": 0, "active_runs": 0}, "recent_runs": [], "feedback": [], "activity": []}
    completed = db.scalar(select(func.count()).select_from(SimulationRun).where(SimulationRun.business_id.in_(ids), SimulationRun.status.in_(DONE))) or 0
    tested = db.scalar(select(func.count(func.distinct(SimulationRun.scenario_id))).where(SimulationRun.business_id.in_(ids), SimulationRun.status.in_(DONE), SimulationRun.kind == "scenario")) or 0
    active = db.scalar(select(func.count()).select_from(SimulationRun).where(SimulationRun.business_id.in_(ids), SimulationRun.status.in_(("queued", "preparing", "running")))) or 0
    reports = db.scalar(select(func.count()).select_from(Report).where(Report.business_id.in_(ids))) or 0
    issues = []
    for b in businesses:
        v = db.get(ModelVersion, b.active_model_version_id) if b.active_model_version_id else None
        if v:
            for i in v.validation.get("issues", []):
                if i["severity"] in ("error", "warning"):
                    issues.append({"business_id": b.id, "business_name": b.name, "is_demo": b.is_demo, **i})
    recent = db.scalars(select(SimulationRun).where(SimulationRun.business_id.in_(ids)).order_by(SimulationRun.id.desc()).limit(8)).all()
    names = {b.id: b.name for b in businesses}
    demo = {b.id: b.is_demo for b in businesses}
    feedback = db.scalars(select(FeedbackObservation).where(FeedbackObservation.business_id.in_(ids)).order_by(FeedbackObservation.id.desc()).limit(5)).all()
    activity = db.scalars(select(AuditEvent).where(AuditEvent.business_id.in_(ids)).order_by(AuditEvent.id.desc()).limit(12)).all()
    from ..services import business_out
    return {
        "businesses": [business_out(db, b) for b in businesses[:6]],
        "totals": {"businesses": len(businesses), "scenarios_tested": tested, "completed_runs": completed, "reports": reports,
                   "open_data_issues": len(issues), "active_runs": active},
        "data_issues": issues[:8],
        "recent_runs": [{"id": r.id, "business_id": r.business_id, "business_name": names.get(r.business_id), "is_demo": demo.get(r.business_id),
                         "scenario_name": r.scenario_name, "kind": r.kind, "status": r.status, "progress": r.progress, "outcome": r.outcome,
                         "color_index": r.color_index, "created_at": r.created_at.isoformat(),
                         "monthly_profit_p50": r.results["summary"]["avg_monthly_operating_profit"]["p50"] if r.results and r.kind == "scenario" else None}
                        for r in recent],
        "feedback": [_feedback_out(db, o) | {"business_name": names.get(o.business_id)} for o in feedback],
        "activity": [{"id": e.id, "business_id": e.business_id, "business_name": names.get(e.business_id), "actor": e.actor,
                      "action": e.action, "summary": e.summary, "created_at": e.created_at.isoformat()} for e in activity],
    }
