"""AI interpretation for What-if: questions -> levers, results -> plain language.

Separation of duties:
    engine.py / risk.py  calculate every number and decide every threshold
    this module          asks the AI to read those numbers and explain them

AI output is validated against Pydantic schemas. Explanations are checked
against the calculated facts: a sentence that cites a number not found in
the results is removed. When no AI provider is connected, explanations are
built directly from the calculation and labelled "From the calculation".
What is sent: industry, unit label, product names and figures, cost totals,
the levers and the results. Never sent: business name, description,
location or history rows.
"""
from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from ..agents.llm import llm, ungrounded_numbers
from . import rules_parser
from .schemas import Levers, Profile


# ------------------------------------------------------------------ schemas

class AIRecognized(BaseModel):
    lever: str = Field(description="Lever field name, e.g. price_change_pct")
    label: str
    value: float | None = None
    unit: str = ""
    source: Literal["stated", "assumed"]
    text: str = Field("", description="The words in the question this came from, or the assumption made")


class AIInterpretation(BaseModel):
    # The lever object is returned as JSON text and validated here against the full Levers model.
    # Enforcing the whole Levers schema as an output grammar is too large for providers
    # ("The compiled grammar is too large"), and the client-side validation is stricter anyway.
    levers_json: str = Field(description='JSON object with only the lever fields to change, e.g. {"price_change_pct": -10}')
    recognized: list[AIRecognized]
    questions: list[str] = Field(description="Questions for missing information that materially affects the result")
    unrecognized: str | None = Field(None, description="Parts of the question that cannot be simulated with these levers")
    name: str = Field(description="Short scenario name, max 60 characters")


class AIRiskNote(BaseModel):
    finding_id: str
    explanation: str


class AIRecommendation(BaseModel):
    text: str
    try_question: str | None = Field(None, description="A 'What if ...' question the user could simulate next")


class AIExplanation(BaseModel):
    summary: str = Field(description="2-4 sentences: what changes, why, and whether it appears worthwhile under the assumptions")
    key_points: list[str] = Field(description="Up to 5 short points, each tied to a calculated figure")
    risk_notes: list[AIRiskNote] = Field(default_factory=list)
    recommendations: list[AIRecommendation] = Field(default_factory=list)
    next_scenarios: list[str] = Field(default_factory=list, description="Up to 4 'What if ...' questions worth testing")
    caveats: list[str] = Field(default_factory=list, description="Assumptions or missing information that matter most")


class AIComparison(BaseModel):
    summary: str
    trade_offs: list[str]
    caveats: list[str] = Field(default_factory=list)


class AIReport(BaseModel):
    executive_summary: str
    findings: list[str]
    recommendations: list[str]
    caveats: list[str] = Field(default_factory=list)


# ---------------------------------------------------------- context helpers

def profile_context(p: Profile) -> dict:
    """What the AI may see about the business (no name, description, location or history)."""
    return {
        "industry": p.industry, "currency": p.business.currency, "country": p.business.country, "unit_label": p.unit_label,
        "products": [{"id": x.id, "name": x.name, "price": x.price, "variable_cost": x.unit_cost, "monthly_units": x.monthly_units,
                      "elasticity": x.elasticity} for x in p.products],
        "staff": [{"role": s.role, "count": s.count, "monthly_cost_each": s.monthly_wage} for s in p.staff],
        "fixed_costs_per_month": sum(c.monthly_amount for c in p.fixed_costs),
        "rent_per_month": sum(c.monthly_amount for c in p.fixed_costs if c.category == "rent"),
        "marketing_per_month": p.marketing.monthly_budget,
        "capacity_per_month": p.operations.monthly_capacity_units, "capacity_per_staff": p.operations.capacity_per_staff,
        "subscription": p.subscription.model_dump() if p.subscription.enabled else None,
        "starting_cash": p.finance.starting_cash, "tax_rate_pct": p.finance.tax_rate_pct,
    }


def _facts(obj) -> list[float]:
    out: list[float] = []

    def walk(o):
        if isinstance(o, bool):
            return
        if isinstance(o, (int, float)):
            out.append(float(o))
        elif isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(obj)
    return out


def _grounded(items: list[str], facts: list[float]) -> tuple[list[str], int]:
    keep, dropped = [], 0
    for t in items:
        if ungrounded_numbers(t, facts):
            dropped += 1
        else:
            keep.append(t)
    return keep, dropped


# ------------------------------------------------------------ interpretation

INTERPRET_SYSTEM = """You turn a business owner's "What if ...?" question into simulation levers for the What-if engine.
Rules:
- Only set levers the question states or clearly implies. Leave every other lever at its default (0, empty or null).
- Percent levers are percentages: "lower the price by 10%" is price_change_pct = -10.
- If the question needs a number it does not give (e.g. the cost of a new branch), choose a cautious placeholder based on the
  business figures provided, mark it source "assumed", and add a question asking the user for the real figure.
- Product ids must come from the product list. Months are 1-12. Use the country to decide which months a season covers.
- Never invent market data, statistics or prices of competitors. Do not calculate results; the engine does that.
- If part of the question cannot be expressed with the levers, say so in `unrecognized`."""


def interpret(question: str, profile: Profile) -> dict:
    """Question -> levers. Uses the AI when connected, otherwise the rule-based parser (labelled)."""
    if llm.available:
        prompt = ("Business figures (JSON):\n" + json.dumps(profile_context(profile), default=str)
                  + "\n\nLever reference (JSON schema):\n" + json.dumps(Levers.model_json_schema())[:12000]
                  + f"\n\nQuestion: {question.strip()[:1000]}")
        out = llm.structured(INTERPRET_SYSTEM, prompt, AIInterpretation, effort="low")
        levers = None
        if out is not None:
            try:
                raw = json.loads(out.levers_json or "{}")
                raw.pop("data_links", None)  # data links only come from retrieved data, never from the AI
                levers = Levers.model_validate(raw)
            except (ValueError, ValidationError) as exc:
                llm.last_error = f"the AI returned invalid levers ({type(exc).__name__})"
        if out is not None and levers is not None:
            ids = {p.id for p in profile.products}
            levers = levers.model_copy(update={
                "price_product_ids": [i for i in levers.price_product_ids if i in ids],
                "cost_product_ids": [i for i in levers.cost_product_ids if i in ids],
            })
            levers = Levers.model_validate(levers.model_dump())  # re-validate ranges client-side
            return {"mode": "ai", "model": llm.last_model or llm.model, "provider": llm.provider,
                    "levers": levers.model_dump(exclude_defaults=True), "recognized": [r.model_dump() for r in out.recognized],
                    "questions": out.questions[:6], "unrecognized": out.unrecognized, "name": out.name[:80] or "Custom scenario",
                    "notice": None}
        res = rules_parser.parse(question, profile)
        res["notice"] = f"AI interpretation failed ({llm.last_error}). The rule-based parser was used instead."
        return res
    res = rules_parser.parse(question, profile)
    res["notice"] = "AI is not connected, so a rule-based parser read your question. It understands common decisions; check the recognised changes."
    return res


# --------------------------------------------------------------- explaining

def assessment(sim: dict) -> dict:
    """Deterministic verdict on the scenario vs the current course, across the uncertainty ranges."""
    b, s = sim["baseline"]["totals"]["net_profit"], sim["scenario"]["totals"]["net_profit"]
    bw, sw = sim["baseline_bands"]["worst"]["net_profit"], sim["bands"]["worst"]["net_profit"]
    bb, sb = sim["baseline_bands"]["best"]["net_profit"], sim["bands"]["best"]["net_profit"]
    diff = s - b
    scale = max(abs(b), 1.0)
    if sim.get("is_baseline"):
        key, text = "baseline", "This is the current course: no changes are applied."
    elif abs(diff) < 0.02 * scale:
        key, text = "similar", "Under these assumptions the change makes little difference to net profit."
    elif diff > 0 and sw >= bw and sb >= bb:
        key, text = "better", "Higher net profit than the current course in the expected, best and worst cases."
    elif diff > 0:
        key, text = "better_uncertain", "Higher expected net profit, but not in every case within the stated ranges."
    elif sb <= bb and sw <= bw:
        key, text = "worse", "Lower net profit than the current course in the expected, best and worst cases."
    else:
        key, text = "worse_uncertain", "Lower expected net profit, though some cases within the ranges do better."
    return {"key": key, "text": text, "net_profit_change": diff}


def required_volume(sim: dict) -> dict | None:
    """For price or cost changes: extra volume needed to keep the same gross profit."""
    lv = sim["levers"]
    if not (lv.get("price_change_pct") or lv.get("unit_cost_change_pct")):
        return None
    b, s = sim["baseline"], sim["scenario"]
    cpu_b = b["metrics"]["contribution_per_unit"]
    # Contribution per unit at the new prices/costs but the old sales mix
    bp = {p["id"]: p for p in b["products"]}
    units = sum(p["units"] for p in b["products"])
    if not units or cpu_b is None:
        return None
    cpu_new = sum((p["price"] - p["unit_cost"]) * bp[p["id"]]["units"] for p in s["products"] if not p["is_new"] and p["id"] in bp) / units
    expected = (s["totals"]["units"] / b["totals"]["units"] - 1) if b["totals"]["units"] else None
    if cpu_new <= 0:
        return {"possible": False, "contribution_before": cpu_b, "contribution_after": cpu_new, "expected_change": expected}
    return {"possible": True, "needed_change": cpu_b / cpu_new - 1, "contribution_before": cpu_b, "contribution_after": cpu_new, "expected_change": expected}


def _fmt(v: float) -> str:
    return f"{v:,.0f}"


def calculation_explanation(sim: dict, risks: dict, cur: str, unit_label: str) -> dict:
    """Plain-language explanation built only from the calculation (no AI)."""
    a = assessment(sim)
    d = sim["delta"]
    H = sim["scenario"]["horizon_months"]
    pts = []
    if sim.get("is_baseline"):
        summary = (f"On the current course the business makes {_fmt(d['net_profit']['baseline'])} {cur} net profit over {H} months "
                   f"on revenue of {_fmt(d['revenue']['baseline'])} {cur}.")
    else:
        summary = (f"Over {H} months, net profit changes from {_fmt(d['net_profit']['baseline'])} to {_fmt(d['net_profit']['scenario'])} {cur} "
                   f"({'+' if a['net_profit_change'] >= 0 else '−'}{_fmt(abs(a['net_profit_change']))} {cur}). {a['text']}")
        drivers = sorted(sim["bridge"], key=lambda x: -abs(x["value"]))[:3]
        for x in drivers:
            pts.append(f"{x['label']}: {'+' if x['value'] >= 0 else '−'}{_fmt(abs(x['value']))} {cur} on net profit.")
    rv = required_volume(sim)
    if rv:
        if not rv["possible"]:
            pts.append("After this change each unit sells for less than it costs, so no sales volume keeps profit up.")
        else:
            exp = rv["expected_change"]
            pts.append(f"To keep the same gross profit, sales volume would need to change by {rv['needed_change'] * 100:+.1f}%; "
                       f"the elasticity assumption gives {exp * 100:+.1f}%." if exp is not None else
                       f"To keep the same gross profit, sales volume would need to change by {rv['needed_change'] * 100:+.1f}%.")
    m = sim["scenario"]["metrics"]
    if m["break_even_units"] is not None:
        pts.append(f"Break-even is {_fmt(m['break_even_units'])} {unit_label} a month.")
    w = sim["bands"]["worst"]["net_profit"]
    bst = sim["bands"]["best"]["net_profit"]
    pts.append(f"Within the stated ranges, net profit runs from {_fmt(w)} to {_fmt(bst)} {cur}.")
    recs = []
    for f in risks.get("findings", [])[:3]:
        for act in f.get("actions", [])[:1]:
            if act.get("levers"):
                recs.append({"text": f"{f['title']}: {act['label'].lower()}.", "try_question": None, "levers": act["levers"]})
    caveats = [x["text"] for x in sim["confidence"]["reasons"][:3]]
    return {"mode": "calculation", "model": None, "assessment": a, "required_volume": rv, "summary": summary,
            "key_points": pts[:5], "risk_notes": [], "recommendations": recs, "next_scenarios": [], "caveats": caveats, "dropped": 0,
            "notice": None if llm.available else "AI is not connected. This explanation was written from the calculation by fixed rules."}


EXPLAIN_SYSTEM = """You explain the output of a deterministic business simulation to a small-business owner.
Rules:
- Use only the figures in the facts. Never introduce a number that is not in the facts; round only as the facts are rounded.
- The engine's numbers are final. Do not recalculate, correct or contradict them.
- Say clearly that results depend on the stated assumptions (especially estimated ones) and are not guarantees.
- Do not invent market data, competitor behaviour or statistics.
- Keep it short, concrete and in plain language. Explain why the numbers changed and whether the change appears worthwhile.
- Recommendations should be things the owner can test in the simulator; phrase try_question as a "What if ..." question.
- Refer to risk findings by their finding_id when you explain them."""


def _pack(sim: dict, risks: dict, profile: Profile) -> dict:
    s, b = sim["scenario"], sim["baseline"]
    return {
        "business": profile_context(profile),
        "scenario_levers": sim["levers"], "horizon_months": s["horizon_months"], "currency": sim["currency"],
        "totals": {"baseline": b["totals"], "scenario": s["totals"]},
        "metrics": {"baseline": b["metrics"], "scenario": s["metrics"]},
        "profit_bridge": sim["bridge"], "demand_factors": s["demand_factors"],
        "best_worst": {"scenario": {k: sim["bands"][k]["net_profit"] for k in ("best", "worst")},
                       "baseline": {k: sim["baseline_bands"][k]["net_profit"] for k in ("best", "worst")}},
        "assessment": assessment(sim), "required_volume": required_volume(sim),
        "confidence": sim["confidence"], "assumptions": sim["assumptions"],
        "risks": [{"finding_id": f["id"], "severity": f["severity"], "title": f["title"], "summary": f["summary"],
                   "metric": f["metric"], "actions": [a["label"] for a in f["actions"]]} for f in risks.get("findings", [])[:8]],
    }


def explain(sim: dict, risks: dict, profile: Profile) -> dict:
    base = calculation_explanation(sim, risks, profile.business.currency, profile.unit_label)
    if not llm.available:
        return base
    pack = _pack(sim, risks, profile)
    facts = _facts(pack)
    out = llm.structured(EXPLAIN_SYSTEM, "Facts (JSON):\n" + json.dumps(pack, default=str)[:60000], AIExplanation, effort="medium")
    if out is None:
        base["notice"] = f"The AI explanation could not be produced ({llm.last_error}). This explanation was written from the calculation."
        return base
    summary, d1 = _grounded([out.summary], facts)
    points, d2 = _grounded(out.key_points[:5], facts)
    caveats, d3 = _grounded(out.caveats[:5], facts)
    notes = []
    dropped = d1 + d2 + d3
    ids = {f["id"] for f in risks.get("findings", [])}
    for n in out.risk_notes:
        if n.finding_id in ids and not ungrounded_numbers(n.explanation, facts):
            notes.append(n.model_dump())
        else:
            dropped += 1
    recs = []
    for r in out.recommendations[:5]:
        if ungrounded_numbers(r.text, facts):
            dropped += 1
            continue
        recs.append(r.model_dump())
    return {"mode": "ai", "model": llm.last_model or llm.model, "provider": llm.provider, "assessment": base["assessment"], "required_volume": base["required_volume"],
            "summary": summary[0] if summary else base["summary"], "key_points": points or base["key_points"], "risk_notes": notes,
            "recommendations": recs, "next_scenarios": out.next_scenarios[:4], "caveats": caveats or base["caveats"], "dropped": dropped,
            "notice": (f"{dropped} AI statement(s) were removed because they cited figures that are not in the calculation." if dropped else None)}


COMPARE_SYSTEM = """You compare business scenarios that a deterministic engine has already calculated.
Use only figures in the facts; never introduce new numbers. Explain the trade-offs for the stated objective.
Do not call any scenario universally best: say which assumptions the ranking depends on. Plain language, short."""


def explain_comparison(table: dict) -> dict:
    if not llm.available:
        return {"mode": "calculation", "summary": table["ranking_note"], "trade_offs": [], "caveats": [],
                "notice": "AI is not connected. The ranking above is calculated; no AI commentary was written."}
    facts = _facts(table)
    out = llm.structured(COMPARE_SYSTEM, "Facts (JSON):\n" + json.dumps(table, default=str)[:60000], AIComparison, effort="low")
    if out is None:
        return {"mode": "calculation", "summary": table["ranking_note"], "trade_offs": [], "caveats": [],
                "notice": f"The AI comparison could not be produced ({llm.last_error})."}
    s, d1 = _grounded([out.summary], facts)
    t, d2 = _grounded(out.trade_offs[:6], facts)
    c, d3 = _grounded(out.caveats[:4], facts)
    return {"mode": "ai", "model": llm.last_model or llm.model, "summary": s[0] if s else table["ranking_note"], "trade_offs": t, "caveats": c,
            "notice": f"{d1 + d2 + d3} AI statement(s) were removed because they cited figures not in the comparison." if d1 + d2 + d3 else None}


REPORT_SYSTEM = """You write the narrative part of a business simulation report from calculated facts.
Use only figures in the facts; never introduce numbers. State that results are simulations under assumptions, not forecasts.
Executive summary: 3-5 sentences. Findings and recommendations: short bullet sentences."""


def report_narrative(pack: dict) -> dict:
    if not llm.available:
        return {"mode": "calculation", "available": False,
                "notice": "AI is not connected; the report contains calculated results and rule-based explanations only."}
    facts = _facts(pack)
    out = llm.structured(REPORT_SYSTEM, "Facts (JSON):\n" + json.dumps(pack, default=str)[:80000], AIReport, effort="medium")
    if out is None:
        return {"mode": "calculation", "available": False, "notice": f"The AI narrative could not be produced ({llm.last_error})."}
    es, d1 = _grounded([out.executive_summary], facts)
    f, d2 = _grounded(out.findings[:8], facts)
    r, d3 = _grounded(out.recommendations[:8], facts)
    c, d4 = _grounded(out.caveats[:6], facts)
    return {"mode": "ai", "available": True, "model": llm.last_model or llm.model, "executive_summary": es[0] if es else None, "findings": f,
            "recommendations": r, "caveats": c, "dropped": d1 + d2 + d3 + d4}
