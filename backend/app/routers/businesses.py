"""Businesses, digital-twin model versions, data imports and agent steps."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..agents.workflow import GUIDED_FACTS, build_plan, data_analyst, digital_twin_agent, scenario_designer, stress_test_agent
from ..auth import current_workspace
from ..config import settings
from ..db import get_db
from ..domain.retail import VARIABLE_GUIDE, normalize_spec, validate_spec
from ..importers import ImportErrorWithReport, apply_import_to_spec, parse_import
from ..models import AuditEvent, Business, DataSource, ModelVersion, Scenario, Workspace
from ..services import (active_version, audit, business_out, create_standard_worlds, create_version, owned,
                        owned_business, queue_run, submit_after_commit, version_out)

router = APIRouter(prefix="/api", tags=["businesses"])
INDUSTRIES = [
    {"id": "retail", "label": "Retail", "available": True, "types": ["grocery", "convenience", "bakery", "pharmacy", "boutique", "hardware", "general retail"]},
    {"id": "services", "label": "Service businesses", "available": False, "types": []},
    {"id": "food_service", "label": "Restaurants & cafés", "available": False, "types": []},
]


@router.get("/industries")
def industries():
    return {"industries": INDUSTRIES, "variables": VARIABLE_GUIDE}


class BusinessIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    business_type: str = Field("grocery", max_length=80)
    industry: str = "retail"
    description: str = Field("", max_length=6000)
    mode: str = Field("build", pattern="^(build|plan)$")
    guided: dict = Field(default_factory=dict)


@router.get("/businesses")
def list_businesses(user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    rows = db.scalars(select(Business).where(Business.user_id == user.id).order_by(Business.updated_at.desc())).all()
    return [business_out(db, b) for b in rows]


@router.post("/businesses")
def create_business(data: BusinessIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Build mode: model + standard worlds ready to run. Plan mode: model + a plan to review first."""
    if data.industry != "retail":
        raise HTTPException(422, "Only retail businesses are supported in this version.")
    b = Business(user_id=user.id, name=data.name.strip(), business_type=data.business_type, industry=data.industry,
                 description=data.description, creation_mode=data.mode)
    db.add(b)
    db.flush()
    steps = []
    twin = digital_twin_agent(b.name, data.business_type, data.description, {k: v for k, v in data.guided.items() if k in GUIDED_FACTS})
    b.decision = twin["output"]["stated_facts"]["decision_summary"] if data.description else ""
    steps.append({"agent": "Digital Twin", "mode": twin["mode"], "notes": twin["notes"],
                  "summary": "Prepared the first model version from the retail template and the facts you stated."})
    audit(db, b.id, "agent:digital_twin", "agent.digital_twin", "Prepared model version 1.", {"mode": twin["mode"], "stated": twin["output"]["stated_facts"]}, user.id)
    v = create_version(db, b, twin["output"]["spec"], "Initial model from description and retail template.", "agent:digital_twin")
    analyst = data_analyst(v.spec)
    steps.append({"agent": "Data Analyst", "mode": analyst["mode"], "notes": analyst["notes"], "summary": f"Checked the model: {v.calibration}."})
    if data.mode == "plan":
        b.plan = build_plan(b.name, data.business_type, data.description, v.spec)
        b.plan_status = "draft"
        steps.append({"agent": "Scenario Designer", "mode": b.plan["modes"]["designer"], "notes": [],
                      "summary": f"Proposed {len(b.plan['proposed_scenarios'])} scenarios for review. Nothing runs until you approve the plan."})
    else:
        designer = scenario_designer(data.description, v.spec)
        for i, p in enumerate(designer["output"]["proposals"]):
            db.add(Scenario(business_id=b.id, name=p["name"], description=p["description"], decision=p["decision"], kind=p["kind"],
                            color_index=i % 8, is_baseline=p["kind"] == "baseline", levers=p["levers"], assumptions=p["assumptions"],
                            config={"mode": "monte_carlo", "runs": 400, "horizon_days": 90}, success_criteria={},
                            origin=f"agent:scenario_designer ({designer['mode']})"))
        steps.append({"agent": "Scenario Designer", "mode": designer["mode"], "notes": designer["notes"],
                      "summary": f"Created {len(designer['output']['proposals'])} parallel worlds, including a baseline and a stress test."})
        audit(db, b.id, "agent:scenario_designer", "agent.scenarios", f"Created {len(designer['output']['proposals'])} scenarios.", {"mode": designer["mode"]}, user.id)
    db.commit()
    return {"business": business_out(db, b), "steps": steps, "missing_information": twin["output"]["missing_information"]}


@router.post("/businesses/demo")
def create_demo(user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """A clearly labelled demo workspace with illustrative data, simulated by the real engine."""
    from ..demo import DEMO_NAME, demo_spec
    b = Business(user_id=user.id, name=f"{DEMO_NAME} (demo)", business_type="grocery", is_demo=True,
                 description="Demo workspace with fictional, illustrative data. Replace it with your own business to get meaningful results.",
                 decision="Reduce expired inventory and decide whether a delivery service would raise profit within a $15,000 budget.")
    db.add(b)
    db.flush()
    create_version(db, b, demo_spec(), "Demo model (illustrative sample data).", "system:demo")
    scenarios = create_standard_worlds(db, b, origin="demo template")
    runs = [queue_run(db, b, s, user=user) for s in scenarios]
    db.commit()
    submit_after_commit([r.id for r in runs])
    return business_out(db, b)


@router.get("/businesses/{business_id}")
def get_business(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    return business_out(db, b) | {"plan": b.plan}


class BusinessPatch(BaseModel):
    name: str | None = Field(None, max_length=160)
    description: str | None = Field(None, max_length=6000)
    decision: str | None = Field(None, max_length=2000)


@router.patch("/businesses/{business_id}")
def patch_business(business_id: int, data: BusinessPatch, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(b, k, v)
    db.commit()
    return business_out(db, b)


@router.delete("/businesses/{business_id}")
def delete_business(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    db.delete(b)
    db.commit()
    return {"ok": True}


class PlanApproval(BaseModel):
    scenario_indexes: list[int]


@router.post("/businesses/{business_id}/plan/approve")
def approve_plan(business_id: int, data: PlanApproval, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    if not b.plan or b.plan_status != "draft":
        raise HTTPException(409, "There is no draft plan to approve.")
    props = b.plan["proposed_scenarios"]
    chosen = [props[i] for i in data.scenario_indexes if 0 <= i < len(props)]
    if not chosen:
        raise HTTPException(422, "Keep at least one scenario.")
    for i, p in enumerate(chosen):
        db.add(Scenario(business_id=b.id, name=p["name"], description=p["description"], decision=p["decision"], kind=p["kind"],
                        color_index=i % 8, is_baseline=p["kind"] == "baseline", levers=p["levers"], assumptions=p["assumptions"],
                        config=b.plan.get("proposed_config", {}), success_criteria={}, origin="plan (approved)"))
    b.plan_status = "approved"
    audit(db, b.id, "user", "plan.approved", f"Plan approved with {len(chosen)} scenarios.", {}, user.id)
    db.commit()
    return business_out(db, b)


# ------------------------------------------------------------- model versions

@router.get("/businesses/{business_id}/models")
def list_versions(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    rows = db.scalars(select(ModelVersion).where(ModelVersion.business_id == b.id).order_by(ModelVersion.version.desc())).all()
    return [version_out(v, with_spec=False) | {"active": v.id == b.active_model_version_id} for v in rows]


@router.get("/models/{version_id}")
def get_version(version_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    v = owned(db, user, ModelVersion, version_id)
    return version_out(v)


class SpecIn(BaseModel):
    spec: dict
    change_note: str = Field("", max_length=1000)


@router.post("/models/validate")
def validate_model(data: SpecIn, user: Workspace = Depends(current_workspace)):
    spec = normalize_spec(data.spec)
    return validate_spec(spec, spec.get("sales_history_days"))


@router.post("/businesses/{business_id}/models")
def save_version(business_id: int, data: SpecIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    if data.spec.get("industry", "retail") != "retail":
        raise HTTPException(422, "Only retail models are supported.")
    v = create_version(db, b, data.spec, data.change_note or "Edited in the Digital Twin Builder.", "user")
    db.commit()
    return version_out(v) | {"active": True}


@router.post("/models/{version_id}/activate")
def activate_version(version_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    v = owned(db, user, ModelVersion, version_id)
    b = db.get(Business, v.business_id)
    b.active_model_version_id = v.id
    audit(db, b.id, "user", "model.activated", f"Model version {v.version} made active.", {}, user.id)
    db.commit()
    return business_out(db, b)


# ------------------------------------------------------------------- imports

@router.post("/businesses/{business_id}/imports")
async def upload_import(business_id: int, kind: str = Form(...), file: UploadFile = File(...),
                        user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    data = await file.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(413, f"The file is larger than {settings.max_upload_bytes // (1024 * 1024)} MB.")
    v = db.get(ModelVersion, b.active_model_version_id) if b.active_model_version_id else None
    try:
        parsed = parse_import(kind, file.filename or "upload", data, (v.spec.get("products") if v else []))
    except ImportErrorWithReport as exc:
        raise HTTPException(422, exc.message) from exc
    rep = parsed["report"]
    ds = DataSource(business_id=b.id, kind=kind, filename=(file.filename or "upload")[:255], row_count=rep.get("accepted_rows", 0),
                    report=rep, parsed=_jsonable(parsed["parsed"]), status="reviewed" if not rep.get("missing_columns") else "rejected")
    db.add(ds)
    audit(db, b.id, "agent:data_analyst", "import.reviewed", f"Reviewed {ds.filename}: {rep.get('accepted_rows', 0)} rows accepted, {rep.get('rejected_rows', 0)} rejected.", {"data_source_id": None}, user.id)
    db.commit()
    return _ds_out(ds)


def _jsonable(o):
    import datetime as dt
    if isinstance(o, dict):
        return {k: _jsonable(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_jsonable(v) for v in o]
    if isinstance(o, (dt.date, dt.datetime)):
        return o.isoformat()
    return o


def _ds_out(ds: DataSource) -> dict:
    return {"id": ds.id, "kind": ds.kind, "filename": ds.filename, "rows": ds.row_count, "status": ds.status,
            "report": ds.report, "preview": ds.parsed, "applied_version_id": ds.applied_version_id, "uploaded_at": ds.uploaded_at.isoformat()}


@router.get("/businesses/{business_id}/imports")
def list_imports(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    return [_ds_out(d) for d in db.scalars(select(DataSource).where(DataSource.business_id == b.id).order_by(DataSource.id.desc()))]


@router.post("/imports/{import_id}/apply")
def apply_import(import_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    ds = owned(db, user, DataSource, import_id)
    if ds.status != "reviewed":
        raise HTTPException(409, "This import has already been applied or was rejected.")
    b = db.get(Business, ds.business_id)
    v = active_version(db, b)
    new_spec, changes = apply_import_to_spec(v.spec, ds.kind, ds.parsed)
    nv = create_version(db, b, new_spec, f"Applied {ds.kind} import '{ds.filename}' ({len(changes)} changes).", "user")
    ds.status, ds.applied_version_id = "applied", nv.id
    db.commit()
    return {"version": version_out(nv), "changes": changes}


@router.post("/imports/{import_id}/reject")
def reject_import(import_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    ds = owned(db, user, DataSource, import_id)
    ds.status = "rejected"
    db.commit()
    return _ds_out(ds)


# --------------------------------------------------------------- agent steps

@router.get("/businesses/{business_id}/agents/analysis")
def agent_analysis(business_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    v = active_version(db, b)
    sources = [{"filename": d.filename, "report": d.report} for d in db.scalars(select(DataSource).where(DataSource.business_id == b.id))]
    return data_analyst(v.spec, sources)


class SuggestIn(BaseModel):
    decision: str = Field("", max_length=4000)


@router.post("/businesses/{business_id}/agents/suggest-scenarios")
def suggest(business_id: int, data: SuggestIn, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    v = active_version(db, b)
    out = scenario_designer(data.decision or b.decision or b.description, v.spec)
    audit(db, b.id, "agent:scenario_designer", "agent.suggestions", f"Suggested {len(out['output']['proposals'])} scenarios (not created).", {"mode": out["mode"]}, user.id)
    db.commit()
    return out


@router.get("/businesses/{business_id}/agents/stress-suggestions")
def stress_suggestions(business_id: int, scenario_id: int, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    s = owned(db, user, Scenario, scenario_id)
    v = active_version(db, b)
    return stress_test_agent(v.spec, s.kind, s.levers)


@router.get("/businesses/{business_id}/audit")
def audit_log(business_id: int, limit: int = 100, user: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, user, business_id)
    rows = db.scalars(select(AuditEvent).where(AuditEvent.business_id == b.id).order_by(AuditEvent.id.desc()).limit(min(500, limit)))
    return [{"id": e.id, "actor": e.actor, "action": e.action, "summary": e.summary, "detail": e.detail, "created_at": e.created_at.isoformat()} for e in rows]
