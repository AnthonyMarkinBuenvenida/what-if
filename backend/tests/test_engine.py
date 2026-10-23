"""Known input/output cases for the simulation engine."""
import math
import threading

import numpy as np
import pytest

from app.domain.retail import grocery_template, validate_spec
from app.engine.analysis import (calibrate_spec, combine_levers, compare_actuals, compare_runs, explain_difference,
                                 run_sensitivity, run_stress_test)
from app.engine.simulation import SimulationCancelled, default_criteria, simulate

DET = {"mode": "deterministic", "horizon_days": 30}


def one_product(**over):
    p = {"id": "p", "name": "Widget", "price": 5.0, "unit_cost": 3.0, "avg_daily_demand": 10.0, "demand_cv": 0.0,
         "starting_inventory": 1000, "shelf_life_days": None, "reorder_point": 0, "order_quantity": 0,
         "lead_time_days": 2, "price_elasticity": -1.0}
    p.update(over.pop("product", {}))
    spec = {"products": [p], "expenses": [{"id": "rent", "name": "Rent", "category": "rent", "amount": 300, "frequency": "monthly"}],
            "staff": [], "operations": {"storage_capacity_units": 0, "units_per_labor_hour": 0},
            "finance": {"starting_cash": 10000, "min_cash_buffer": 0}, "goals": {}, "uncertainty": {"demand_level_pct": 0, "supplier_cost_pct": 0}}
    spec.update(over)
    return spec


def S(res, key):
    return res["summary"][key]["mean"]


def test_simple_accounting_identities():
    res = simulate(one_product(), {}, DET)
    assert S(res, "units_sold") == pytest.approx(300)
    assert S(res, "revenue") == pytest.approx(1500)
    assert S(res, "cogs") == pytest.approx(900)
    assert S(res, "gross_profit") == pytest.approx(600)
    assert S(res, "operating_expenses") == pytest.approx(300)
    assert S(res, "operating_profit") == pytest.approx(300)
    assert S(res, "ending_inventory_units") == pytest.approx(700)
    # Rent for the month is paid on day 1; revenue arrives daily.
    assert S(res, "ending_cash") == pytest.approx(10000 + 1500 - 300)
    assert S(res, "min_cash") == pytest.approx(10000 - 300 + 50)


def test_stockout_and_lost_sales():
    res = simulate(one_product(product={"starting_inventory": 100}), {}, DET)
    assert S(res, "units_sold") == pytest.approx(100)
    assert S(res, "lost_sales_units") == pytest.approx(200)
    assert S(res, "fill_rate") == pytest.approx(1 / 3)
    assert res["summary"]["stockout_rate"]["mean"] == pytest.approx(20 / 30)


def test_perishable_expiry_is_waste():
    res = simulate(one_product(product={"starting_inventory": 100, "shelf_life_days": 5}), {}, DET)
    # Days 1-5 sell 10/day; the remaining 50 units expire at the start of day 6.
    assert S(res, "units_sold") == pytest.approx(50)
    assert S(res, "waste_units") == pytest.approx(50)
    assert S(res, "waste_cost") == pytest.approx(150)
    assert S(res, "gross_profit") == pytest.approx(50 * 5 - 50 * 3 - 150)
    assert S(res, "waste_rate") == pytest.approx(0.5)


def test_fifo_sells_oldest_first():
    # Hand trace (demand 10/day, shelf life 3, order 100 when stock+on-order <= 25, lead 1 day):
    # d1 sell 10 of the 30 old units, order 100 | d2 receive 100, sell 10 old | d3 sell last 10 old
    # d4 sell 10 new | d5 the 90 remaining new units reach age 3 and expire, stockout, reorder
    # d6 receive 100, sell 10 | d7 sell 10  -> sold 60, wasted 90, ending 80.
    # Selling oldest first means none of the original 30 units expire.
    spec = one_product(product={"starting_inventory": 30, "shelf_life_days": 3, "reorder_point": 25, "order_quantity": 100, "lead_time_days": 1})
    res = simulate(spec, {}, {"mode": "deterministic", "horizon_days": 7})
    assert S(res, "units_sold") == pytest.approx(60)
    assert S(res, "waste_units") == pytest.approx(90)
    assert S(res, "ending_inventory_units") == pytest.approx(80)
    assert res["summary"]["stockout_rate"]["mean"] == pytest.approx(1 / 7)


def test_reorder_lead_time_and_inventory_balance():
    spec = one_product(product={"starting_inventory": 50, "reorder_point": 20, "order_quantity": 100, "lead_time_days": 2})
    res = simulate(spec, {}, DET)
    sold, recv, waste, end = (S(res, k) for k in ("units_sold", "units_received", "waste_units", "ending_inventory_units"))
    assert 50 + recv - sold - waste == pytest.approx(end)
    assert S(res, "purchases_paid") > 0
    # Cash identity: start + money in - purchases - recurring bills - one-time costs.
    expected_cash = 10000 + S(res, "revenue") - S(res, "purchases_paid") - S(res, "operating_cash_paid") - S(res, "one_time_costs")
    assert S(res, "ending_cash") == pytest.approx(expected_cash)


def test_identities_hold_in_monte_carlo_with_perishables_and_delivery():
    spec = grocery_template()
    levers = {"delivery": {"enabled": True, "orders_per_day": 20, "units_per_order": 5, "fee_per_order": 4, "cost_per_order": 6,
                           "fixed_monthly_cost": 300, "setup_cost": 2000, "cannibalization_pct": 30},
              "unexpected_expense": 1500, "unexpected_expense_day": 10}
    res = simulate(spec, levers, {"mode": "monte_carlo", "runs": 200, "horizon_days": 60, "seed": 3})
    start_units = sum(p["starting_inventory"] for p in spec["products"])
    m = res["summary"]
    lhs = start_units + m["units_received"]["mean"] - m["units_sold"]["mean"] - m["waste_units"]["mean"]
    assert lhs == pytest.approx(m["ending_inventory_units"]["mean"], rel=1e-9)
    cash = spec["finance"]["starting_cash"] + m["revenue"]["mean"] - m["purchases_paid"]["mean"] - m["operating_cash_paid"]["mean"] - m["one_time_costs"]["mean"]
    assert cash == pytest.approx(m["ending_cash"]["mean"], rel=1e-9)
    assert m["one_time_costs"]["mean"] == pytest.approx(3500)
    assert m["gross_profit"]["mean"] == pytest.approx(m["revenue"]["mean"] - m["cogs"]["mean"] - m["waste_cost"]["mean"])
    assert m["operating_profit"]["mean"] == pytest.approx(m["gross_profit"]["mean"] - m["operating_expenses"]["mean"])


def test_price_elasticity():
    res = simulate(one_product(), {"price_change_pct": 10}, DET)
    assert S(res, "units_sold") == pytest.approx(300 / 1.1)
    assert S(res, "revenue") == pytest.approx(300 / 1.1 * 5.5)


def test_storage_capacity_limits_orders():
    spec = one_product(product={"starting_inventory": 50, "reorder_point": 40, "order_quantity": 500, "lead_time_days": 1},
                       operations={"storage_capacity_units": 200, "units_per_labor_hour": 0})
    res = simulate(spec, {}, DET)
    assert max(res["series"]["inventory_units"]["mean"]) <= 200 + 1e-6
    assert S(res, "storage_limited_orders") > 0


def test_cash_limits_purchases():
    spec = one_product(product={"starting_inventory": 0, "reorder_point": 10, "order_quantity": 1000, "lead_time_days": 1},
                       finance={"starting_cash": 600, "min_cash_buffer": 0}, expenses=[])
    res = simulate(spec, {}, DET)
    assert S(res, "cash_limited_orders") >= 1
    assert res["summary"]["min_cash"]["min"] >= -1e-6  # purchases never push cash below zero


def test_labor_capacity_caps_sales():
    spec = one_product(staff=[{"id": "s", "role": "Clerk", "count": 1, "hourly_wage": 10, "hours_per_week": 7}],
                       operations={"storage_capacity_units": 0, "units_per_labor_hour": 5, "open_days_per_week": 7})
    res = simulate(spec, {}, DET)  # 1 h/day × 5 units/h = 5 units/day < demand 10
    assert S(res, "units_sold") == pytest.approx(150)
    assert res["summary"]["capacity_limited_day_share"]["mean"] == pytest.approx(1.0)
    assert S(res, "labor_cost") == pytest.approx(70 / 7 * 30)


def test_constraints_enforced_and_outcome():
    spec = one_product(finance={"starting_cash": 100, "min_cash_buffer": 50})
    res = simulate(spec, {"one_time_investment": 5000}, DET,
                   {"min_cash_floor": 50, "target_monthly_operating_profit": 1000, "max_investment": 1000})
    by = {c["key"]: c for c in res["constraints"]}
    assert by["cash_floor"]["violated"]
    assert by["profit_target"]["violated"]
    assert by["budget"]["violated"]
    assert res["outcome"] == "failed_constraints"
    ok = simulate(one_product(), {}, DET, {"min_cash_floor": 0, "target_monthly_operating_profit": 100})
    assert ok["outcome"] == "passed"
    assert not any(c["violated"] for c in ok["constraints"])


def test_monte_carlo_is_reproducible_and_seeded():
    spec = grocery_template()
    a = simulate(spec, {}, {"mode": "monte_carlo", "runs": 100, "horizon_days": 30, "seed": 42})
    b = simulate(spec, {}, {"mode": "monte_carlo", "runs": 100, "horizon_days": 30, "seed": 42})
    c = simulate(spec, {}, {"mode": "monte_carlo", "runs": 100, "horizon_days": 30, "seed": 43})
    assert a["summary"] == b["summary"]
    assert a["summary"]["revenue"]["mean"] != c["summary"]["revenue"]["mean"]
    assert a["summary"]["revenue"]["p10"] < a["summary"]["revenue"]["p90"]


def test_probabilities_are_shares_of_runs():
    spec = grocery_template()
    res = simulate(spec, {}, {"mode": "monte_carlo", "runs": 200, "horizon_days": 30, "seed": 1}, {"target_monthly_operating_profit": 4500})
    p = res["probabilities"]["meets_profit_target"]
    assert 0 <= p <= 1 and (p * 200) == pytest.approx(round(p * 200))


def test_cancel():
    ev = threading.Event()
    ev.set()
    with pytest.raises(SimulationCancelled):
        simulate(grocery_template(), {}, {"runs": 50, "horizon_days": 30}, cancel=ev)


def test_stress_test_common_random_numbers_and_direction():
    spec = grocery_template()
    res = run_stress_test(spec, {}, {"runs": 100, "horizon_days": 30, "seed": 5}, default_criteria(spec), ["demand_drop", "supplier_increase"])
    rows = {r["key"]: r for r in res["rows"]}
    assert set(rows) == {"unstressed", "demand_drop", "supplier_increase", "combined"}
    assert rows["demand_drop"]["delta"]["monthly_operating_profit"] < 0
    assert rows["supplier_increase"]["delta"]["monthly_operating_profit"] < 0
    assert rows["combined"]["delta"]["monthly_operating_profit"] < rows["demand_drop"]["delta"]["monthly_operating_profit"]
    with pytest.raises(ValueError):
        run_stress_test(spec, {}, {}, {}, [])


def test_combine_levers_adds_percentages():
    c = combine_levers({"demand_change_pct": -10}, {"demand_change_pct": -20, "lead_time_change_days": 2})
    assert c["demand_change_pct"] == -30 and c["lead_time_change_days"] == 2


def test_sensitivity_orders_by_impact():
    spec = grocery_template()
    res = run_sensitivity(spec, {}, {"horizon_days": 30}, default_criteria(spec))
    impacts = [max(abs(r["profit_low"]), abs(r["profit_high"])) for r in res["rows"]]
    assert impacts == sorted(impacts, reverse=True)
    demand = next(r for r in res["rows"] if r["key"] == "demand")
    assert demand["profit_low"] < 0 < demand["profit_high"]


def test_difference_drivers_sum_to_total():
    spec = grocery_template()
    cfg = {"mode": "deterministic", "horizon_days": 60}
    base = simulate(spec, {}, cfg)
    alt = simulate(spec, {"price_change_pct": 5, "supplier_cost_change_pct": 3}, cfg)
    ex = explain_difference(base, alt)
    assert sum(d["monthly_effect"] for d in ex["drivers"]) == pytest.approx(ex["monthly_operating_profit_change"], abs=7)


def test_compare_runs_and_actuals():
    spec = grocery_template()
    cfg = {"mode": "deterministic", "horizon_days": 30, "start_date": "2026-01-01"}
    r1 = {"id": 1, "scenario_name": "Base", "color_index": 0, "model_version_id": 1, "results": simulate(spec, {}, cfg)}
    r2 = {"id": 2, "scenario_name": "Price", "color_index": 1, "model_version_id": 1, "results": simulate(spec, {"price_change_pct": 4}, cfg)}
    cmp = compare_runs([r1, r2])
    assert cmp["comparable"] and cmp["same_model_version"] and len(cmp["explanations"]) == 1
    from datetime import date
    pred_rev = sum(r1["results"]["daily_expected"]["revenue"][0:7])
    out = compare_actuals(r1, date(2026, 1, 1), date(2026, 1, 7), date(2026, 1, 1), {"revenue": pred_rev * 1.2})
    assert out["errors"]["revenue"]["pct"] == pytest.approx(0.2)
    assert out["demand_scale_suggestion"] == pytest.approx(1.2, rel=1e-3)
    with pytest.raises(ValueError):
        compare_actuals(r1, date(2025, 12, 1), date(2025, 12, 7), date(2026, 1, 1), {"revenue": 1})
    new_spec, changes = calibrate_spec(spec, 1.2, "test")
    assert new_spec["products"][0]["avg_daily_demand"] == pytest.approx(spec["products"][0]["avg_daily_demand"] * 1.2)
    assert new_spec["provenance"]["products.produce.avg_daily_demand"] == "calibrated"
    assert spec["provenance"]["products.produce.avg_daily_demand"] == "default"  # original untouched


def test_validation_rules():
    spec = one_product(product={"price": 2.0, "unit_cost": 3.0})
    v = validate_spec(spec)
    assert any(i["code"] == "price_below_cost" for i in v["issues"])
    assert v["status"] == "exploratory"
    bad = validate_spec(one_product(product={"starting_inventory": -5}))
    assert bad["status"] == "invalid" and any(i["code"] == "negative_inventory" for i in bad["issues"])
    empty = validate_spec({"products": []})
    assert empty["status"] == "invalid"
    short = validate_spec(one_product(), sales_history_days=10)
    assert any(i["code"] == "short_history" for i in short["issues"])
    tmpl = validate_spec(grocery_template())
    assert tmpl["status"] == "exploratory" and any(i["code"] == "demand_is_default" for i in tmpl["issues"])
