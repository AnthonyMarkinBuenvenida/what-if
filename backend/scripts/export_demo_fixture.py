"""Export the sample store, world templates and reference engine outputs for the
frontend's fallback engine and its parity test.

    python -m scripts.export_demo_fixture
"""
import json
from pathlib import Path

from app.demo import GOALS, demo_criteria, demo_scenarios, demo_spec
from app.engine.analysis import combine_levers
from app.engine.simulation import default_criteria, simulate

OUT = Path(__file__).resolve().parents[2] / "frontend" / "src" / "demo" / "sample.json"
KEYS = ["revenue", "sales_revenue", "delivery_revenue", "cogs", "waste_cost", "gross_profit", "labor_cost",
        "recurring_expenses", "delivery_costs", "operating_expenses", "operating_profit", "avg_monthly_operating_profit",
        "one_time_costs", "ending_cash", "min_cash", "units_sold", "units_demanded", "waste_units", "fill_rate",
        "waste_rate", "stockout_rate", "ending_inventory_units", "ending_inventory_value", "purchases_paid", "labor_utilization"]


def main():
    spec = demo_spec()
    crit = default_criteria(spec)
    scenarios = demo_scenarios()
    cases = []
    for extra, budget in (({}, None), ({"demand_change_pct": -20}, None), ({"supplier_cost_change_pct": 12, "staff_hours_change_pct": -25}, None),
                          ({"demand_change_pct": 10, "supplier_cost_change_pct": 6}, 2000.0)):
        c = demo_criteria(budget)
        for sc in scenarios:
            levers = combine_levers(sc["levers"], extra) if extra else sc["levers"]
            res = simulate(spec, levers, {"mode": "deterministic", "horizon_days": 90}, c)
            cases.append({"scenario": sc["id"], "extra": extra, "budget": budget,
                          "expected": {k: res["summary"][k]["mean"] for k in KEYS},
                          "outcome": res["outcome"], "violations": [c["key"] for c in res["constraints"] if c["violated"]]})
    OUT.write_text(json.dumps({"spec": spec, "criteria": crit, "scenarios": scenarios, "goals": GOALS, "parity_cases": cases}, indent=1), encoding="utf-8")
    print(f"wrote {OUT} ({len(cases)} parity cases)")


if __name__ == "__main__":
    main()
