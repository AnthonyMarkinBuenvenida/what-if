"""What-if business logic shared by the API routes."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Business, ModelVersion, WhatIfProfile, WhatIfScenario, WhatIfSignal
from . import ai, engine, risk
from .industries import INDUSTRIES, _season, value_paths
from .schemas import OBJECTIVES, Levers, Profile

DISCLAIMER = ("What-if results are simulations calculated from the inputs and assumptions shown. They support decisions; "
              "they are not forecasts or guarantees of future performance.")


def now() -> datetime:
    return datetime.now(timezone.utc)


def validation_error(exc: ValidationError) -> HTTPException:
    msgs = []
    for e in exc.errors()[:8]:
        loc = ".".join(str(x) for x in e["loc"])
        msgs.append(f"{loc}: {e['msg']}" if loc else e["msg"])
    return HTTPException(422, "; ".join(msgs))


def parse_profile(spec: dict) -> Profile:
    try:
        return Profile.model_validate(spec)
    except ValidationError as exc:
        raise validation_error(exc) from exc


def parse_levers(data: dict) -> Levers:
    try:
        return Levers.model_validate(data or {})
    except ValidationError as exc:
        raise validation_error(exc) from exc


def latest_profile(db: Session, b: Business) -> WhatIfProfile | None:
    return db.scalars(select(WhatIfProfile).where(WhatIfProfile.business_id == b.id).order_by(WhatIfProfile.version.desc()).limit(1)).first()


def require_profile(db: Session, b: Business) -> tuple[WhatIfProfile, Profile]:
    row = latest_profile(db, b)
    if row is None:
        raise HTTPException(409, "This business has no What-if profile yet. Complete Business setup first.")
    return row, Profile.model_validate(row.spec)


def save_profile(db: Session, b: Business, spec: dict, note: str, created_by: str = "user", previous: dict | None = None) -> WhatIfProfile:
    prof = parse_profile(spec)
    out = prof.model_dump()
    # Values the user changed become "user"; untouched estimates stay "default".
    prov = dict(spec.get("provenance") or (previous or {}).get("provenance") or {})
    if previous:
        old_vals = dict(_values(previous))
        for path, v in _values(out):
            if path not in old_vals or old_vals[path] != v:
                prov[path] = "user" if created_by == "user" else prov.get(path, created_by)
    for path in value_paths(out):
        prov.setdefault(path, "user")
    out["provenance"] = {k: v for k, v in prov.items() if k in set(value_paths(out)) or k.startswith("business.")}
    last = db.scalar(select(func.max(WhatIfProfile.version)).where(WhatIfProfile.business_id == b.id)) or 0
    row = WhatIfProfile(business_id=b.id, version=last + 1, spec=out, validation=engine.validate_profile(Profile.model_validate(out)),
                        note=note, created_by=created_by)
    db.add(row)
    b.industry = prof.industry
    b.business_type = prof.business.business_type or b.business_type
    b.name = prof.business.name
    b.updated_at = now()
    db.flush()
    return row


def _values(spec: dict):
    for path in value_paths(spec):
        group, ident, field = (path.split(".") + [None, None])[:3]
        if group in ("products", "staff", "fixed_costs"):
            item = next((x for x in spec.get(group, []) if x.get("id") == ident), None)
            yield path, (item or {}).get(field)
        elif field is None:
            yield path, (spec.get(group) or {}).get(ident)
        else:
            yield path, None


def profile_out(row: WhatIfProfile) -> dict:
    return {"id": row.id, "version": row.version, "spec": row.spec, "validation": row.validation, "note": row.note,
            "created_by": row.created_by, "created_at": row.created_at.isoformat()}


# ------------------------------------------------------------------- signals

def latest_signals(db: Session, b: Business) -> dict:
    rows = db.scalars(select(WhatIfSignal).where(WhatIfSignal.business_id == b.id).order_by(WhatIfSignal.retrieved_at.desc())).all()
    out: dict = {}
    for r in rows:
        if r.key not in out:
            out[r.key] = r.payload
    return out


# ------------------------------------------------------------------ simulate

def run(profile: Profile, levers: Levers, signals: dict | None = None, origin: dict | None = None) -> tuple[dict, dict]:
    sim = engine.simulate(profile, levers, origin)
    risks = risk.analyse(profile, sim, scope="scenario", signals=signals)
    base_risks = risk.analyse(profile, sim, scope="baseline", signals=signals)
    return engine.round_result(sim), {"scenario": engine.round_result(risks), "baseline": engine.round_result(base_risks)}


def scenario_out(s: WhatIfScenario, full: bool = False) -> dict:
    r = s.result or {}
    d = r.get("delta", {})
    out = {
        "id": s.id, "business_id": s.business_id, "profile_id": s.profile_id, "name": s.name, "question": s.question,
        "levers": s.levers, "origin": s.origin, "pinned": s.pinned,
        "created_at": s.created_at.isoformat(), "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        "summary": {
            "horizon_months": (r.get("scenario") or {}).get("horizon_months"),
            "net_profit": (d.get("net_profit") or {}).get("scenario"), "net_profit_baseline": (d.get("net_profit") or {}).get("baseline"),
            "revenue": (d.get("revenue") or {}).get("scenario"), "net_margin": (d.get("net_margin") or {}).get("scenario"),
            "risk_score": ((s.risks or {}).get("scenario") or {}).get("score"), "risk_level": ((s.risks or {}).get("scenario") or {}).get("level"),
            "confidence": (r.get("confidence") or {}).get("level"), "is_baseline": r.get("is_baseline"),
            "assessment": ((s.explanation or {}).get("assessment") or {}).get("key"),
        },
    }
    if full:
        out.update({"result": s.result, "risks": s.risks, "explanation": s.explanation, "interpretation": s.interpretation})
    return out


# ---------------------------------------------------------------- compare

METRICS = [
    ("revenue", "Revenue", "money"), ("variable_costs", "Variable costs", "money"), ("operating_expenses", "Operating costs", "money"),
    ("net_profit", "Net profit", "money"), ("net_margin", "Net margin", "pct"), ("min_cash", "Lowest cash", "money"),
    ("ending_cash", "Ending cash", "money"), ("break_even_units", "Break-even units / month", "num"),
]


def compare(profile: Profile, items: list[dict], objective: str, horizon: int, start_month: str | None, signals: dict | None) -> dict:
    """Recalculate every scenario on the same profile, period and start month, then rank by one objective."""
    if objective not in OBJECTIVES:
        raise HTTPException(422, f"Unknown objective. Choose one of: {', '.join(OBJECTIVES)}.")
    rows = []
    common_start = start_month or "%04d-%02d" % engine._start(Levers())
    for it in items:
        lv = parse_levers({**it["levers"], "horizon_months": horizon, "start_month": common_start})
        sim, risks = run(profile, lv, signals)
        s, m = sim["scenario"], sim["scenario"]["metrics"]
        rows.append({
            "id": it.get("id"), "name": it["name"], "levers": sim["levers"], "is_baseline": sim["is_baseline"],
            "values": {"revenue": s["totals"]["revenue"], "variable_costs": s["totals"]["variable_costs"],
                       "operating_expenses": s["totals"]["operating_expenses"], "net_profit": s["totals"]["net_profit"],
                       "net_margin": m["net_margin"], "min_cash": m["min_cash"], "ending_cash": m["ending_cash"],
                       "break_even_units": m["break_even_units"]},
            "best": sim["bands"]["best"]["net_profit"], "worst": sim["bands"]["worst"]["net_profit"],
            "risk_score": risks["scenario"]["score"], "risk_level": risks["scenario"]["level"],
            "top_risks": [{"severity": f["severity"], "title": f["title"]} for f in risks["scenario"]["findings"][:3]],
            "confidence": sim["confidence"]["level"],
            "assumptions": [a for a in sim["assumptions"] if a["key"].startswith("lever.") or a["key"].startswith("elasticity")][:6],
            "monthly_net_profit": [x["net_profit"] for x in s["months"]], "months": [x["month"] for x in s["months"]],
        })
    key = {"max_profit": lambda r: r["values"]["net_profit"], "protect_cash": lambda r: r["values"]["min_cash"],
           "max_revenue": lambda r: r["values"]["revenue"], "lowest_risk": lambda r: -r["risk_score"],
           "best_margin": lambda r: (r["values"]["net_margin"] if r["values"]["net_margin"] is not None else -1e18)}[objective]
    ranked = sorted(rows, key=key, reverse=True)
    for i, r in enumerate(ranked):
        r["rank"] = i + 1
    note = f"Ranked by {OBJECTIVES[objective].lower()} in the expected case."
    robust = None
    if len(ranked) >= 2 and objective in ("max_profit",):
        a, b = ranked[0], ranked[1]
        robust = a["worst"] > b["best"]
        note += (f" {a['name']} stays ahead of {b['name']} even in its worst case." if robust else
                 f" {a['name']} and {b['name']} overlap within the uncertainty ranges, so the order depends on the assumptions.")
    if len(ranked) >= 2:
        other_best = {o: max(rows, key=f)["name"] for o, f in (("net profit", lambda r: r["values"]["net_profit"]),
                                                              ("lowest cash point", lambda r: r["values"]["min_cash"]),
                                                              ("risk score", lambda r: -r["risk_score"]))}
        if len(set(other_best.values())) > 1:
            note += " Different scenarios lead on different measures: " + "; ".join(f"{k}: {v}" for k, v in other_best.items()) + "."
    return {"objective": objective, "objective_label": OBJECTIVES[objective], "horizon_months": horizon, "start_month": common_start,
            "metrics": [{"key": k, "label": lab, "format": f} for k, lab, f in METRICS], "rows": ranked,
            "ranking_note": note, "robust": robust, "currency": profile.business.currency,
            "method": "All scenarios recalculated on the current business profile with the same period and start month."}


# ----------------------------------------------------------------- reports

def report_content(b: Business, prow: WhatIfProfile, profile: Profile, scenarios: list[WhatIfScenario], objective: str, signals: dict) -> dict:
    items = [{"id": s.id, "name": s.name, "levers": s.levers} for s in scenarios]
    horizon = max([(s.result.get("scenario") or {}).get("horizon_months") or 12 for s in scenarios] or [12])
    comp = compare(profile, items, objective, horizon, None, signals) if scenarios else None
    detail = []
    for s in scenarios:
        lv = parse_levers({**s.levers, "horizon_months": horizon, "start_month": comp["start_month"]})
        sim, risks = run(profile, lv, signals)
        expl = ai.calculation_explanation(sim, risks["scenario"], profile.business.currency, profile.unit_label)
        detail.append({"id": s.id, "name": s.name, "question": s.question, "levers": sim["levers"], "assumptions": sim["assumptions"],
                       "delta": sim["delta"], "bridge": sim["bridge"], "bands": {k: sim["bands"][k]["net_profit"] for k in ("best", "worst")},
                       "metrics": sim["scenario"]["metrics"], "baseline_metrics": sim["baseline"]["metrics"],
                       "months": [{k: m[k] for k in ("month", "revenue", "net_profit", "cash")} for m in sim["scenario"]["months"]],
                       "baseline_months": [{k: m[k] for k in ("month", "revenue", "net_profit", "cash")} for m in sim["baseline"]["months"]],
                       "risks": risks["scenario"], "explanation": expl, "saved_explanation": s.explanation,
                       "confidence": sim["confidence"]})
    sources = [{"key": k, "label": v.get("label"), "source": v.get("source"), "kind": v.get("kind"), "status": v.get("status"),
                "retrieved_at": v.get("retrieved_at"), "url": v.get("source_url"), "summary": v.get("summary")} for k, v in signals.items()]
    pack = {"business": ai.profile_context(profile), "comparison": comp,
            "scenarios": [{k: d[k] for k in ("name", "levers", "delta", "bridge", "bands", "confidence")} | {"risks": [{"severity": f["severity"], "title": f["title"], "summary": f["summary"]} for f in d["risks"]["findings"][:5]]} for d in detail]}
    return {
        "generated_at": now().replace(microsecond=0).isoformat(), "engine": engine.ENGINE_VERSION,
        "business": {"id": b.id, "name": b.name, "industry": profile.industry, "industry_label": INDUSTRIES[profile.industry]["label"],
                     "currency": profile.business.currency, "unit_label": profile.unit_label, "is_demo": b.is_demo,
                     "profile_version": prow.version, "default_share": round(engine.default_share(profile), 3)},
        "comparison": comp, "scenarios": detail, "data_sources": sources, "simplifications": engine.SIMPLIFICATIONS,
        "narrative": ai.report_narrative(pack), "disclaimer": DISCLAIMER,
    }


def report_csv(content: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    cur = content["business"]["currency"]
    w.writerow(["What-if report", content["business"]["name"], f"generated {content['generated_at']}", content["engine"]])
    w.writerow(["All values are calculated by the What-if engine from the stated inputs (not forecasts).", f"currency {cur}"])
    w.writerow([])
    w.writerow(["scenario", "metric", "current course", "scenario", "change"])
    for s in content["scenarios"]:
        for k, d in s["delta"].items():
            w.writerow([s["name"], k, _c(d.get("baseline")), _c(d.get("scenario")), _c(d.get("change"))])
        w.writerow([s["name"], "worst_case_net_profit", "", _c(s["bands"]["worst"]), ""])
        w.writerow([s["name"], "best_case_net_profit", "", _c(s["bands"]["best"]), ""])
        w.writerow([s["name"], "risk_score", "", s["risks"]["score"], s["risks"]["level"]])
    w.writerow([])
    w.writerow(["scenario", "month", "revenue", "net_profit", "cash", "current_course_revenue", "current_course_net_profit", "current_course_cash"])
    for s in content["scenarios"]:
        for m, bm in zip(s["months"], s["baseline_months"]):
            w.writerow([s["name"], m["month"], _c(m["revenue"]), _c(m["net_profit"]), _c(m["cash"]), _c(bm["revenue"]), _c(bm["net_profit"]), _c(bm["cash"])])
    w.writerow([])
    w.writerow(["data source", "kind", "status", "retrieved_at", "url"])
    for d in content["data_sources"]:
        w.writerow([d["label"], d["kind"], d["status"], d["retrieved_at"], d["url"]])
    return buf.getvalue()


def _c(v):
    return "" if v is None else (round(v, 4) if isinstance(v, float) else v)


# -------------------------------------------------------------------- demo

DEMO_NAME = "Sunny Cup Milk Tea"
DEMO_SEASON = _season({3: 1.12, 4: 1.18, 5: 1.15, 7: 0.9, 8: 0.88, 9: 0.9, 12: 1.08})


def demo_profile() -> dict:
    """Fictional milk tea shop. Every number is made up for the demo and labelled as such."""
    spec = {
        "industry": "food_beverage", "unit_label": "cups",
        "business": {"name": f"{DEMO_NAME} (demo)", "business_type": "Milk tea shop", "country": "PH", "currency": "PHP",
                     "description": "Fictional demo business. All figures are illustrative."},
        "products": [
            {"id": "classic", "name": "Classic milk tea", "price": 120, "unit_cost": 45, "monthly_units": 1500, "elasticity": -1.1},
            {"id": "brown-sugar", "name": "Brown sugar boba", "price": 150, "unit_cost": 58, "monthly_units": 900, "elasticity": -1.0},
            {"id": "fruit-tea", "name": "Fruit tea", "price": 110, "unit_cost": 40, "monthly_units": 600, "elasticity": -1.3},
        ],
        "staff": [{"id": "crew", "role": "Crew", "count": 4, "monthly_wage": 17000}, {"id": "supervisor", "role": "Shift supervisor", "count": 1, "monthly_wage": 25000}],
        "fixed_costs": [{"id": "rent", "name": "Mall kiosk rent", "category": "rent", "monthly_amount": 70000},
                        {"id": "utilities", "name": "Electricity & water", "category": "utilities", "monthly_amount": 18000},
                        {"id": "pos", "name": "POS & delivery apps", "category": "software", "monthly_amount": 4000},
                        {"id": "permits", "name": "Permits & insurance", "category": "insurance", "monthly_amount": 3000}],
        "marketing": {"monthly_budget": 10000, "elasticity": 0.08},
        "operations": {"monthly_capacity_units": 4200},
        "finance": {"starting_cash": 350000, "min_cash_buffer": 100000, "tax_rate_pct": 20},
        "growth": {"monthly_growth_pct": 0, "seasonality": DEMO_SEASON},
        "goals": {"target_monthly_profit": 40000, "min_margin_pct": 10},
        "suppliers": [{"name": "Tapioca & tea leaf supplier", "share_pct": 70}, {"name": "Dairy supplier", "share_pct": 30}],
        "location": {"city": "Quezon City", "latitude": 14.6488, "longitude": 121.0509},
        "external": {"foreign_currency": "USD", "imported_cost_share_pct": 35},
        "uncertainty": {"demand_pct": 10, "cost_pct": 5, "elasticity_abs": 0.3},
    }
    # Six fictional past months: seasonal pattern, flat underlying sales, ingredient costs creeping up.
    hist = []
    base_rev = 381000
    for i, month in enumerate(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]):
        idx = DEMO_SEASON[int(month[5:]) - 1]
        rev = round(base_rev * idx, -2)
        cost = round((143700 * (1 + 0.012 * i)) * idx + 198000, -2)
        hist.append({"month": month, "revenue": rev, "units": round(3000 * idx), "total_costs": cost, "net_profit": round(rev - cost, -2)})
    spec["history"] = hist
    prof = Profile.model_validate(spec).model_dump()
    prof["provenance"] = {p: "demo" for p in value_paths(prof)}
    for p in prof["products"]:
        prof["provenance"][f"products.{p['id']}.elasticity"] = "default"
    prof["provenance"]["marketing.elasticity"] = "default"
    return prof


DEMO_SCENARIOS = [
    ("Current pricing", "", {}),
    ("Price reduced by 10%", "What if I lower my selling price by 10%?", {"price_change_pct": -10}),
    ("Price increased by 5%", "What if I raise prices by 5%?", {"price_change_pct": 5}),
    ("Ingredient costs reduced by 8%", "What if ingredient costs drop 8%?", {"unit_cost_change_pct": -8}),
    ("Price −10% and ingredient costs −8%", "What if I lower prices 10% and ingredient costs drop 8%?", {"price_change_pct": -10, "unit_cost_change_pct": -8}),
    ("Ingredient costs up 15%", "What if ingredient costs increase by 15%?", {"unit_cost_change_pct": 15}),
]


def create_scenario(db: Session, b: Business, prow: WhatIfProfile, profile: Profile, name: str, question: str, levers: Levers,
                    interpretation: dict | None, origin: str, signals: dict, with_ai: bool = False) -> WhatIfScenario:
    origin_map = {}
    if interpretation and interpretation.get("mode") == "ai":
        origin_map = {r["lever"].split(".")[0]: ("ai" if r.get("source") == "assumed" else "stated") for r in interpretation.get("recognized", [])}
    elif interpretation:
        origin_map = {r["lever"].split(".")[0]: ("assumed" if r.get("source") == "assumed" else "stated") for r in interpretation.get("recognized", [])}
    sim, risks = run(profile, levers, signals, origin_map)
    expl = ai.explain(sim, risks["scenario"], profile) if with_ai else ai.calculation_explanation(sim, risks["scenario"], profile.business.currency, profile.unit_label)
    s = WhatIfScenario(business_id=b.id, profile_id=prow.id, name=name[:160] or "Scenario", question=question, levers=sim["levers"],
                       interpretation=interpretation, result=sim, risks=risks, explanation=engine.round_result(expl), origin=origin)
    db.add(s)
    db.flush()
    return s


def twin_to_profile(b: Business, mv: ModelVersion) -> dict:
    """Build a What-if profile from an existing retail digital twin (daily figures -> monthly)."""
    spec = mv.spec
    prods = [{"id": p["id"], "name": p["name"], "price": p["price"], "unit_cost": p["unit_cost"],
              "monthly_units": round(p["avg_daily_demand"] * 30, 1), "elasticity": max(-6.0, min(1.0, p.get("price_elasticity", -1.0))),
              "stock_units": p.get("starting_inventory")} for p in spec.get("products", [])]
    per_month = {"daily": 30, "weekly": 30 / 7, "monthly": 1}
    fixed = [{"id": e["id"], "name": e["name"], "category": e.get("category") if e.get("category") in ("rent", "utilities", "software", "insurance", "loan", "maintenance") else "other",
              "monthly_amount": round(e["amount"] * per_month.get(e.get("frequency"), 1), 2)} for e in spec.get("expenses", [])]
    staff = [{"id": s["id"], "role": s["role"], "count": s["count"], "monthly_wage": round(s["hourly_wage"] * s["hours_per_week"] * 30 / 7, 2)} for s in spec.get("staff", [])]
    out = {
        "industry": "retail", "unit_label": "units",
        "business": {"name": b.name, "business_type": (spec.get("business") or {}).get("type") or b.business_type, "country": "",
                     "currency": (spec.get("business") or {}).get("currency", "USD")},
        "products": prods, "staff": staff, "fixed_costs": fixed,
        "operations": {"monthly_capacity_units": None},
        "finance": {"starting_cash": (spec.get("finance") or {}).get("starting_cash", 0), "min_cash_buffer": (spec.get("finance") or {}).get("min_cash_buffer", 0), "tax_rate_pct": 0},
        "goals": {"target_monthly_profit": (spec.get("goals") or {}).get("target_monthly_operating_profit")},
    }
    prof = Profile.model_validate(out).model_dump()
    tw = spec.get("provenance") or {}
    prov = {}
    for p in prof["products"]:
        for f_new, f_old in (("price", "price"), ("unit_cost", "unit_cost"), ("monthly_units", "avg_daily_demand"), ("elasticity", "price_elasticity"), ("stock_units", "starting_inventory")):
            prov[f"products.{p['id']}.{f_new}"] = "default" if tw.get(f"products.{p['id']}.{f_old}") == "default" else "imported"
    for path in value_paths(prof):
        prov.setdefault(path, "imported")
    prof["provenance"] = prov
    return prof
