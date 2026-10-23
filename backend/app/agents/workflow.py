"""Specialised agents with explicit inputs and outputs.

    Data Analyst      organises business data, finds inconsistencies, summarises the business
    Digital Twin      prepares the structured model and lists missing information
    Scenario Designer proposes strategies and conditions worth testing
    Stress-Test       chooses adverse conditions and reads vulnerabilities from results
    Decision Analyst  compares completed results and prepares an evidence-based recommendation

The Simulation Engine (app.engine) is the only component that produces
numerical results. Agents never edit engine output: they receive it read-only
and return text or proposals. Each output records whether it came from the
deterministic path or from the configured AI model.
"""
from __future__ import annotations

import copy
import re
from typing import Literal

from pydantic import BaseModel, Field

from ..domain.retail import grocery_template, normalize_spec, provenance_counts, tag_all, validate_spec, _monthly
from ..domain.worlds import world_templates
from ..engine.analysis import STRESS_SHOCKS, rank_strategies
from .llm import llm, ungrounded_numbers


def _envelope(agent: str, output, mode: str, notes: list[str] | None = None) -> dict:
    return {"agent": agent, "mode": mode, "model": llm.model if mode == "ai" else None,
            "output": output, "notes": notes or []}


def _fallback_note() -> list[str]:
    if llm.available and llm.last_error:
        return [llm.last_error]
    if not llm.available:
        return ["No AI model is configured; this output comes from What-if's deterministic rules."]
    return []


# ---------------------------------------------------------------- Data Analyst

def data_analyst(spec: dict, sources: list[dict] | None = None) -> dict:
    s = normalize_spec(spec)
    v = validate_spec(s, s.get("sales_history_days"))
    daily_rev = sum(float(p["avg_daily_demand"]) * float(p["price"]) for p in s["products"])
    daily_cogs = sum(float(p["avg_daily_demand"]) * float(p["unit_cost"]) for p in s["products"])
    margin = (daily_rev - daily_cogs) / daily_rev if daily_rev else 0.0
    labor_monthly = sum(float(x["count"]) * float(x["hourly_wage"]) * float(x["hours_per_week"]) for x in s["staff"]) * 30 / 7
    fixed_monthly = sum(_monthly(e) for e in s["expenses"]) + labor_monthly
    breakeven_daily = (fixed_monthly / 30) / margin if margin > 0 else None
    perishable_share = (sum(float(p["avg_daily_demand"]) * float(p["price"]) for p in s["products"] if p.get("shelf_life_days")) / daily_rev) if daily_rev else 0
    facts = {
        "products": len(s["products"]),
        "expected_daily_revenue": round(daily_rev, 2),
        "expected_monthly_revenue": round(daily_rev * 30, 2),
        "gross_margin": round(margin, 4),
        "monthly_fixed_costs_incl_labor": round(fixed_monthly, 2),
        "monthly_labor": round(labor_monthly, 2),
        "breakeven_daily_revenue": round(breakeven_daily, 2) if breakeven_daily else None,
        "perishable_revenue_share": round(perishable_share, 4),
        "starting_cash": float(s["finance"]["starting_cash"]),
        "months_of_fixed_costs_in_cash": round(float(s["finance"]["starting_cash"]) / fixed_monthly, 2) if fixed_monthly else None,
        "provenance": provenance_counts(s),
        "validation_status": v["status"],
        "issue_counts": v["counts"],
    }
    findings = []
    if breakeven_daily:
        gap = daily_rev - breakeven_daily
        findings.append(f"At expected demand the store takes about ${daily_rev:,.0f} a day against a break-even of about ${breakeven_daily:,.0f} a day, a cushion of ${gap:,.0f} a day before accounting for waste.")
    if perishable_share > 0.4:
        findings.append(f"Perishable products are about {perishable_share:.0%} of expected revenue, so spoilage and ordering rules matter.")
    if facts["months_of_fixed_costs_in_cash"] is not None:
        findings.append(f"Starting cash covers about {facts['months_of_fixed_costs_in_cash']:.1f} months of fixed costs including labor.")
    counts = facts["provenance"]
    total = sum(counts.values()) or 1
    yours = counts.get("confirmed", 0) + counts.get("user", 0) + counts.get("inferred", 0) + counts.get("calibrated", 0)
    findings.append(f"{yours} of {total} model values come from you or your data; {counts.get('default', 0)} are What-if defaults.")
    for issue in v["issues"]:
        if issue["severity"] in ("error", "warning"):
            findings.append(issue["message"])
    for src in sources or []:
        rep = src.get("report", {})
        if rep.get("rejected_rows"):
            findings.append(f"{src.get('filename')}: {rep['rejected_rows']} row(s) were rejected during import and are not in the model.")
    return _envelope("Data Analyst", {"facts": facts, "findings": findings[:14]}, "deterministic", _fallback_note() if not llm.available else [])


# ---------------------------------------------------------------- Digital Twin

class StatedFacts(BaseModel):
    business_name: str | None = Field(None, description="Only if the user stated a name")
    business_type: str | None = Field(None, description="e.g. grocery, bakery, pharmacy, boutique")
    decision_summary: str = Field(description="One sentence: the decision the user wants to test")
    goals: list[str] = Field(default_factory=list, description="Goals the user stated, in their words")
    stated_budget: float | None = Field(None, description="A spending budget in dollars, only if explicitly stated")
    stated_starting_cash: float | None = None
    stated_monthly_rent: float | None = None
    stated_staff_count: int | None = None
    stated_target_monthly_profit: float | None = None
    mentioned_topics: list[Literal["delivery", "pricing", "inventory", "waste", "staffing", "supplier", "expansion", "costs", "downturn"]] = Field(default_factory=list)


_MONEY = r"\$\s?([\d,]+(?:\.\d+)?)\s?(k|K)?"


def _money(m) -> float:
    v = float(m.group(1).replace(",", ""))
    return v * 1000 if m.group(2) else v


def _extract_rule_based(text: str) -> StatedFacts:
    low = text.lower()
    topics = []
    for topic, words in {
        "delivery": ["deliver"], "pricing": ["price", "pricing"], "inventory": ["inventory", "stock"],
        "waste": ["expired", "expire", "waste", "spoil"], "staffing": ["hire", "employee", "staff"],
        "supplier": ["supplier"], "expansion": ["branch", "second store", "expand"], "costs": ["cost", "rent", "expense"],
        "downturn": ["decline", "downturn", "recession", "survive"],
    }.items():
        if any(w in low for w in words):
            topics.append(topic)
    budget = None
    m = re.search(_MONEY + r"[^.]{0,30}budget|budget[^.$]{0,30}" + _MONEY, text, re.I)
    if m:
        groups = [g for g in m.groups()]
        val = groups[0] or groups[2]
        mult = groups[1] or groups[3]
        budget = float(val.replace(",", "")) * (1000 if mult else 1)
    btype = None
    for t in ("grocery", "bakery", "pharmacy", "convenience", "boutique", "hardware", "bookstore", "florist", "deli", "market"):
        if t in low:
            btype = t
            break
    sentence = re.split(r"(?<=[.!?])\s+", text.strip())
    decision = next((s for s in sentence if re.search(r"\b(want|should|whether|if i|test|decide)\b", s, re.I)), sentence[-1] if sentence else text)
    return StatedFacts(business_type=btype, decision_summary=decision[:300], stated_budget=budget, mentioned_topics=topics)


GUIDED_FACTS = ("starting_cash", "monthly_rent", "staff_count", "budget", "target_monthly_profit", "min_cash_buffer")


def apply_guided_facts(spec: dict, facts: dict) -> list[str]:
    """Write answers from the guided setup into the model, tagged as user-stated."""
    prov = spec.setdefault("provenance", {})
    applied = []
    def num(k):
        v = facts.get(k)
        return float(v) if v not in (None, "") and float(v) >= 0 else None
    if (v := num("starting_cash")) is not None:
        spec["finance"]["starting_cash"] = v; prov["finance.starting_cash"] = "user"; applied.append("starting cash")
    if (v := num("min_cash_buffer")) is not None:
        spec["finance"]["min_cash_buffer"] = v; prov["finance.min_cash_buffer"] = "user"; applied.append("cash buffer")
    if (v := num("monthly_rent")) is not None:
        for e in spec["expenses"]:
            if e.get("category") == "rent":
                e["amount"] = v; prov[f"expenses.{e['id']}.amount"] = "user"
        applied.append("rent")
    if (v := num("staff_count")) is not None:
        clerks = next((x for x in spec["staff"] if x["id"] == "clerks"), None)
        if clerks:
            clerks["count"] = max(0, int(v) - 1); prov["staff.clerks.count"] = "user"; applied.append("staff count")
    if (v := num("budget")) is not None:
        spec["goals"]["max_investment_budget"] = v; applied.append("budget")
    if (v := num("target_monthly_profit")) is not None:
        spec["goals"]["target_monthly_operating_profit"] = v; applied.append("profit target")
    return applied


def digital_twin_agent(name: str, business_type: str, description: str, guided: dict | None = None) -> dict:
    """Build the first model version from a description.

    Only facts the user actually stated are written into the model (tagged
    'user'). Everything else comes from the retail template and stays tagged
    'default' so the interface can ask for real data.
    """
    mode, notes = "deterministic", []
    facts = None
    if llm.available and description.strip():
        facts = llm.structured(
            system=("You extract facts a small-business owner has explicitly stated. Never estimate or invent numbers; "
                    "leave a field empty unless the text states it. Keep the decision summary in plain language."),
            prompt=f"Business type selected: {business_type}\nBusiness name: {name}\n\nOwner's description:\n{description}",
            schema=StatedFacts, effort="low",
        )
        if facts is not None:
            mode = "ai"
    if facts is None:
        notes += _fallback_note()
        facts = _extract_rule_based(description)

    spec = grocery_template(name or facts.business_name or "My store")
    spec["business"]["type"] = business_type or facts.business_type or "grocery"
    prov = spec["provenance"]
    if facts.stated_budget:
        spec["goals"]["max_investment_budget"] = facts.stated_budget
        prov["goals.max_investment_budget"] = "user"
    if facts.stated_starting_cash:
        spec["finance"]["starting_cash"] = facts.stated_starting_cash
        prov["finance.starting_cash"] = "user"
    if facts.stated_monthly_rent:
        for e in spec["expenses"]:
            if e["category"] == "rent":
                e["amount"] = facts.stated_monthly_rent
                prov[f"expenses.{e['id']}.amount"] = "user"
    if facts.stated_staff_count:
        clerks = next((s for s in spec["staff"] if s["id"] == "clerks"), None)
        if clerks:
            clerks["count"] = max(0, facts.stated_staff_count - 1)
            prov["staff.clerks.count"] = "user"
    if facts.stated_target_monthly_profit:
        spec["goals"]["target_monthly_operating_profit"] = facts.stated_target_monthly_profit
    spec["goals"]["stated"] = facts.goals
    if guided:
        applied = apply_guided_facts(spec, guided)
        if applied:
            notes.append("Guided setup answers applied: " + ", ".join(applied) + ".")
    if (business_type or "").lower() not in ("grocery", "neighborhood grocery", "convenience", "market", "deli", ""):
        notes.append(f"What-if's starting template is a neighborhood grocery. Replace the product list with your own {business_type} products.")

    missing = [
        "Your product list with selling prices and purchase costs (CSV/XLSX import or manual entry)",
        "At least 4 weeks of sales history to estimate demand",
        "Current stock on hand and supplier lead times",
        "Recurring expenses (rent, utilities, insurance, software)",
        "Staff, wages and weekly hours",
        "Cash available today and the minimum cash you want to keep",
    ]
    return _envelope("Digital Twin", {"spec": spec, "stated_facts": facts.model_dump(), "missing_information": missing}, mode, notes)


# ----------------------------------------------------------- Scenario Designer

class LeverProposal(BaseModel):
    price_change_pct: float = 0
    demand_change_pct: float = 0
    supplier_cost_change_pct: float = 0
    order_quantity_change_pct: float = 0
    reorder_point_change_pct: float = 0
    lead_time_change_days: int = 0
    staff_hours_change_pct: float = 0
    expense_change_pct: float = 0
    one_time_investment: float = 0
    unexpected_expense: float = 0
    add_staff_count: int = 0
    add_staff_hours_per_week: float = 0
    add_staff_hourly_wage: float = 0
    delivery_enabled: bool = False
    delivery_orders_per_day: float = 0
    delivery_fee_per_order: float = 0
    delivery_cost_per_order: float = 0
    delivery_setup_cost: float = 0


class ScenarioProposal(BaseModel):
    name: str
    kind: Literal["baseline", "inventory", "delivery", "price", "stress", "staffing", "custom"]
    description: str
    decision: str
    rationale: str
    assumptions: list[str]
    levers: LeverProposal


class ScenarioProposals(BaseModel):
    proposals: list[ScenarioProposal] = Field(max_length=6)


def _lever_dict(lp: LeverProposal) -> dict:
    d = {k: v for k, v in lp.model_dump().items() if not k.startswith(("delivery_", "add_staff")) and v}
    clamp = {"price_change_pct": (-30, 30), "demand_change_pct": (-60, 60), "supplier_cost_change_pct": (-30, 60),
             "order_quantity_change_pct": (-80, 150), "reorder_point_change_pct": (-80, 150), "lead_time_change_days": (-10, 20),
             "staff_hours_change_pct": (-80, 80), "expense_change_pct": (-50, 80), "one_time_investment": (0, 500000), "unexpected_expense": (0, 500000)}
    for k, (lo, hi) in clamp.items():
        if k in d:
            d[k] = min(hi, max(lo, d[k]))
    if lp.add_staff_count > 0:
        d["extra_staff"] = [{"role": "Additional staff", "count": min(10, lp.add_staff_count), "hours_per_week": min(60, lp.add_staff_hours_per_week or 30), "hourly_wage": min(100, lp.add_staff_hourly_wage or 17)}]
    if lp.delivery_enabled:
        d["delivery"] = {"enabled": True, "orders_per_day": min(500, lp.delivery_orders_per_day or 20), "units_per_order": 6,
                         "fee_per_order": lp.delivery_fee_per_order, "cost_per_order": lp.delivery_cost_per_order or 6.5,
                         "fixed_monthly_cost": 600, "setup_cost": lp.delivery_setup_cost, "cannibalization_pct": 35}
    return d


def _rule_proposals(decision: str, spec: dict) -> list[dict]:
    low = (decision or "").lower()
    templates = {w["kind"]: w for w in world_templates([p["id"] for p in spec.get("products", [])])}
    picked = [templates["baseline"]]
    if "deliver" in low:
        picked.append(templates["delivery"])
        d2 = copy.deepcopy(templates["delivery"])
        d2.update(kind="delivery", name="Delivery + Extra Staff World",
                  description="Delivery service plus one part-time packer so in-store service is not squeezed.",
                  decision="Start delivery and add a part-time packer")
        d2["levers"]["extra_staff"] = [{"role": "Part-time packer", "count": 1, "hours_per_week": 25, "hourly_wage": 16.5}]
        d2["assumptions"] = d2["assumptions"] + ["The packer handles delivery picking so clerks keep serving walk-in customers."]
        picked.append(d2)
    if any(w in low for w in ("price", "pricing")):
        picked.append(templates["price"])
    if any(w in low for w in ("expired", "expire", "waste", "spoil")):
        perishable = [p["id"] for p in spec.get("products", []) if p.get("shelf_life_days")]
        picked.append({
            "kind": "inventory", "name": "Lean Ordering World",
            "description": "Order 25% less per purchase on perishables to cut expired stock, accepting more frequent orders.",
            "decision": "Order perishables in smaller batches",
            "levers": {"order_quantity_change_pct": -25, "inventory_products": perishable},
            "assumptions": ["Suppliers accept smaller orders at the same unit price.", "Ordering more often does not add delivery charges."],
        })
    if any(w in low for w in ("inventory", "stock")) and not any(w in low for w in ("expired", "waste", "spoil")):
        picked.append(templates["inventory"])
    if any(w in low for w in ("hire", "employee", "staff")):
        picked.append({
            "kind": "staffing", "name": "Extra Employee World",
            "description": "Hire one additional clerk for 30 hours a week.",
            "decision": "Hire another employee",
            "levers": {"extra_staff": [{"role": "Store clerk", "count": 1, "hours_per_week": 30, "hourly_wage": 17}]},
            "assumptions": ["The new hire is fully productive from day one."],
        })
    if len(picked) == 1:
        picked += [templates["inventory"], templates["delivery"], templates["price"]]
    picked.append(templates["stress"])
    for p in picked:
        p.setdefault("rationale", {
            "baseline": "Every comparison needs the business as it is today.",
            "stress": "A strategy is only attractive if the business also survives a bad quarter.",
        }.get(p["kind"], "Directly tests the decision you described."))
    return picked


def scenario_designer(decision: str, spec: dict) -> dict:
    mode, notes, proposals = "deterministic", [], None
    if llm.available and decision.strip():
        s = normalize_spec(spec)
        catalog = "; ".join(f"{p['id']} ({p['name']}, ${p['price']}, shelf life {p.get('shelf_life_days') or 'none'})" for p in s["products"])
        out = llm.structured(
            system=("You design business experiments for a retail simulation engine. Propose 3-6 scenarios as lever changes "
                    "relative to the current model. Always include a baseline with no changes and one adverse 'stress' scenario. "
                    "Use modest, realistic changes. Assumptions must state what each scenario takes for granted. "
                    "Do not predict outcomes; the engine will compute them."),
            prompt=f"Decision the owner wants to test:\n{decision}\n\nProducts: {catalog}\nStarting cash: ${s['finance']['starting_cash']:,.0f}\nBudget: {s['goals'].get('max_investment_budget')}",
            schema=ScenarioProposals,
        )
        if out is not None and out.proposals:
            mode = "ai"
            proposals = [{"kind": p.kind, "name": p.name[:120], "description": p.description, "decision": p.decision,
                          "rationale": p.rationale, "assumptions": p.assumptions, "levers": _lever_dict(p.levers)} for p in out.proposals]
            if not any(p["kind"] == "baseline" for p in proposals):
                proposals.insert(0, _rule_proposals("", spec)[0])
    if proposals is None:
        notes += _fallback_note()
        proposals = _rule_proposals(decision, spec)
    return _envelope("Scenario Designer", {"proposals": proposals}, mode, notes)


# ---------------------------------------------------------------- Stress-Test

def stress_test_agent(spec: dict, scenario_kind: str, levers: dict) -> dict:
    s = normalize_spec(spec)
    picks: list[tuple[str, str]] = [("demand_drop", "Demand is the assumption with the widest real-world uncertainty.")]
    if any(p.get("shelf_life_days") for p in s["products"]):
        picks.append(("faster_spoilage", "Perishable stock makes the plan sensitive to spoilage."))
    picks.append(("supplier_increase", "Margins depend on supplier prices staying where they are."))
    if scenario_kind in ("delivery", "staffing") or (levers.get("delivery") or {}).get("enabled"):
        picks.append(("staff_shortage", "Delivery picking competes with in-store service for staff time."))
    if scenario_kind == "inventory" or float(levers.get("order_quantity_change_pct") or 0) > 0:
        picks.append(("cash_reserve_cut", "Larger orders tie up cash; check the plan with a thinner reserve."))
    if max((float(p.get("lead_time_days") or 0) for p in s["products"]), default=0) >= 4:
        picks.append(("delivery_delays", "Some suppliers already have long lead times."))
    picks.append(("unexpected_bill", "Small businesses regularly face one-off repair or tax bills."))
    seen, out = set(), []
    for k, why in picks:
        if k not in seen:
            seen.add(k)
            out.append({"key": k, "label": STRESS_SHOCKS[k]["label"], "reason": why})
    return _envelope("Stress-Test", {"suggested": out[:5], "available": [{"key": k, "label": v["label"]} for k, v in STRESS_SHOCKS.items()]}, "deterministic")


def stress_vulnerabilities(stress_result: dict) -> list[str]:
    out = []
    for row in stress_result["rows"][1:]:
        h = row["headline"]
        if h["violations"]:
            out.append(f"{row['label']}: breaks {', '.join(h['violations']).lower()} (operating profit {row['delta']['monthly_operating_profit']:+,.0f}/month).")
    if not out:
        out.append("No tested condition broke a defined limit.")
    return out


# ------------------------------------------------------------ Decision Analyst

class Narrative(BaseModel):
    summary: str = Field(description="3-5 sentences. Use only figures from the facts provided.")
    recommendation: str
    risks: list[str]
    next_steps: list[str]


def _money_s(v: float) -> str:
    return f"-${abs(v):,.0f}" if v < 0 else f"${v:,.0f}"


def _share(p: float) -> str:
    """Probability as a share of runs; never rounds a non-zero share down to 0%."""
    return f"{p:.0%}" if p >= 0.01 or p == 0 else "under 1%"


def decision_analyst(comparison: dict, goals: dict) -> dict:
    """Recommend from computed results. Highest profit is not automatically best."""
    rows = comparison["rows"]
    if not rows:
        return _envelope("Decision Analyst", {"error": "No completed results to compare."}, "deterministic")
    ranked = rank_strategies(rows, goals.get("risk_tolerance", "medium"))
    best = ranked[0]
    ref = rows[0]
    facts: list[float] = []
    lines = []
    for r in rows:
        mp = r["avg_monthly_operating_profit"]
        facts += [mp["mean"], mp["p10"], mp["p50"], mp["p90"], r["min_cash"]["p10"], r["min_cash"]["mean"],
                  r["revenue"]["mean"], r["fill_rate"]["mean"], r["waste_rate"]["mean"], r["cash_below_buffer"],
                  r["ending_cash"]["mean"], r["one_time_costs"]["mean"]]
        if r["meets_profit_target"] is not None:
            facts.append(r["meets_profit_target"])
        lines.append(f"{r['scenario_name']}: monthly operating profit {_money_s(mp['p50'])} median (range {_money_s(mp['p10'])} to {_money_s(mp['p90'])}); "
                      f"lowest cash {_money_s(r['min_cash']['p10'])} in a bad run; served {r['fill_rate']['mean']:.0%} of demand; waste {r['waste_rate']['mean']:.1%}; "
                      + (f"limits broken: {', '.join(r['violations']).lower()}." if r["violations"] else "no limits broken."))
    for e in comparison.get("explanations", []):
        facts.append(e.get("monthly_operating_profit_change"))
        facts += [d["monthly_effect"] for d in e.get("drivers", [])]
    target = goals.get("target_monthly_operating_profit")
    if target is not None:
        facts.append(float(target))

    viable = [r for r in ranked if not r["violations"]]
    uncertain = False
    if len(ranked) > 1:
        a, b = ranked[0], ranked[1]
        if not a["violations"] and not b["violations"]:
            # Overlapping 10-90 ranges: the order could flip under other assumptions.
            uncertain = a["avg_monthly_operating_profit"]["p10"] < b["avg_monthly_operating_profit"]["p90"] and \
                        b["avg_monthly_operating_profit"]["p10"] < a["avg_monthly_operating_profit"]["p90"]
    top_profit = max(rows, key=lambda r: r["avg_monthly_operating_profit"]["p50"])

    if viable:
        rec = f"Prefer {best['scenario_name']}: it is the strongest option that breaks none of your limits."
    else:
        rec = (f"No tested option met every limit. {best['scenario_name']} comes closest. Adjust the plan or the limits "
               "before committing money, and see the Failure Museum for what broke.")
    if top_profit["run_id"] != best["run_id"]:
        why = (f"it breaks: {', '.join(top_profit['violations']).lower()}" if top_profit["violations"]
               else f"cash dips below your buffer in {_share(top_profit['cash_below_buffer'])} of runs versus {_share(best['cash_below_buffer'])}")
        rec += (f" {top_profit['scenario_name']} has the highest median profit ({_money_s(top_profit['avg_monthly_operating_profit']['p50'])}/month) "
                f"but is ranked lower because {why}.")
    risks = []
    for r in rows:
        if r["violations"]:
            risks.append(f"{r['scenario_name']} breaks: {', '.join(r['violations']).lower()}.")
        if r["cash_below_buffer"] > 0:
            risks.append(f"{r['scenario_name']}: cash dips below your buffer in {_share(r['cash_below_buffer'])} of runs.")
    if not risks:
        risks.append("No scenario broke a defined limit in these runs. Risks outside the model (competition, regulation, seasonality) are not covered.")
    steps = []
    if uncertain:
        a, b = ranked[0], ranked[1]
        steps.append(f"The ranges for {a['scenario_name']} and {b['scenario_name']} overlap, so the ranking depends on assumptions. "
                     "Run a small, reversible test (for example two weeks, or one product group) and record the results in Reality Feedback before committing.")
    if best["scenario_name"] != ref["scenario_name"]:
        steps.append(f"Run a stress test on {best['scenario_name']} to see which condition would break it.")
    steps.append("Replace remaining default values in the digital twin with your own data; results are only as good as the inputs.")

    summary = (f"{len(rows)} scenarios were compared over {rows[0]['horizon_days']} days using model version {rows[0]['model_version_id']}. "
               f"{len(viable)} of them met all defined limits.")
    narrative = {"summary": summary, "recommendation": rec, "risks": risks, "next_steps": steps}
    mode, notes = "deterministic", []
    if llm.available:
        out = llm.structured(
            system=("You are a careful business analyst. Write for a small-business owner with no finance training. "
                    "Use ONLY numbers that appear in the facts. Do not round to new values; quote figures as given. "
                    "Do not call any result a forecast or guarantee: these are simulations under stated assumptions. "
                    "Never recommend the highest-profit option just because it is highest; respect the owner's limits and risk tolerance."),
            prompt=("Facts (computed by the simulation engine):\n" + "\n".join(lines) +
                    f"\n\nRanking by resilience then profit: {', '.join(r['scenario_name'] for r in ranked)}" +
                    f"\nOwner's goals: {goals}\nOverlapping uncertainty between top two: {uncertain}\n" +
                    f"Draft recommendation: {rec}\nDraft risks: {risks}\nDraft next steps: {steps}"),
            schema=Narrative,
        )
        if out is not None:
            text = " ".join([out.summary, out.recommendation, *out.risks, *out.next_steps])
            bad = ungrounded_numbers(text, facts + [len(rows), rows[0]["horizon_days"], rows[0]["model_version_id"]])
            if bad:
                notes.append(f"The AI narrative was discarded because it contained figures not found in the results ({', '.join(bad[:4])}). Deterministic text is shown instead.")
            else:
                narrative = out.model_dump()
                mode = "ai"
        else:
            notes += _fallback_note()
    else:
        notes += _fallback_note()
    return _envelope("Decision Analyst", {
        **narrative,
        "scenario_facts": lines,
        "ranking": [{"run_id": r["run_id"], "scenario_name": r["scenario_name"], "violations": r["violations"]} for r in ranked],
        "recommended_run_id": best["run_id"],
        "depends_on_assumptions": uncertain,
        "ranking_rule": "Scenarios that break a limit rank below those that do not; then lower chance of dipping below the cash buffer; then higher median profit.",
    }, mode, notes)


# ------------------------------------------------------------------ Plan mode

def build_plan(name: str, business_type: str, description: str, spec: dict) -> dict:
    """Plan mode: review assumptions and prepare a simulation plan before anything runs."""
    analyst = data_analyst(spec)
    designer = scenario_designer(description, spec)
    validation = validate_spec(spec)
    to_verify = [i for i in validation["issues"] if i["severity"] in ("warning", "error")]
    return {
        "created_by": ["Data Analyst", "Digital Twin", "Scenario Designer"],
        "modes": {"analyst": analyst["mode"], "designer": designer["mode"]},
        "business_summary": analyst["output"]["findings"],
        "assumptions_to_verify": [{"message": i["message"], "path": i["path"], "fix": i.get("fix")} for i in to_verify][:12],
        "proposed_scenarios": designer["output"]["proposals"],
        "proposed_config": {"mode": "monte_carlo", "runs": 400, "horizon_days": 90},
        "success_criteria": {
            "target_monthly_operating_profit": spec["goals"].get("target_monthly_operating_profit"),
            "min_cash_floor": spec["finance"].get("min_cash_buffer"),
            "max_investment": spec["goals"].get("max_investment_budget"),
        },
        "questions": [
            "Which of the proposed scenarios matter most to you? Remove any you do not need.",
            "Is the minimum cash buffer the lowest balance you are comfortable with?",
            "Are there costs the model is missing (loan repayments, owner's pay, taxes)?",
        ],
        "notes": analyst["notes"] + designer["notes"],
    }
