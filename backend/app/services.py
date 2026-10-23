"""Shared business logic used by the API routers."""
from __future__ import annotations

from datetime import date

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .agents.workflow import data_analyst, decision_analyst
from .domain.retail import normalize_spec, provenance_counts, validate_spec
from .domain.worlds import world_templates
from .engine.analysis import compare_runs, run_sensitivity
from .engine.simulation import ENGINE_VERSION, default_criteria, levers_hash, merge_config
from .jobs import jobs
from .models import (AuditEvent, Business, DataSource, FailureRecord, ModelVersion, Report, Scenario,
                     SimulationRun, Workspace)

ACTIVE = ("queued", "preparing", "running")
DONE = ("completed", "completed_with_warnings")


def audit(db: Session, business_id: int | None, actor: str, action: str, summary: str, detail: dict | None = None,
          user_id: int | None = None) -> None:
    db.add(AuditEvent(business_id=business_id, user_id=user_id, actor=actor, action=action, summary=summary, detail=detail or {}))


def owned_business(db: Session, user: Workspace, business_id: int) -> Business:
    b = db.get(Business, business_id)
    if b is None or b.user_id != user.id:
        raise HTTPException(404, "Business not found.")
    return b


def owned(db: Session, user: Workspace, model, obj_id: int):
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(404, "Not found.")
    owned_business(db, user, obj.business_id)
    return obj


def active_version(db: Session, b: Business) -> ModelVersion:
    v = db.get(ModelVersion, b.active_model_version_id) if b.active_model_version_id else None
    if v is None:
        raise HTTPException(409, "This business has no saved model yet. Save the digital twin first.")
    return v


def create_version(db: Session, b: Business, spec: dict, note: str, created_by: str) -> ModelVersion:
    spec = normalize_spec(spec)
    validation = validate_spec(spec, spec.get("sales_history_days"))
    last = db.scalar(select(func.max(ModelVersion.version)).where(ModelVersion.business_id == b.id)) or 0
    v = ModelVersion(business_id=b.id, version=last + 1, spec=spec, validation=validation,
                     calibration=validation["status"], change_note=note, created_by=created_by)
    db.add(v)
    db.flush()
    b.active_model_version_id = v.id
    audit(db, b.id, created_by if created_by.startswith("agent") else "user", "model.version_created",
          f"Model version {v.version} saved ({validation['status']}). {note}".strip(), {"version_id": v.id})
    return v


def business_out(db: Session, b: Business) -> dict:
    v = db.get(ModelVersion, b.active_model_version_id) if b.active_model_version_id else None
    counts = dict(db.execute(select(SimulationRun.status, func.count()).where(SimulationRun.business_id == b.id)
                             .group_by(SimulationRun.status)).all())
    return {
        "id": b.id, "name": b.name, "industry": b.industry, "business_type": b.business_type,
        "description": b.description, "decision": b.decision, "creation_mode": b.creation_mode,
        "plan_status": b.plan_status, "is_demo": b.is_demo, "created_at": b.created_at.isoformat(),
        "active_model_version_id": b.active_model_version_id,
        "active_model": {"id": v.id, "version": v.version, "calibration": v.calibration, "counts": v.validation.get("counts", {})} if v else None,
        "scenario_count": db.scalar(select(func.count()).select_from(Scenario).where(Scenario.business_id == b.id, Scenario.archived.is_(False))) or 0,
        "run_counts": counts,
        "active_runs": sum(counts.get(s, 0) for s in ACTIVE),
    }


def version_out(v: ModelVersion, with_spec: bool = True) -> dict:
    out = {"id": v.id, "business_id": v.business_id, "version": v.version, "calibration": v.calibration,
           "validation": v.validation, "change_note": v.change_note, "created_by": v.created_by,
           "created_at": v.created_at.isoformat(), "provenance_counts": provenance_counts(v.spec)}
    if with_spec:
        out["spec"] = v.spec
    return out


def scenario_hash(s: Scenario) -> str:
    return levers_hash(s.levers, s.config, s.success_criteria)


def scenario_out(db: Session, s: Scenario) -> dict:
    latest = db.scalar(select(SimulationRun).where(SimulationRun.scenario_id == s.id, SimulationRun.kind == "scenario")
                       .order_by(SimulationRun.id.desc()).limit(1))
    return {
        "id": s.id, "business_id": s.business_id, "name": s.name, "description": s.description, "decision": s.decision,
        "kind": s.kind, "color_index": s.color_index, "is_baseline": s.is_baseline,
        "base_model_version_id": s.base_model_version_id, "levers": s.levers, "assumptions": s.assumptions,
        "config": merge_config(s.config), "success_criteria": s.success_criteria, "origin": s.origin,
        "created_at": s.created_at.isoformat(), "updated_at": s.updated_at.isoformat(),
        "latest_run": run_out(db, latest, include_results=False) if latest else None,
    }


def run_out(db: Session, r: SimulationRun, include_results: bool = True) -> dict:
    stale = []
    if r.scenario_id:
        s = db.get(Scenario, r.scenario_id)
        if s and r.kind == "scenario" and scenario_hash(s) != r.levers_hash:
            stale.append("The scenario's assumptions changed after this run. Rerun to update the results.")
    b = db.get(Business, r.business_id)
    if b and b.active_model_version_id and r.model_version_id != b.active_model_version_id:
        v = db.get(ModelVersion, r.model_version_id)
        stale.append(f"Based on model version {v.version if v else '?'}; a newer model version exists.")
    v = db.get(ModelVersion, r.model_version_id)
    out = {
        "id": r.id, "business_id": r.business_id, "scenario_id": r.scenario_id, "scenario_name": r.scenario_name,
        "color_index": r.color_index, "kind": r.kind, "parent_run_id": r.parent_run_id,
        "model_version_id": r.model_version_id, "model_version": v.version if v else None,
        "status": r.status, "progress": r.progress, "stage": r.stage, "config": r.config, "levers": r.levers,
        "criteria": r.criteria, "inputs": r.inputs, "warnings": r.warnings, "error": r.error, "outcome": r.outcome,
        "created_at": r.created_at.isoformat(),
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "outdated": stale,
    }
    if r.results and r.kind == "scenario":
        S = r.results["summary"]
        out["headline"] = {
            "avg_monthly_operating_profit": S["avg_monthly_operating_profit"], "revenue": S["revenue"]["mean"],
            "min_cash_p10": S["min_cash"]["p10"], "fill_rate": S["fill_rate"]["mean"], "waste_rate": S["waste_rate"]["mean"],
            "cash_below_buffer": r.results["probabilities"]["cash_below_buffer"],
        }
    if include_results:
        out["results"] = r.results
    return out


def queue_run(db: Session, b: Business, s: Scenario, kind: str = "scenario", config_override: dict | None = None,
              parent_run_id: int | None = None, user: Workspace | None = None) -> SimulationRun:
    version_id = s.base_model_version_id or b.active_model_version_id
    if not version_id:
        raise HTTPException(409, "Save the digital twin before running simulations.")
    v = db.get(ModelVersion, version_id)
    if v.calibration == "invalid":
        raise HTTPException(422, "The model has errors. Fix them in the Digital Twin Builder before simulating.")
    cfg = merge_config({**(s.config or {}), **(config_override or {})})
    cfg["start_date"] = (config_override or {}).get("start_date") or (s.config or {}).get("start_date") or date.today().isoformat()
    for k in ("shocks", "custom_shock"):
        if config_override and k in config_override:
            cfg[k] = config_override[k]
    # Scenario-specific success criteria override the business goals key by key.
    criteria = {**default_criteria(v.spec), **(s.success_criteria or {})}
    run = SimulationRun(business_id=b.id, scenario_id=s.id, model_version_id=v.id, kind=kind, parent_run_id=parent_run_id,
                        scenario_name=s.name, color_index=s.color_index, status="queued", stage="Waiting for a worker",
                        config=cfg, levers=s.levers, levers_hash=scenario_hash(s), criteria=criteria)
    db.add(run)
    db.flush()
    audit(db, b.id, "user", "run.queued", f"{kind.title()} run #{run.id} queued for '{s.name}' on model v{v.version} ({cfg['mode']}, {cfg['runs']} runs, {cfg['horizon_days']} days).",
          {"run_id": run.id, "engine": ENGINE_VERSION}, user.id if user else None)
    return run


def submit_after_commit(run_ids: list[int]) -> None:
    for rid in run_ids:
        jobs.submit(rid)


def create_standard_worlds(db: Session, b: Business, kinds: list[str] | None = None, origin: str = "template") -> list[Scenario]:
    v = active_version(db, b)
    existing = db.scalar(select(func.count()).select_from(Scenario).where(Scenario.business_id == b.id)) or 0
    out = []
    for i, w in enumerate(world_templates([p["id"] for p in v.spec.get("products", [])])):
        if kinds and w["kind"] not in kinds:
            continue
        s = Scenario(business_id=b.id, name=w["name"], description=w["description"], decision=w["decision"], kind=w["kind"],
                     color_index=(existing + len(out)) % 8, is_baseline=w["kind"] == "baseline", levers=w["levers"],
                     assumptions=w["assumptions"], config={"mode": "monte_carlo", "runs": 400, "horizon_days": 90},
                     success_criteria={}, origin=origin)
        db.add(s)
        out.append(s)
    db.flush()
    return out


def completed_runs(db: Session, b: Business, run_ids: list[int]) -> list[dict]:
    runs = []
    for rid in run_ids:
        r = db.get(SimulationRun, rid)
        if r is None or r.business_id != b.id:
            raise HTTPException(404, f"Run {rid} not found.")
        if r.status not in DONE or r.kind != "scenario":
            raise HTTPException(409, f"Run {rid} has not completed; only completed scenario runs can be compared.")
        runs.append({"id": r.id, "scenario_name": r.scenario_name, "color_index": r.color_index,
                     "model_version_id": r.model_version_id, "results": r.results, "scenario_id": r.scenario_id})
    # Put the baseline first so differences are measured against it.
    def is_base(x):
        s = db.get(Scenario, x["scenario_id"]) if x["scenario_id"] else None
        return 0 if (s and s.is_baseline) else 1
    runs.sort(key=is_base)
    return runs


LIMITATIONS = [
    "Results are simulations under the stated assumptions, not forecasts or guarantees.",
    "The retail model has no seasonality, promotions, competitor reactions or long-term customer growth.",
    "Demand estimates from sales history understate true demand on days a product was out of stock.",
    "Purchase cost of goods sold uses the current supplier price; it does not track older cost layers.",
    "Taxes, loan repayments and owner's pay are excluded unless entered as expenses.",
]


def build_report(db: Session, b: Business, run_ids: list[int], title: str | None) -> Report:
    runs = completed_runs(db, b, run_ids)
    cmp = compare_runs(runs)
    first_version = db.get(ModelVersion, runs[0]["model_version_id"])
    spec = first_version.spec
    goals = {**spec.get("goals", {}), **default_criteria(spec)}
    analyst = data_analyst(spec, [{"filename": d.filename, "report": d.report} for d in
                                  db.scalars(select(DataSource).where(DataSource.business_id == b.id, DataSource.status == "applied"))])
    decision = decision_analyst(cmp, goals)
    rec_run = next((r for r in runs if r["id"] == decision["output"].get("recommended_run_id")), runs[0])
    rec_run_db = db.get(SimulationRun, rec_run["id"])
    sens = run_sensitivity(db.get(ModelVersion, rec_run["model_version_id"]).spec, rec_run_db.levers, rec_run_db.config, rec_run_db.criteria)

    scenarios = []
    for r in runs:
        s = db.get(Scenario, r["scenario_id"]) if r["scenario_id"] else None
        run_db = db.get(SimulationRun, r["id"])
        scenarios.append({
            "run_id": r["id"], "name": r["scenario_name"], "color_index": r["color_index"],
            "description": s.description if s else "", "decision": s.decision if s else "",
            "assumptions": s.assumptions if s else [], "applied_changes": r["results"]["applied_changes"],
            "constraints": r["results"]["constraints"], "outcome": r["results"]["outcome"],
            "warnings": run_db.warnings, "config": r["results"]["config"],
        })
    versions = sorted({r["model_version_id"] for r in runs})
    version_info = []
    for vid in versions:
        v = db.get(ModelVersion, vid)
        version_info.append({"id": v.id, "version": v.version, "calibration": v.calibration,
                             "provenance_counts": provenance_counts(v.spec), "default_share": v.validation.get("default_share"),
                             "issues": [i for i in v.validation.get("issues", []) if i["severity"] != "info"]})
    sources = [{"filename": d.filename, "kind": d.kind, "rows": d.row_count, "uploaded_at": d.uploaded_at.isoformat()}
               for d in db.scalars(select(DataSource).where(DataSource.business_id == b.id, DataSource.status == "applied"))]
    outcomes = []
    for row in cmp["rows"]:
        mp = row["avg_monthly_operating_profit"]
        outcomes.append({"name": row["scenario_name"], "mode": row["mode"],
                         "adverse": mp["p10"], "expected": mp["mean"], "best": mp["p90"],
                         "cash_adverse": row["min_cash"]["p10"], "supported": row["mode"] == "monte_carlo"})
    confidence = []
    if any(v["calibration"] != "calibrated" for v in version_info):
        confidence.append("Exploratory: the model still contains warnings or What-if default values (see Data sources and model version).")
    if not cmp["comparable"]:
        confidence.append("Scenarios were run with different horizons or modes; compare with care.")
    if not cmp["same_model_version"]:
        confidence.append("Scenarios come from different model versions.")
    content = {
        "business": {"name": b.name, "type": b.business_type, "description": b.description, "is_demo": b.is_demo,
                     "facts": analyst["output"]["facts"], "findings": analyst["output"]["findings"]},
        "decision": b.decision or (scenarios[1]["decision"] if len(scenarios) > 1 else scenarios[0]["decision"]),
        "data": {"sources": sources, "model_versions": version_info, "engine_version": ENGINE_VERSION},
        "assumptions": {"accounting": [
            "Revenue = units sold × selling price + delivery fees.",
            "Gross profit = revenue − cost of goods sold − expired stock written off.",
            "Operating profit = gross profit − labor − recurring expenses − delivery costs (accrued daily).",
            "One-time costs (investments, setup, unexpected bills) reduce cash and are reported separately.",
            "Suppliers are paid when an order is placed; recurring bills are paid on their due dates.",
        ], "goals": goals, "uncertainty": spec.get("uncertainty", {})},
        "scenarios": scenarios,
        "comparison": cmp,
        "outcomes": outcomes,
        "risks": decision["output"].get("risks", []),
        "sensitivity": {"scenario": rec_run["scenario_name"], **sens},
        "recommendation": decision["output"],
        "agent_notes": {"decision_analyst": {"mode": decision["mode"], "model": decision["model"], "notes": decision["notes"]}},
        "limitations": LIMITATIONS,
        "confidence": confidence or ["Model marked calibrated: all values come from your data and no validation warnings remain."],
    }
    report = Report(business_id=b.id, title=title or f"{b.name}: {len(runs)} scenarios compared", run_ids=[r["id"] for r in runs],
                    model_version_ids=versions, content=content)
    db.add(report)
    db.flush()
    audit(db, b.id, "agent:decision_analyst", "report.created", f"Report #{report.id} created from runs {', '.join(str(r['id']) for r in runs)}.",
          {"report_id": report.id, "analysis_mode": decision["mode"]})
    return report


NEXT_CHANGES = {
    "cash_floor": "Keep more cash in reserve, stage one-time spending, or reduce order sizes so less cash is tied up in stock.",
    "profit_target": "Test a combination with price or cost changes, or check whether the profit target is realistic for this model.",
    "waste": "Order perishables in smaller, more frequent batches or shorten the reorder cycle.",
    "fill_rate": "Add staff hours or raise reorder points so demand is not turned away.",
    "budget": "Reduce the one-time investment or phase it over a longer period.",
}


def failure_from_run(db: Session, run: SimulationRun, lessons: str = "", rejected_reason: str = "") -> FailureRecord:
    if run.kind != "scenario" or not run.results:
        raise HTTPException(409, "Only completed scenario runs can be added to the Failure Museum.")
    violated = [c for c in run.results["constraints"] if c["violated"]]
    if not violated and not rejected_reason.strip():
        raise HTTPException(422, "This run did not break any defined limit. To keep it as a rejected experiment, give the reason you rejected it.")
    s = db.get(Scenario, run.scenario_id) if run.scenario_id else None
    rec = FailureRecord(
        business_id=run.business_id, run_id=run.id, scenario_id=run.scenario_id,
        title=f"{run.scenario_name} (run #{run.id})", category="failed" if violated else "rejected",
        tested=(s.decision if s else run.scenario_name) + ". Changes: " + ("; ".join(run.results["applied_changes"]) or "none (baseline)"),
        reasons=[f"{c['label']}: {c['value']} (limit {c['limit']})" for c in violated] or [f"Rejected by user: {rejected_reason.strip()}"],
        limits_exceeded=violated,
        contributing_assumptions=(s.assumptions if s else []) + run.results["applied_changes"],
        lessons=lessons, next_changes=" ".join(NEXT_CHANGES[c["key"]] for c in violated if c["key"] in NEXT_CHANGES),
    )
    db.add(rec)
    db.flush()
    audit(db, run.business_id, "user", "failure.recorded", f"'{rec.title}' added to the Failure Museum ({rec.category}).", {"failure_id": rec.id})
    return rec
