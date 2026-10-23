"""Analyses built on top of the simulation engine.

Everything here is computed from engine output. Explanations are produced by
arithmetic decomposition (which line items changed and by how much), so they
can be checked against the numbers they describe.
"""
from __future__ import annotations

import copy
from datetime import date

from .simulation import merge_config, merge_levers, simulate

# Adverse shocks a user can apply on top of any scenario.
STRESS_SHOCKS: dict[str, dict] = {
    "demand_drop": {"label": "Demand falls 20%", "levers": {"demand_change_pct": -20}},
    "supplier_increase": {"label": "Supplier prices rise 12%", "levers": {"supplier_cost_change_pct": 12}},
    "delivery_delays": {"label": "Supplier deliveries 3 days late", "levers": {"lead_time_change_days": 3}},
    "supply_disruption": {"label": "30% of orders delayed a week", "levers": {"supply_disruption_prob": 0.3, "disruption_delay_days": 7}},
    "staff_shortage": {"label": "25% fewer staff hours", "levers": {"staff_hours_change_pct": -25}},
    "rent_increase": {"label": "Rent rises 15%", "levers": {"rent_change_pct": 15}},
    "expense_increase": {"label": "All operating expenses rise 10%", "levers": {"expense_change_pct": 10}},
    "faster_spoilage": {"label": "Perishables spoil 30% faster", "levers": {"shelf_life_change_pct": -30}},
    "unexpected_bill": {"label": "$6,000 unexpected bill on day 20", "levers": {"unexpected_expense": 6000, "unexpected_expense_day": 19}},
    "cash_reserve_cut": {"label": "Start with $15,000 less cash", "levers": {"starting_cash_change": -15000}},
}

ADDITIVE_KEYS = {
    "demand_change_pct", "supplier_cost_change_pct", "lead_time_change_days", "staff_hours_change_pct",
    "rent_change_pct", "expense_change_pct", "shelf_life_change_pct", "unexpected_expense", "starting_cash_change",
    "one_time_investment", "price_change_pct", "order_quantity_change_pct", "reorder_point_change_pct",
    "storage_capacity_change_pct",
}


def combine_levers(base: dict, extra: dict) -> dict:
    """Stack a shock on top of a scenario's own levers (percentages add)."""
    out = merge_levers(base)
    for k, v in extra.items():
        if k in ADDITIVE_KEYS and isinstance(v, (int, float)):
            out[k] = float(out.get(k) or 0) + float(v)
        elif k == "delivery" and isinstance(v, dict):
            out["delivery"].update(v)
        else:
            out[k] = v
    return out


def custom_shock_levers(custom: dict) -> dict:
    """Validate user-specified stress amounts from the UI."""
    allowed = {
        "demand_change_pct": (-90, 100), "supplier_cost_change_pct": (-50, 200), "lead_time_change_days": (0, 30),
        "staff_hours_change_pct": (-90, 100), "rent_change_pct": (-50, 300), "expense_change_pct": (-50, 300),
        "shelf_life_change_pct": (-90, 100), "unexpected_expense": (0, 1_000_000), "starting_cash_change": (-1_000_000, 1_000_000),
    }
    out = {}
    for k, v in (custom or {}).items():
        if k not in allowed or v in (None, ""):
            continue
        lo, hi = allowed[k]
        out[k] = min(hi, max(lo, float(v)))
    return out


KEY_METRICS = ("avg_monthly_operating_profit", "revenue", "operating_profit", "min_cash", "ending_cash", "fill_rate", "waste_rate", "stockout_rate")


def _headline(res: dict) -> dict:
    S = res["summary"]
    return {
        "monthly_operating_profit": S["avg_monthly_operating_profit"],
        "revenue": S["revenue"]["mean"],
        "min_cash_p10": S["min_cash"]["p10"],
        "min_cash_mean": S["min_cash"]["mean"],
        "ending_cash": S["ending_cash"]["mean"],
        "fill_rate": S["fill_rate"]["mean"],
        "waste_rate": S["waste_rate"]["mean"],
        "cash_below_zero": res["probabilities"]["cash_below_zero"],
        "cash_below_buffer": res["probabilities"]["cash_below_buffer"],
        "meets_profit_target": res["probabilities"]["meets_profit_target"],
        "outcome": res["outcome"],
        "violations": [c["label"] for c in res["constraints"] if c["violated"]],
    }


def run_stress_test(spec: dict, levers: dict, config: dict, criteria: dict, shock_keys: list[str],
                    custom: dict | None = None, progress=None, cancel=None) -> dict:
    """Run the scenario unstressed, under each shock alone, and under all together.

    All runs share one seed (common random numbers), so differences come from
    the shocks rather than from random noise.
    """
    cfg = merge_config(config)
    shocks = [(k, STRESS_SHOCKS[k]["label"], STRESS_SHOCKS[k]["levers"]) for k in shock_keys if k in STRESS_SHOCKS]
    custom_levers = custom_shock_levers(custom or {})
    if custom_levers:
        shocks.append(("custom", "Custom: " + ", ".join(f"{k.replace('_', ' ')} {v:+g}" for k, v in custom_levers.items()), custom_levers))
    if not shocks:
        raise ValueError("Choose at least one stress condition.")
    plan = [("unstressed", "No added stress", {})] + shocks
    if len(shocks) > 1:
        combined: dict = {}
        for _, _, lv in shocks:
            combined = combine_levers(combined, lv) if combined else merge_levers(lv)
        plan.append(("combined", "All selected conditions together", combined))
    rows = []
    for i, (key, label, shock) in enumerate(plan):
        def sub_progress(frac, stage, i=i):
            if progress:
                progress((i + frac) / len(plan), f"{label}: {stage}")
        res = simulate(spec, combine_levers(levers, shock) if shock else levers, cfg, criteria, sub_progress, cancel)
        rows.append({"key": key, "label": label, "levers": shock, "headline": _headline(res),
                     "series_cash_p10": res["series"]["cash"]["p10"], "series_cash_p50": res["series"]["cash"]["p50"],
                     "constraints": res["constraints"]})
    base = rows[0]["headline"]
    for r in rows:
        h = r["headline"]
        r["delta"] = {
            "monthly_operating_profit": h["monthly_operating_profit"]["mean"] - base["monthly_operating_profit"]["mean"],
            "min_cash_p10": h["min_cash_p10"] - base["min_cash_p10"],
            "cash_below_buffer": h["cash_below_buffer"] - base["cash_below_buffer"],
        }
    survivors = [r["label"] for r in rows[1:] if r["headline"]["outcome"] == "passed"]
    breakers = [r for r in rows[1:] if r["headline"]["violations"]]
    worst = min(rows[1:], key=lambda r: r["delta"]["monthly_operating_profit"])
    return {
        "config": cfg,
        "rows": rows,
        "summary": {
            "conditions_tested": len(rows) - 1,
            "conditions_passed": len(survivors),
            "largest_profit_impact": {"label": worst["label"], "monthly_change": worst["delta"]["monthly_operating_profit"]},
            "breaking_conditions": [{"label": r["label"], "violations": r["headline"]["violations"]} for r in breakers],
        },
    }


SENSITIVITY_PARAMS: list[tuple[str, str, dict, dict]] = [
    ("demand", "Customer demand ±15%", {"demand_change_pct": -15}, {"demand_change_pct": 15}),
    ("price", "Selling prices ±5%", {"price_change_pct": -5}, {"price_change_pct": 5}),
    ("supplier", "Supplier prices ±10%", {"supplier_cost_change_pct": 10}, {"supplier_cost_change_pct": -10}),
    ("expenses", "Operating expenses ±10%", {"expense_change_pct": 10}, {"expense_change_pct": -10}),
    ("staff", "Staff hours ±20%", {"staff_hours_change_pct": -20}, {"staff_hours_change_pct": 20}),
    ("lead", "Supplier lead time +3 / −1 days", {"lead_time_change_days": 3}, {"lead_time_change_days": -1}),
    ("shelf", "Perishable shelf life ±30%", {"shelf_life_change_pct": -30}, {"shelf_life_change_pct": 30}),
    ("order", "Order quantity ±25%", {"order_quantity_change_pct": -25}, {"order_quantity_change_pct": 25}),
]


def run_sensitivity(spec: dict, levers: dict, config: dict, criteria: dict, progress=None, cancel=None) -> dict:
    """One-at-a-time sensitivity on expected (deterministic) outcomes.

    Each assumption is moved down and up while everything else stays fixed.
    Deterministic mode isolates the effect of the assumption itself.
    """
    cfg = {**merge_config(config), "mode": "deterministic"}
    base = simulate(spec, levers, cfg, criteria)
    b_profit = base["summary"]["avg_monthly_operating_profit"]["mean"]
    b_cash = base["summary"]["min_cash"]["mean"]
    rows = []
    for i, (key, label, low, high) in enumerate(SENSITIVITY_PARAMS):
        if cancel is not None and cancel.is_set():
            from .simulation import SimulationCancelled
            raise SimulationCancelled()
        lo = simulate(spec, combine_levers(levers, low), cfg, criteria)
        hi = simulate(spec, combine_levers(levers, high), cfg, criteria)
        rows.append({
            "key": key, "label": label,
            "profit_low": lo["summary"]["avg_monthly_operating_profit"]["mean"] - b_profit,
            "profit_high": hi["summary"]["avg_monthly_operating_profit"]["mean"] - b_profit,
            "cash_low": lo["summary"]["min_cash"]["mean"] - b_cash,
            "cash_high": hi["summary"]["min_cash"]["mean"] - b_cash,
        })
        if progress:
            progress((i + 1) / len(SENSITIVITY_PARAMS), label)
    rows.sort(key=lambda r: -max(abs(r["profit_low"]), abs(r["profit_high"])))
    return {"baseline_monthly_operating_profit": b_profit, "baseline_min_cash": b_cash, "rows": rows,
            "method": "One-at-a-time changes on a deterministic run (expected inputs); other assumptions fixed."}


DRIVERS = [
    ("sales_revenue", "Store sales revenue", +1),
    ("delivery_revenue", "Delivery fees", +1),
    ("cogs", "Cost of goods sold", -1),
    ("waste_cost", "Expired stock written off", -1),
    ("labor_cost", "Labor", -1),
    ("recurring_expenses", "Rent and other recurring expenses", -1),
    ("delivery_costs", "Delivery costs", -1),
]


def explain_difference(base: dict, alt: dict) -> dict:
    """Decompose the change in operating profit into line items (mean values)."""
    bs, as_ = base["summary"], alt["summary"]
    months = base["config"]["horizon_days"] / 30.0
    items = []
    for key, label, sign in DRIVERS:
        delta = (as_[key]["mean"] - bs[key]["mean"]) * sign / months
        if abs(delta) >= 1:
            items.append({"key": key, "label": label, "monthly_effect": delta})
    items.sort(key=lambda x: -abs(x["monthly_effect"]))
    total = (as_["operating_profit"]["mean"] - bs["operating_profit"]["mean"]) / months
    notes = []
    d_fill = as_["fill_rate"]["mean"] - bs["fill_rate"]["mean"]
    if abs(d_fill) >= 0.01:
        notes.append(f"Share of demand served changes from {bs['fill_rate']['mean']:.1%} to {as_['fill_rate']['mean']:.1%}.")
    d_waste = as_["waste_rate"]["mean"] - bs["waste_rate"]["mean"]
    if abs(d_waste) >= 0.005:
        notes.append(f"Waste changes from {bs['waste_rate']['mean']:.1%} to {as_['waste_rate']['mean']:.1%} of units.")
    if as_["capacity_limited_day_share"]["mean"] - bs["capacity_limited_day_share"]["mean"] > 0.05:
        notes.append(f"Staff capacity limits sales on {as_['capacity_limited_day_share']['mean']:.0%} of days (baseline {bs['capacity_limited_day_share']['mean']:.0%}).")
    d_one = as_["one_time_costs"]["mean"] - bs["one_time_costs"]["mean"]
    if abs(d_one) >= 1:
        notes.append(f"One-time costs differ by ${d_one:,.0f}; these reduce cash but are excluded from operating profit.")
    d_inv = as_["ending_inventory_value"]["mean"] - bs["ending_inventory_value"]["mean"]
    if abs(d_inv) >= 500:
        notes.append(f"Ending inventory value differs by ${d_inv:,.0f}, which ties up (or frees) cash without affecting profit.")
    return {"monthly_operating_profit_change": total, "drivers": items, "notes": notes,
            "check": "Driver effects sum to the change in operating profit."}


def compare_runs(runs: list[dict]) -> dict:
    """Side-by-side table; runs[0] is treated as the reference (usually Baseline)."""
    if not runs:
        return {"rows": [], "explanations": []}
    ref = runs[0]
    table = []
    for r in runs:
        res = r["results"]
        S, P = res["summary"], res["probabilities"]
        table.append({
            "run_id": r["id"], "scenario_name": r["scenario_name"], "color_index": r["color_index"],
            "model_version_id": r["model_version_id"], "mode": res["config"]["mode"], "runs": res["config"]["runs"],
            "horizon_days": res["config"]["horizon_days"],
            "revenue": S["revenue"], "operating_profit": S["operating_profit"],
            "avg_monthly_operating_profit": S["avg_monthly_operating_profit"], "gross_profit": S["gross_profit"],
            "operating_expenses": S["operating_expenses"], "cogs": S["cogs"], "waste_cost": S["waste_cost"],
            "one_time_costs": S["one_time_costs"], "ending_cash": S["ending_cash"], "min_cash": S["min_cash"],
            "fill_rate": S["fill_rate"], "waste_rate": S["waste_rate"], "stockout_rate": S["stockout_rate"],
            "labor_utilization": S["labor_utilization"], "ending_inventory_value": S["ending_inventory_value"],
            "cash_below_zero": P["cash_below_zero"], "cash_below_buffer": P["cash_below_buffer"],
            "meets_profit_target": P["meets_profit_target"], "outcome": res["outcome"],
            "violations": [c["label"] for c in res["constraints"] if c["violated"]],
            "series": {"cash": res["series"]["cash"], "cumulative_operating_profit": res["series"]["cumulative_operating_profit"],
                       "revenue": res["series"]["revenue"], "inventory_units": res["series"]["inventory_units"]},
        })
    explanations = []
    for r in runs[1:]:
        if r["results"]["config"]["horizon_days"] != ref["results"]["config"]["horizon_days"]:
            explanations.append({"run_id": r["id"], "scenario_name": r["scenario_name"], "error": "Different horizon from the reference run; not directly comparable."})
            continue
        explanations.append({"run_id": r["id"], "scenario_name": r["scenario_name"], **explain_difference(ref["results"], r["results"])})
    comparable = len({(r["results"]["config"]["horizon_days"], r["results"]["config"]["mode"]) for r in runs}) == 1
    same_model = len({r["model_version_id"] for r in runs}) == 1
    return {"reference_run_id": ref["id"], "rows": table, "explanations": explanations,
            "comparable": comparable, "same_model_version": same_model}


def rank_strategies(rows: list[dict], risk_tolerance: str = "medium") -> list[dict]:
    """Order options by resilience first, then profit.

    A scenario that violates a constraint is never ranked above one that does
    not, however profitable it is.
    """
    def key(r):
        return (1 if r["violations"] else 0, r["cash_below_buffer"], -r["avg_monthly_operating_profit"]["p50"])
    return sorted(rows, key=key)


def compare_actuals(run: dict, period_start: date, period_end: date, sim_start: date, actual: dict) -> dict:
    """Compare recorded actual results with the run's expected path over the same days."""
    res = run["results"]
    H = res["config"]["horizon_days"]
    s = (period_start - sim_start).days
    e = (period_end - sim_start).days
    if s < 0 or e >= H or e < s:
        raise ValueError(f"The period must fall inside the simulated window ({sim_start.isoformat()} plus {H} days).")
    de = res["daily_expected"]
    pred = {
        "revenue": float(sum(de["revenue"][s:e + 1])),
        "costs": float(sum(de["costs"][s:e + 1])),
        "units_sold": float(sum(de["units_sold"][s:e + 1])),
        "demand": float(sum(de["demand"][s:e + 1])),
    }
    out = {"days": e - s + 1, "predicted": pred, "actual": {}, "errors": {}, "explanations": []}
    for k in ("revenue", "costs", "units_sold"):
        if actual.get(k) is None:
            continue
        a = float(actual[k])
        out["actual"][k] = a
        out["errors"][k] = {"absolute": a - pred[k], "pct": (a - pred[k]) / pred[k] if pred[k] else None}
    ratio = None
    if "units_sold" in out["actual"] and pred["units_sold"]:
        ratio = out["actual"]["units_sold"] / pred["units_sold"]
        basis = "units sold"
    elif "revenue" in out["actual"] and pred["revenue"]:
        ratio = out["actual"]["revenue"] / pred["revenue"]
        basis = "revenue"
    if ratio is not None:
        if abs(ratio - 1) > 0.05:
            direction = "higher" if ratio > 1 else "lower"
            out["explanations"].append(f"Observed {basis} was {abs(ratio - 1):.0%} {direction} than expected. If prices were unchanged, customer demand in the model is likely {'too low' if ratio > 1 else 'too high'}.")
        out["demand_scale_suggestion"] = round(ratio, 4)
    if "costs" in out["actual"] and pred["costs"]:
        c_ratio = out["actual"]["costs"] / pred["costs"]
        if abs(c_ratio - 1) > 0.05:
            out["explanations"].append(f"Recorded costs were {abs(c_ratio - 1):.0%} {'higher' if c_ratio > 1 else 'lower'} than the model expected. Check supplier prices, wages and recurring expenses, or costs the model does not include.")
    out["explanations"].append("A single period is a small sample; normal day-to-day variation can explain part of any gap.")
    return out


def calibrate_spec(spec: dict, demand_scale: float, note: str) -> tuple[dict, list[str]]:
    """Apply an approved demand calibration to a copy of the spec."""
    new = copy.deepcopy(spec)
    changes = []
    for p in new.get("products", []):
        old = float(p["avg_daily_demand"])
        p["avg_daily_demand"] = round(old * demand_scale, 3)
        new.setdefault("provenance", {})[f"products.{p['id']}.avg_daily_demand"] = "calibrated"
        changes.append(f"{p['name']}: demand {old:g} → {p['avg_daily_demand']:g} units/day")
    new.setdefault("calibration_log", []).append({"note": note, "demand_scale": demand_scale})
    return new, changes
