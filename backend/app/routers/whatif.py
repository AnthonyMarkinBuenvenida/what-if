"""What-if API: business setup, simulation, Risk Radar, comparison, reports, signals.

Every route is scoped to the browser's workspace (see app/auth.py). Numbers
come from app/whatif/engine.py and app/whatif/risk.py; AI is used only to
interpret questions and explain results (app/whatif/ai.py).
"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..agents.llm import llm
from ..auth import current_workspace
from ..db import db_health, get_db
from ..models import Business, ModelVersion, WhatIfProfile, WhatIfReport, WhatIfRiskAssessment, WhatIfScenario, WhatIfSignal, Workspace
from ..services import audit, business_out, owned_business
from ..sources import open_meteo
from ..sources.base import SourceError
from ..whatif import advisor, ai, engine, risk, service, signals
from ..whatif.industries import INDUSTRIES, public_catalog, template
from ..whatif.schemas import INDUSTRIES as INDUSTRY_IDS, OBJECTIVES, Levers

router = APIRouter(prefix="/api/whatif", tags=["whatif"])


def _owned_scenario(db: Session, ws: Workspace, sid: int) -> tuple[WhatIfScenario, Business]:
    s = db.get(WhatIfScenario, sid)
    if s is None:
        raise HTTPException(404, "Scenario not found.")
    return s, owned_business(db, ws, s.business_id)


# ------------------------------------------------------------- reference

@router.get("/industries")
def industries():
    return {"industries": public_catalog(), "objectives": OBJECTIVES, "risk_rules": risk.rules_catalog(),
            "engine": engine.ENGINE_VERSION, "simplifications": engine.SIMPLIFICATIONS, "disclaimer": service.DISCLAIMER}


@router.get("/templates/{industry}")
def industry_template(industry: str, name: str = "My business", currency: str = "USD", country: str = ""):
    if industry not in INDUSTRIES:
        raise HTTPException(404, "Unknown industry.")
    return {"spec": template(industry, name, currency.upper()[:3], country.upper()[:2])}


@router.get("/status")
def status():
    """What is connected. Never includes keys or private URLs."""
    from ..sources import CONNECTORS
    return {
        "ai": llm.status(),
        "sources": {k: CONNECTORS[k].describe() for k in ("open_meteo", "world_bank", "frankfurter")},
        "weather_provider": signals.weather_provider(), "terms": signals.TERMS, "data_rules": signals.rules_catalog(),
        "monitoring": "Signals are refreshed when you open or refresh them. There is no background monitoring service.",
    }


@router.get("/geocode")
def geocode(q: str, country: str | None = None):
    try:
        return open_meteo.geocode(q, country)
    except SourceError as exc:
        raise HTTPException(502 if exc.kind != "invalid_request" else 422, exc.message) from exc


# ------------------------------------------------------------- businesses

class NewBusiness(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    industry: str
    currency: str = Field("USD", min_length=3, max_length=3)
    country: str = Field("", max_length=2)
    business_type: str = Field("", max_length=80)


@router.post("/businesses")
def create_business(data: NewBusiness, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    if data.industry not in INDUSTRY_IDS:
        raise HTTPException(422, f"Unknown industry. Choose one of: {', '.join(INDUSTRY_IDS)}.")
    b = Business(user_id=ws.id, name=data.name.strip(), industry=data.industry, creation_mode="whatif",
                 business_type=data.business_type or INDUSTRIES[data.industry]["examples"].split(",")[0])
    db.add(b)
    db.flush()
    spec = template(data.industry, b.name, data.currency.upper(), data.country.upper())
    if data.business_type:
        spec["business"]["business_type"] = data.business_type
    row = service.save_profile(db, b, spec, "Starting profile from the industry template (estimates).", "template")
    audit(db, b.id, "user", "whatif.business_created", f"Created {b.name} ({INDUSTRIES[data.industry]['label']}).", {}, ws.id)
    db.commit()
    return {"business": business_out(db, b), "profile": service.profile_out(row)}


@router.post("/demo")
def create_demo(ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """A clearly labelled demo business with fictional data, calculated by the real engine."""
    existing = db.scalars(select(Business).where(Business.user_id == ws.id, Business.is_demo.is_(True), Business.creation_mode == "whatif")).first()
    if existing:
        return {"business": business_out(db, existing), "created": False}
    b = Business(user_id=ws.id, name=f"{service.DEMO_NAME} (demo)", industry="food_beverage", business_type="Milk tea shop",
                 creation_mode="whatif", is_demo=True, description="Fictional demo business. All figures are illustrative.")
    db.add(b)
    db.flush()
    spec = service.demo_profile()
    row = service.save_profile(db, b, spec, "Demo profile (fictional data).", "demo")
    profile = service.parse_profile(row.spec)
    for name, q, lv in service.DEMO_SCENARIOS:
        s = service.create_scenario(db, b, row, profile, name, q, service.parse_levers({**lv, "horizon_months": 12}), None, "demo", {})
        s.pinned = name == "Current pricing"
    db.commit()
    return {"business": business_out(db, b), "created": True}


@router.get("/businesses/{business_id}/profile")
def get_profile(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    row = service.latest_profile(db, b)
    if row is None:
        twin = db.get(ModelVersion, b.active_model_version_id) if b.active_model_version_id else None
        return {"profile": None, "can_import_twin": twin is not None, "business": business_out(db, b)}
    versions = db.scalars(select(WhatIfProfile.id, ).where(WhatIfProfile.business_id == b.id)).all()
    return {"profile": service.profile_out(row), "versions": len(versions), "business": business_out(db, b),
            "industry": {"id": row.spec["industry"], **INDUSTRIES[row.spec["industry"]]}}


class ProfileIn(BaseModel):
    spec: dict
    note: str = Field("", max_length=400)


@router.put("/businesses/{business_id}/profile")
def put_profile(business_id: int, data: ProfileIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    prev = service.latest_profile(db, b)
    row = service.save_profile(db, b, data.spec, data.note or "Updated in Business setup.", "user", prev.spec if prev else None)
    audit(db, b.id, "user", "whatif.profile_saved", f"Saved profile version {row.version}.", {"profile_id": row.id}, ws.id)
    db.commit()
    return {"profile": service.profile_out(row), "business": business_out(db, b)}


@router.post("/businesses/{business_id}/profile/validate")
def validate(business_id: int, data: ProfileIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    owned_business(db, ws, business_id)
    return engine.validate_profile(service.parse_profile(data.spec))


@router.post("/businesses/{business_id}/profile/from-twin")
def from_twin(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    mv = db.get(ModelVersion, b.active_model_version_id) if b.active_model_version_id else None
    if mv is None:
        raise HTTPException(409, "This business has no retail digital twin to import from.")
    spec = service.twin_to_profile(b, mv)
    row = service.save_profile(db, b, spec, f"Imported from digital twin model v{mv.version} (daily figures × 30).", "import")
    db.commit()
    return {"profile": service.profile_out(row)}


# --------------------------------------------------------------- simulate

class SimIn(BaseModel):
    levers: dict = Field(default_factory=dict)
    explain: bool = False


@router.post("/businesses/{business_id}/simulate")
def simulate(business_id: int, data: SimIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Calculate a scenario without saving it."""
    b = owned_business(db, ws, business_id)
    prow, profile = service.require_profile(db, b)
    lv = service.parse_levers(data.levers)
    t0 = time.perf_counter()
    sim, risks = service.run(profile, lv, service.latest_signals(db, b))
    calc_ms = round((time.perf_counter() - t0) * 1000, 1)
    out = {"profile_id": prow.id, "profile_version": prow.version, "result": sim, "risks": risks, "calc_ms": calc_ms,
           "explanation": engine.round_result(ai.calculation_explanation(sim, risks["scenario"], profile.business.currency, profile.unit_label))}
    if data.explain:
        t1 = time.perf_counter()
        out["explanation"] = engine.round_result(ai.explain(sim, risks["scenario"], profile))
        out["ai_ms"] = round((time.perf_counter() - t1) * 1000, 1)
    return out


class InterpretIn(BaseModel):
    question: str = Field(min_length=3, max_length=1000)


@router.post("/businesses/{business_id}/interpret")
def interpret(business_id: int, data: InterpretIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    _, profile = service.require_profile(db, b)
    t0 = time.perf_counter()
    res = ai.interpret(data.question, profile)
    res["elapsed_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return res


class ExplainIn(BaseModel):
    levers: dict = Field(default_factory=dict)


@router.post("/businesses/{business_id}/explain")
def explain(business_id: int, data: ExplainIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    _, profile = service.require_profile(db, b)
    sim, risks = service.run(profile, service.parse_levers(data.levers), service.latest_signals(db, b))
    return engine.round_result(ai.explain(sim, risks["scenario"], profile))


# --------------------------------------------------------------- scenarios

class ScenarioIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    question: str = Field("", max_length=1000)
    levers: dict = Field(default_factory=dict)
    interpretation: dict | None = None
    explanation: dict | None = None
    # A key the browser creates once per completed run: retries and repeated clicks return the same record.
    client_key: str | None = Field(None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    origin: Literal["user", "auto"] = "user"


def _profile_row(db: Session, s: WhatIfScenario) -> WhatIfProfile | None:
    return db.get(WhatIfProfile, s.profile_id)


def _by_client_key(db: Session, b: Business, key: str | None) -> WhatIfScenario | None:
    if not key:
        return None
    return db.scalars(select(WhatIfScenario).where(WhatIfScenario.business_id == b.id, WhatIfScenario.client_key == key)).first()


@router.get("/businesses/{business_id}/scenarios")
def list_scenarios(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    rows = db.scalars(select(WhatIfScenario).where(WhatIfScenario.business_id == b.id).order_by(WhatIfScenario.pinned.desc(), WhatIfScenario.created_at.desc())).all()
    return [service.scenario_out(s) for s in rows]


@router.post("/businesses/{business_id}/scenarios")
def save_scenario(business_id: int, data: ScenarioIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Save a completed simulation (the browser calls this automatically after every successful run).
    The result is recalculated here from the same profile version and levers, stored in one transaction,
    and returned only after the commit, so "Saved" in the browser means the database has the record."""
    b = owned_business(db, ws, business_id)
    existing = _by_client_key(db, b, data.client_key)
    if existing is not None:
        return service.scenario_out(existing, full=True, profile_row=_profile_row(db, existing)) | {"duplicate_request": True}
    prow, profile = service.require_profile(db, b)
    s = service.create_scenario(db, b, prow, profile, data.name.strip(), data.question, service.parse_levers(data.levers),
                                data.interpretation, data.origin, service.latest_signals(db, b), client_key=data.client_key)
    if data.explanation and data.explanation.get("mode") == "ai":
        s.explanation = data.explanation  # keep the AI explanation the user saw (already grounding-checked)
    s.opened_at = service.now()
    audit(db, b.id, "user", "whatif.scenario_saved", f"Saved scenario '{s.name}' ({data.origin}).", {"scenario_id": s.id}, ws.id)
    try:
        db.commit()
    except IntegrityError:  # the same client_key arrived twice at once: return the record the first request stored
        db.rollback()
        existing = _by_client_key(db, b, data.client_key)
        if existing is None:
            raise
        return service.scenario_out(existing, full=True, profile_row=_profile_row(db, existing)) | {"duplicate_request": True}
    return service.scenario_out(s, full=True, profile_row=prow)


@router.get("/businesses/{business_id}/scenarios/latest")
def latest_scenario(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """The saved simulation the user looked at last (or the newest), to restore the simulator after a restart."""
    b = owned_business(db, ws, business_id)
    s = db.scalars(select(WhatIfScenario).where(WhatIfScenario.business_id == b.id)
                   .order_by(func.coalesce(WhatIfScenario.opened_at, WhatIfScenario.created_at).desc(), WhatIfScenario.id.desc()).limit(1)).first()
    return {"scenario": service.scenario_out(s) if s else None}


@router.get("/history")
def history(q: str = "", business_id: int | None = None, origin: str | None = None, sort: str = "created", order: str = "desc",
            limit: int = 200, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Every saved simulation in this workspace, newest first, with its business."""
    businesses = {b.id: b for b in db.scalars(select(Business).where(Business.user_id == ws.id)).all()}
    if business_id is not None and business_id not in businesses:
        raise HTTPException(404, "Business not found.")
    ids = [business_id] if business_id is not None else list(businesses)
    stmt = select(WhatIfScenario).where(WhatIfScenario.business_id.in_(ids or [-1]))
    if q.strip():
        like = f"%{q.strip()[:80]}%"
        stmt = stmt.where(WhatIfScenario.name.ilike(like) | WhatIfScenario.question.ilike(like))
    if origin in ("auto", "user", "demo"):
        stmt = stmt.where(WhatIfScenario.origin == origin)
    rows = db.scalars(stmt.order_by(WhatIfScenario.created_at.desc()).limit(max(1, min(500, limit)))).all()
    out = [service.scenario_out(s) | {"business_name": businesses[s.business_id].name} for s in rows]
    keys = {"created": lambda r: r["created_at"], "name": lambda r: r["name"].lower(), "business": lambda r: (r["business_name"].lower(), r["created_at"]),
            "profit": lambda r: (r["summary"]["net_profit"] is None, r["summary"]["net_profit"] or 0)}
    out.sort(key=keys.get(sort, keys["created"]), reverse=(order == "desc"))
    return {"scenarios": out, "businesses": [{"id": b.id, "name": b.name} for b in businesses.values()], "storage": db_health()}


@router.get("/scenarios/{scenario_id}")
def get_scenario(scenario_id: int, open: bool = False, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """A saved simulation exactly as it was stored (no recalculation). open=true records it as the last one viewed."""
    s, _ = _owned_scenario(db, ws, scenario_id)
    if open:
        s.opened_at = service.now()
        db.commit()
    return service.scenario_out(s, full=True, profile_row=_profile_row(db, s))


class ScenarioPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=160)
    pinned: bool | None = None


@router.patch("/scenarios/{scenario_id}")
def patch_scenario(scenario_id: int, data: ScenarioPatch, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    s, _ = _owned_scenario(db, ws, scenario_id)
    if data.name is not None:
        s.name = data.name.strip()
        if s.origin == "auto":
            s.origin = "user"  # a named run is a scenario the user chose to keep
    if data.pinned is not None:
        s.pinned = data.pinned
    db.commit()
    return service.scenario_out(s)


class DuplicateIn(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=160)


@router.post("/scenarios/{scenario_id}/duplicate")
def duplicate_scenario(scenario_id: int, data: DuplicateIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """An exact copy of the saved record (same inputs, results, risks and explanation), linked to its source."""
    s, b = _owned_scenario(db, ws, scenario_id)
    copy = WhatIfScenario(business_id=s.business_id, profile_id=s.profile_id, name=(data.name or f"{s.name} (copy)")[:160], question=s.question,
                          levers=s.levers, interpretation=s.interpretation, result=s.result, risks=s.risks, explanation=s.explanation,
                          origin="user", calc_ms=s.calc_ms, source_scenario_id=s.id)
    db.add(copy)
    db.flush()
    audit(db, b.id, "user", "whatif.scenario_duplicated", f"Duplicated '{s.name}'.", {"scenario_id": copy.id, "source": s.id}, ws.id)
    db.commit()
    return service.scenario_out(copy, full=True, profile_row=_profile_row(db, copy))


@router.delete("/scenarios/{scenario_id}")
def delete_scenario(scenario_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    s, b = _owned_scenario(db, ws, scenario_id)
    audit(db, b.id, "user", "whatif.scenario_deleted", f"Deleted scenario '{s.name}'.", {}, ws.id)
    for a in db.scalars(select(WhatIfRiskAssessment).where(WhatIfRiskAssessment.business_id == b.id, WhatIfRiskAssessment.scope == f"scenario:{s.id}")).all():
        db.delete(a)
    db.delete(s)
    db.commit()
    return {"ok": True}


class ScenarioExplainIn(BaseModel):
    refresh: bool = False


@router.post("/scenarios/{scenario_id}/explain")
def explain_saved(scenario_id: int, data: ScenarioExplainIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Explain a saved simulation from its stored result and the profile version it was calculated with, and store
    the explanation on the record. An existing AI explanation is returned unless refresh is set."""
    s, b = _owned_scenario(db, ws, scenario_id)
    if s.explanation and s.explanation.get("mode") == "ai" and s.explanation.get("chart_notes") and not data.refresh:
        return {k: v for k, v in s.explanation.items() if k != "context"} | {"cached": True}
    prow = _profile_row(db, s)
    if prow is None:
        raise HTTPException(409, "The business profile this simulation was calculated with is no longer available.")
    profile = service.parse_profile(prow.spec)
    t0 = time.perf_counter()
    expl = engine.round_result(ai.explain(s.result, (s.risks or {}).get("scenario") or {}, profile))
    expl["ai_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    # Keep an AI explanation already stored if this attempt fell back to rules (e.g. the daily AI quota is used up).
    if expl.get("mode") == "ai" or not (s.explanation or {}).get("mode") == "ai":
        s.explanation = expl
        db.commit()
    else:
        return {k: v for k, v in s.explanation.items() if k != "context"} | {"cached": True, "notice": expl.get("notice")}
    return {k: v for k, v in expl.items() if k != "context"}


@router.post("/scenarios/{scenario_id}/rerun")
def rerun(scenario_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Recalculate a saved scenario on the current business profile as a NEW record; the original stays as it was."""
    s, b = _owned_scenario(db, ws, scenario_id)
    prow, profile = service.require_profile(db, b)
    new = service.create_scenario(db, b, prow, profile, f"{s.name} (recalculated)", s.question, service.parse_levers(s.levers),
                                  s.interpretation, "user", service.latest_signals(db, b), source_scenario_id=s.id)
    db.commit()
    return service.scenario_out(new, full=True, profile_row=prow)


# ------------------------------------------------------------------ risk

AUTO_RUNS_IN_RADAR = 5


def _financials(projection: dict) -> dict:
    """Headline figures for one projection, from the engine (the same figures the dashboard and simulator use)."""
    t, m = projection["totals"], projection["metrics"]
    return {"horizon_months": projection["horizon_months"], "revenue": t["revenue"], "total_expenses": t["variable_costs"] + t["operating_expenses"] + t["tax"],
            "gross_profit": t["gross_profit"], "net_profit": t["net_profit"], "net_margin": m["net_margin"], "break_even_units": m["break_even_units"],
            "units_per_month": projection["monthly_avg"]["units"]}


@router.get("/businesses/{business_id}/risk")
def risk_radar(business_id: int, horizon_months: int = 12, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Recalculate risks now for the current course and every saved scenario."""
    b = owned_business(db, ws, business_id)
    prow, profile = service.require_profile(db, b)
    sig = service.latest_signals(db, b)
    horizon = max(1, min(36, horizon_months))
    base_sim, base_r = service.run(profile, Levers(horizon_months=horizon), sig)
    scen = []
    # Named and demo scenarios, plus the most recent automatic runs; older automatic runs stay in History.
    rows = db.scalars(select(WhatIfScenario).where(WhatIfScenario.business_id == b.id).order_by(WhatIfScenario.created_at.desc())).all()
    autos = [s for s in rows if s.origin == "auto"]
    versions = dict(db.execute(select(WhatIfProfile.id, WhatIfProfile.version).where(WhatIfProfile.business_id == b.id)).all())
    rows = [s for s in rows if s.origin != "auto" or s in autos[:AUTO_RUNS_IN_RADAR]]
    for s in rows:
        if not s.levers or Levers.model_validate(s.levers).is_baseline():
            continue
        sim, r = service.run(profile, service.parse_levers(s.levers), sig)
        for f in r["scenario"]["findings"]:
            f["scenario_id"], f["scenario_name"], f["created_at"] = s.id, s.name, s.created_at.isoformat()
        # The page recalculates on today's figures; the assessment stored with the scenario is returned beside it,
        # so a changed business profile never silently replaces what the scenario was saved with.
        saved = (s.risks or {}).get("scenario") or {}
        scen.append({"id": s.id, "name": s.name, "levers": s.levers, "created_at": s.created_at.isoformat(), "origin": s.origin,
                     "score": r["scenario"]["score"], "level": r["scenario"]["level"], "counts": r["scenario"]["counts"], "findings": r["scenario"]["findings"],
                     "net_profit": sim["scenario"]["totals"]["net_profit"], "financials": _financials(sim["scenario"]),
                     "saved": {"level": saved.get("level"), "score": saved.get("score"), "counts": saved.get("counts"),
                               "net_profit": ((s.result or {}).get("scenario") or {}).get("totals", {}).get("net_profit"),
                               "profile_version": versions.get(s.profile_id), "computed_at": (s.result or {}).get("computed_at")},
                     "inputs_changed": s.profile_id != prow.id})
    for f in base_r["baseline"]["findings"]:
        f["scenario_id"], f["scenario_name"], f["created_at"] = None, "Current course", prow.created_at.isoformat()
    return {"computed_at": base_sim["computed_at"], "profile_version": prow.version, "horizon_months": horizon,
            "currency": profile.business.currency, "unit_label": profile.unit_label, "baseline": base_r["baseline"], "baseline_financials": _financials(base_sim["baseline"]),
            "scenarios": scen,
            "signals": {k: {kk: v.get(kk) for kk in ("label", "source", "kind", "status", "summary", "retrieved_at", "reason")} for k, v in sig.items()},
            "rules": risk.rules_catalog(), "categories": risk.CATEGORIES, "older_automatic_runs": max(0, len(autos) - AUTO_RUNS_IN_RADAR)}


class AssessmentIn(BaseModel):
    scope: str = Field("baseline", max_length=40, description='"baseline" or a saved scenario id')
    finding_id: str | None = Field(None, max_length=80)
    horizon_months: int = Field(12, ge=1, le=36)
    refresh: bool = False


def _assessment_inputs(db: Session, b: Business, data: AssessmentIn):
    """Recalculate the scope exactly as the Risk Radar page does and pick the findings to assess."""
    _, profile = service.require_profile(db, b)
    sig = service.latest_signals(db, b)
    if data.scope == "baseline":
        lv = Levers(horizon_months=data.horizon_months)
        scope = {"kind": "baseline", "id": None, "name": "the current course"}
    else:
        try:
            sid = int(data.scope)
        except ValueError:
            raise HTTPException(422, "scope must be 'baseline' or a scenario id.")
        s = db.get(WhatIfScenario, sid)
        if s is None or s.business_id != b.id:
            raise HTTPException(404, "Scenario not found.")
        lv = service.parse_levers(s.levers)
        scope = {"kind": "scenario", "id": s.id, "name": f"the scenario “{s.name}”"}
    sim, risks = service.run(profile, lv, sig)
    report = risks["scenario" if scope["kind"] == "scenario" else "baseline"]
    focus = None
    if data.finding_id:
        focus = next((f for f in report["findings"] if f["id"] == data.finding_id), None)
        if focus is None:
            raise HTTPException(409, "That warning no longer applies to the current figures. Recalculate Risk Radar and choose again.")
    key = advisor.input_key(profile, lv, sim, sig, data.finding_id, data.horizon_months)
    return profile, sig, sim, report, scope, focus, key


def _latest_assessment(db: Session, b: Business, scope: str, finding_id: str | None) -> WhatIfRiskAssessment | None:
    return db.scalars(select(WhatIfRiskAssessment).where(
        WhatIfRiskAssessment.business_id == b.id, WhatIfRiskAssessment.scope == scope,
        WhatIfRiskAssessment.finding_id == (finding_id or "")).order_by(WhatIfRiskAssessment.id.desc()).limit(1)).first()


def _scope_key(data: AssessmentIn) -> str:
    return "baseline" if data.scope == "baseline" else f"scenario:{data.scope}"


@router.get("/businesses/{business_id}/risk/assessment")
def get_assessment(business_id: int, scope: str = "baseline", finding_id: str | None = None, horizon_months: int = 12,
                   ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """The latest saved assessment for this scope, and whether it still matches the current figures. Never calls the AI."""
    b = owned_business(db, ws, business_id)
    data = AssessmentIn(scope=scope, finding_id=finding_id, horizon_months=max(1, min(36, horizon_months)))
    row = _latest_assessment(db, b, _scope_key(data), data.finding_id)
    try:
        key = _assessment_inputs(db, b, data)[-1]
    except HTTPException as exc:
        if exc.status_code != 409:
            raise
        key = None  # the selected warning no longer exists, so any saved assessment of it is outdated
    return {"assessment": row.content if row else None, "current": bool(row and row.input_key == key),
            "ai": {"configured": llm.available, "model": llm.model if llm.available else None}}


@router.post("/businesses/{business_id}/risk/assessment")
def create_assessment(business_id: int, data: AssessmentIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Assess the current risks. Reuses a saved AI assessment when the inputs are unchanged unless refresh is set.
    Suggested scenarios are returned for review only; nothing is simulated, saved or changed here."""
    b = owned_business(db, ws, business_id)
    profile, sig, sim, report, scope, focus, key = _assessment_inputs(db, b, data)
    skey = _scope_key(data)
    row = _latest_assessment(db, b, skey, data.finding_id)
    if row and row.input_key == key and not data.refresh and (row.mode == "ai" or not llm.available):
        return {"assessment": row.content, "current": True, "cached": True}
    t0 = time.perf_counter()
    content = engine.round_result(advisor.assess(profile, sim, report, scope=scope, signals=sig, focus=focus))
    content["elapsed_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    db.add(WhatIfRiskAssessment(business_id=b.id, scope=skey, finding_id=data.finding_id or "", input_key=key, mode=content["mode"], content=content))
    # Keep the five latest per scope and warning.
    old = db.scalars(select(WhatIfRiskAssessment.id).where(
        WhatIfRiskAssessment.business_id == b.id, WhatIfRiskAssessment.scope == skey,
        WhatIfRiskAssessment.finding_id == (data.finding_id or "")).order_by(WhatIfRiskAssessment.id.desc()).offset(4)).all()
    for oid in old:
        db.delete(db.get(WhatIfRiskAssessment, oid))
    audit(db, b.id, "user", "whatif.risk_assessment", f"Risk assessment ({content['mode']}) for {skey}.", {"scope": skey, "mode": content["mode"]}, ws.id)
    db.commit()
    return {"assessment": content, "current": True, "cached": False}


# ----------------------------------------------------------------- compare

class CompareIn(BaseModel):
    scenario_ids: list[int] = Field(default_factory=list, max_length=8)
    include_baseline: bool = True
    objective: str = "max_profit"
    horizon_months: int = Field(12, ge=1, le=36)
    explain: bool = False


@router.post("/businesses/{business_id}/compare")
def compare(business_id: int, data: CompareIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    _, profile = service.require_profile(db, b)
    items = [{"id": None, "name": "Current course", "levers": {}}] if data.include_baseline else []
    for sid in data.scenario_ids:
        s, sb = _owned_scenario(db, ws, sid)
        if sb.id != b.id:
            raise HTTPException(422, "Scenarios must belong to the selected business.")
        items.append({"id": s.id, "name": s.name, "levers": s.levers})
    if len(items) < 2:
        raise HTTPException(422, "Choose at least two scenarios to compare (the current course counts as one).")
    table = service.compare(profile, items, data.objective, data.horizon_months, None, service.latest_signals(db, b))
    table = engine.round_result(table)
    table["commentary"] = ai.explain_comparison(table) if data.explain else {"mode": "calculation", "summary": table["ranking_note"], "trade_offs": [], "caveats": [], "notice": None}
    return table


# ----------------------------------------------------------------- signals

@router.get("/businesses/{business_id}/signals")
def get_signals(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    row = service.latest_profile(db, b)
    relevant = signals.relevant(service.parse_profile(row.spec)) if row else []
    return {"relevant": relevant, "signals": service.latest_signals(db, b),
            "note": "Signals are retrieved when you refresh them. Nothing is monitored in the background."}


@router.post("/businesses/{business_id}/signals/refresh")
def refresh_signals(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    _, profile = service.require_profile(db, b)
    got = signals.fetch_all(profile, service.latest_signals(db, b))
    for k, v in got.items():
        db.add(WhatIfSignal(business_id=b.id, key=k, status=v["status"], payload=v))
    db.commit()
    return {"relevant": list(got), "signals": got}


class ApplyIn(BaseModel):
    levers: dict = Field(default_factory=dict)
    rule: str
    params: dict = Field(default_factory=dict)


@router.post("/businesses/{business_id}/signals/apply")
def apply_signal(business_id: int, data: ApplyIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Turn a retrieved data point into explicit scenario changes with a traceable DataLink. Nothing is saved."""
    b = owned_business(db, ws, business_id)
    _, profile = service.require_profile(db, b)
    lv, link = signals.apply_rule(profile, service.parse_levers(data.levers), service.latest_signals(db, b), data.rule, data.params)
    return {"levers": lv.model_dump(exclude_defaults=True), "link": link}


class UnapplyIn(BaseModel):
    levers: dict = Field(default_factory=dict)
    link_id: str


@router.post("/businesses/{business_id}/signals/unapply")
def unapply_signal(business_id: int, data: UnapplyIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    owned_business(db, ws, business_id)
    return {"levers": signals.remove_link(service.parse_levers(data.levers), data.link_id).model_dump(exclude_defaults=True)}


# ----------------------------------------------------------------- reports

class ReportIn(BaseModel):
    title: str = Field("", max_length=200)
    scenario_ids: list[int] = Field(min_length=1, max_length=8)
    objective: str = "max_profit"


@router.post("/businesses/{business_id}/reports")
def create_report(business_id: int, data: ReportIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    prow, profile = service.require_profile(db, b)
    scen = []
    for sid in data.scenario_ids:
        s, sb = _owned_scenario(db, ws, sid)
        if sb.id != b.id:
            raise HTTPException(422, "Scenarios must belong to the selected business.")
        scen.append(s)
    content = engine.round_result(service.report_content(b, prow, profile, scen, data.objective, service.latest_signals(db, b)))
    title = data.title.strip() or f"{b.name}: {', '.join(s.name for s in scen[:3])}"[:200]
    r = WhatIfReport(business_id=b.id, title=title, scenario_ids=data.scenario_ids, content=content)
    db.add(r)
    audit(db, b.id, "user", "whatif.report_created", f"Created report '{title}'.", {}, ws.id)
    db.commit()
    return {"id": r.id, "title": r.title, "created_at": r.created_at.isoformat(), "content": content}


@router.get("/businesses/{business_id}/reports")
def list_reports(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    rows = db.scalars(select(WhatIfReport).where(WhatIfReport.business_id == b.id).order_by(WhatIfReport.created_at.desc())).all()
    return [{"id": r.id, "title": r.title, "created_at": r.created_at.isoformat(), "scenario_ids": r.scenario_ids,
             "ai": (r.content.get("narrative") or {}).get("mode") == "ai"} for r in rows]


def _owned_report(db: Session, ws: Workspace, rid: int) -> WhatIfReport:
    r = db.get(WhatIfReport, rid)
    if r is None:
        raise HTTPException(404, "Report not found.")
    owned_business(db, ws, r.business_id)
    return r


@router.get("/reports/{report_id}")
def get_report(report_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = _owned_report(db, ws, report_id)
    return {"id": r.id, "title": r.title, "created_at": r.created_at.isoformat(), "content": r.content}


@router.get("/reports/{report_id}/csv")
def report_csv(report_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = _owned_report(db, ws, report_id)
    body = service.report_csv(r.content)
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="whatif-report-{r.id}.csv"'})


@router.delete("/reports/{report_id}")
def delete_report(report_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    r = _owned_report(db, ws, report_id)
    db.delete(r)
    db.commit()
    return {"ok": True}


# --------------------------------------------------------------- dashboard

@router.get("/businesses/{business_id}/dashboard")
def dashboard(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    row = service.latest_profile(db, b)
    if row is None:
        return {"business": business_out(db, b), "profile": None}
    profile = service.parse_profile(row.spec)
    sig = service.latest_signals(db, b)
    sim, risks = service.run(profile, Levers(horizon_months=12), sig)
    scen = db.scalars(select(WhatIfScenario).where(WhatIfScenario.business_id == b.id).order_by(WhatIfScenario.created_at.desc()).limit(6)).all()
    insights = [{"scenario_id": s.id, "scenario": s.name, "mode": (s.explanation or {}).get("mode"), "summary": (s.explanation or {}).get("summary"),
                 "created_at": s.created_at.isoformat()} for s in scen if s.explanation][:4]
    return {
        "business": business_out(db, b), "profile_version": row.version, "profile_updated_at": row.created_at.isoformat(),
        "industry": {"id": profile.industry, **INDUSTRIES[profile.industry]}, "currency": profile.business.currency,
        "unit_label": profile.unit_label, "default_share": round(engine.default_share(profile), 3),
        "history": [h.model_dump() for h in profile.history],
        "baseline": {"months": [{k: m[k] for k in ("month", "revenue", "net_profit", "cash", "units")} for m in sim["baseline"]["months"]],
                     "totals": sim["baseline"]["totals"], "metrics": sim["baseline"]["metrics"], "monthly_avg": sim["baseline"]["monthly_avg"]},
        "risk": {k: risks["baseline"][k] for k in ("score", "level", "counts")} | {"findings": risks["baseline"]["findings"][:5]},
        "scenarios": [service.scenario_out(s) for s in scen], "insights": insights,
        "signals": {k: {kk: v.get(kk) for kk in ("label", "source", "kind", "status", "summary", "retrieved_at", "reason")} for k, v in sig.items()},
        "relevant_signals": signals.relevant(profile), "ai": llm.status(), "validation": row.validation,
    }


# ------------------------------------------------------------------ public

_preview_hits: dict[str, deque] = defaultdict(deque)


class PreviewIn(BaseModel):
    price_change_pct: float = Field(0, ge=-50, le=50)
    unit_cost_change_pct: float = Field(0, ge=-50, le=50)
    demand_change_pct: float = Field(0, ge=-50, le=50)


@router.post("/public/preview")
def public_preview(data: PreviewIn, request: Request):
    """Landing-page preview: the real engine on the fictional demo shop. Nothing is stored."""
    key = request.client.host if request.client else "?"
    q, t = _preview_hits[key], time.time()
    while q and q[0] < t - 60:
        q.popleft()
    if len(q) >= 240:
        raise HTTPException(429, "Too many preview requests. Try again in a minute.")
    q.append(t)
    profile = service.parse_profile(service.demo_profile())
    lv = Levers(price_change_pct=data.price_change_pct, unit_cost_change_pct=data.unit_cost_change_pct,
                demand_change_pct=data.demand_change_pct, horizon_months=12, start_month="2027-01")
    sim = engine.simulate(profile, lv)
    r = risk.analyse(profile, sim, scope="scenario")
    sim = engine.round_result(sim, 2)
    pick = lambda pr: [{"month": m["month"], "net_profit": m["net_profit"], "revenue": m["revenue"]} for m in pr["months"]]
    return {"demo": True, "label": "Fictional demo business: Sunny Cup Milk Tea", "currency": "PHP",
            "baseline": pick(sim["baseline"]), "scenario": pick(sim["scenario"]),
            "best": sim["bands"]["best"]["monthly_net_profit"], "worst": sim["bands"]["worst"]["monthly_net_profit"],
            "delta": {k: sim["delta"][k] for k in ("revenue", "net_profit", "net_margin", "units")},
            "risk": {"score": r["score"], "level": r["level"], "top": [{"severity": f["severity"], "title": f["title"]} for f in r["findings"][:3]]},
            "assessment": ai.assessment(sim), "computed_at": sim["computed_at"], "engine": sim["engine"]}
