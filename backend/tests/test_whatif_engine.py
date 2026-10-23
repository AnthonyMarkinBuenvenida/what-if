"""What-if engine: formulas, edge cases and traceability (no network, no AI)."""
import math

import pytest
from pydantic import ValidationError

from app.whatif import engine
from app.whatif.industries import INDUSTRIES, template
from app.whatif.schemas import Levers, Profile
from app.whatif.service import demo_profile


def simple(**over) -> Profile:
    """One product, flat seasonality, no tax: easy to check by hand."""
    spec = {
        "industry": "retail", "business": {"name": "Hand check", "currency": "USD"},
        "products": [{"id": "a", "name": "A", "price": 10, "unit_cost": 4, "monthly_units": 1000, "elasticity": -1.5}],
        "staff": [{"role": "Clerk", "count": 2, "monthly_wage": 1000}],
        "fixed_costs": [{"name": "Rent", "category": "rent", "monthly_amount": 2000}, {"name": "Power", "category": "utilities", "monthly_amount": 500}],
        "marketing": {"monthly_budget": 500, "elasticity": 0.1},
        "finance": {"starting_cash": 10000, "tax_rate_pct": 0},
    }
    for k, v in over.items():
        spec[k] = v
    return Profile.model_validate(spec)


def month1(profile, **lv):
    return engine.project(profile, Levers(horizon_months=1, start_month="2027-01", **lv))["months"][0]


def test_baseline_formulas():
    m = month1(simple())
    assert m["revenue"] == pytest.approx(10_000)
    assert m["variable_costs"] == pytest.approx(4_000)
    assert m["gross_profit"] == pytest.approx(6_000)
    assert m["operating_expenses"] == pytest.approx(2 * 1000 + 2000 + 500 + 500)
    assert m["net_profit"] == pytest.approx(6_000 - 5_000)
    pr = engine.project(simple(), Levers(horizon_months=1, start_month="2027-01"))
    assert pr["metrics"]["net_margin"] == pytest.approx(1_000 / 10_000)
    assert pr["metrics"]["break_even_units"] == pytest.approx(5_000 / 6)  # fixed costs / (price - unit cost)


def test_lower_price_follows_the_demand_model():
    m = month1(simple(), price_change_pct=-10)
    q = 1000 * 0.9 ** -1.5
    assert m["units"] == pytest.approx(q)
    assert m["revenue"] == pytest.approx(9 * q)
    assert m["net_profit"] == pytest.approx(9 * q - 4 * q - 5000)


def test_lower_price_does_not_always_increase_sales():
    m = month1(simple(), price_change_pct=-10, elasticity_override=0)
    assert m["units"] == pytest.approx(1000)  # no price response: same volume, less revenue
    assert m["revenue"] == pytest.approx(9000)


def test_higher_ingredient_costs_reduce_profit():
    base, up = month1(simple()), month1(simple(), unit_cost_change_pct=15)
    assert up["variable_costs"] == pytest.approx(4.6 * 1000)
    assert up["net_profit"] == pytest.approx(base["net_profit"] - 600)
    assert up["units"] == pytest.approx(base["units"])  # costs alone do not move demand


def test_lower_sales_updates_revenue_and_break_even_check():
    p = simple()
    pr = engine.project(p, Levers(horizon_months=1, start_month="2027-01", demand_change_pct=-20))
    assert pr["months"][0]["revenue"] == pytest.approx(8000)
    be = pr["metrics"]["break_even_units"]
    assert be == pytest.approx(5000 / 6)  # break-even depends on costs, not on volume
    assert pr["metrics"]["safety_margin"] == pytest.approx((800 - be) / 800)


def test_multiple_changes_in_one_scenario():
    m = month1(simple(), price_change_pct=5, unit_cost_change_pct=-8, rent_change_pct=10, staff_changes=[{"role": "Clerk", "count": 1}])
    q = 1000 * 1.05 ** -1.5
    expected = 10.5 * q - 4 * 0.92 * q - (3 * 1000 + 2200 + 500 + 500)
    assert m["net_profit"] == pytest.approx(expected)


def test_reset_restores_the_baseline():
    p = simple()
    lv = Levers(horizon_months=6, start_month="2027-01")
    assert lv.is_baseline()
    sim = engine.simulate(p, lv)
    assert sim["is_baseline"]
    assert sim["scenario"]["totals"] == sim["baseline"]["totals"]
    assert sim["bridge"] == []


def test_zero_revenue_has_no_margin_instead_of_an_error():
    p = simple(products=[{"name": "A", "price": 10, "unit_cost": 4, "monthly_units": 0}])
    pr = engine.project(p, Levers(horizon_months=3))
    assert pr["metrics"]["net_margin"] is None
    assert "zero_revenue" in pr["flags"]
    assert all(math.isfinite(m["net_profit"]) for m in pr["months"])


def test_negative_contribution_has_no_break_even():
    pr = engine.project(simple(), Levers(horizon_months=1, unit_cost_change_pct=200))
    assert pr["metrics"]["contribution_per_unit"] < 0
    assert pr["metrics"]["break_even_units"] is None
    assert "no_break_even" in pr["flags"]


def test_invalid_inputs_are_rejected():
    with pytest.raises(ValidationError):
        simple(products=[{"name": "A", "price": -1, "unit_cost": 4, "monthly_units": 10}])
    with pytest.raises(ValidationError):
        Profile.model_validate({**demo_profile(), "growth": {"seasonality": [1.0] * 11}})
    with pytest.raises(ValidationError):
        Levers(price_change_pct=-120)
    with pytest.raises(ValidationError):
        Levers(horizon_months=0)
    with pytest.raises(ValidationError):
        Levers(seasonal=[{"months": [13], "demand_change_pct": 10}])


def test_profit_bridge_adds_up_exactly():
    for lv in ({"price_change_pct": -10}, {"price_change_pct": 7, "unit_cost_change_pct": 12, "marketing_change_pct": 50},
               {"new_product": {"name": "B", "price": 6, "unit_cost": 2, "monthly_units": 300, "cannibalization_pct": 40}},
               {"staff_changes": [{"role": "x", "count": 2, "monthly_wage": 900}], "tax_rate_pct": 20}):
        sim = engine.simulate(simple(), Levers(horizon_months=12, start_month="2027-01", **lv))
        assert sum(b["value"] for b in sim["bridge"]) == pytest.approx(sim["delta"]["net_profit"]["change"], abs=0.02)
        assert all(b["key"] != "other" for b in sim["bridge"])


def test_capacity_caps_sales_and_reports_lost_demand():
    p = simple(operations={"monthly_capacity_units": 900})
    m = month1(p)
    assert m["units"] == pytest.approx(900)
    assert m["lost_units"] == pytest.approx(100)
    staffed = simple(operations={"capacity_per_staff": 400})
    assert month1(staffed)["units"] == pytest.approx(800)  # 2 people x 400
    assert month1(staffed, staff_changes=[{"role": "Clerk", "count": 1}])["units"] == pytest.approx(1000)


def test_inventory_stockouts_and_purchases():
    p = simple(products=[{"name": "A", "price": 10, "unit_cost": 4, "monthly_units": 1000, "stock_units": 200, "restock_units_per_month": 700}])
    m = month1(p)
    # Needs 1000 + 200 target - 200 on hand = 1000, supplier caps at 700 -> 900 available
    assert m["units"] == pytest.approx(900)
    assert m["stockout_units"] == pytest.approx(100)
    assert m["purchases"] == pytest.approx(700 * 4)
    assert m["cash_flow"] == pytest.approx(m["net_profit"] + m["variable_costs"] - m["purchases"])


def test_subscription_churn_dynamics():
    p = simple(products=[{"name": "Plan", "price": 20, "unit_cost": 2, "monthly_units": 100, "elasticity": -0.5}],
               subscription={"enabled": True, "monthly_churn_pct": 10, "new_customers_per_month": 5})
    pr = engine.project(p, Levers(horizon_months=2, start_month="2027-01"))
    s1 = 100 * 0.9 + 5
    s2 = s1 * 0.9 + 5
    assert pr["months"][0]["units"] == pytest.approx(s1)
    assert pr["months"][1]["units"] == pytest.approx(s2)
    worse = engine.project(p, Levers(horizon_months=2, start_month="2027-01", churn_change_pts=5))
    assert worse["months"][1]["units"] < s2


def test_marketing_response_and_floor():
    m = month1(simple(), marketing_change_pct=100)
    assert m["units"] == pytest.approx(1000 * 2 ** 0.1)
    off = month1(simple(), marketing_change_pct=-100)
    assert off["units"] == pytest.approx(1000 * 0.05 ** 0.1)  # spend floored at 5% of today's
    zero = engine.project(simple(marketing={"monthly_budget": 0}), Levers(horizon_months=1, marketing_budget=1000))
    assert "marketing_response_unknown" in zero["flags"]


def test_one_time_spending_hits_cash_not_profit():
    p = simple()
    lv = Levers(horizon_months=3, start_month="2027-01", new_branch={"setup_cost": 8000, "monthly_fixed_cost": 3000, "demand_share_pct": 50, "ramp_months": 2})
    pr = engine.project(p, lv)
    m1 = pr["months"][0]
    assert m1["one_time"] == pytest.approx(8000)
    assert m1["cash_flow"] == pytest.approx(m1["net_profit"] - 8000)
    assert pr["months"][0]["demand_units"] < pr["months"][1]["demand_units"]  # ramp-up


def test_tax_only_on_positive_profit():
    p = simple(finance={"starting_cash": 0, "tax_rate_pct": 25})
    assert month1(p)["tax"] == pytest.approx(0.25 * 1000)
    assert month1(p, demand_change_pct=-50)["tax"] == 0


def test_seasonality_and_seasonal_shifts():
    season = [1.0] * 12
    season[11] = 2.0
    p = simple(growth={"seasonality": season})
    pr = engine.project(p, Levers(horizon_months=12, start_month="2027-01"))
    mean = sum(season) / 12
    assert pr["months"][11]["demand_units"] == pytest.approx(1000 * 2.0 / mean)
    shifted = engine.project(p, Levers(horizon_months=12, start_month="2027-01", seasonal=[{"months": [12], "demand_change_pct": 30}]))
    assert shifted["months"][11]["demand_units"] == pytest.approx(1000 * 2.0 / mean * 1.3)
    assert shifted["months"][0]["demand_units"] == pytest.approx(pr["months"][0]["demand_units"])


def test_bands_bracket_the_expected_case_and_are_deterministic():
    p = Profile.model_validate(demo_profile())
    lv = Levers(price_change_pct=-10, horizon_months=12, start_month="2027-01")
    a, b = engine.simulate(p, lv), engine.simulate(p, lv)
    exp = a["scenario"]["totals"]["net_profit"]
    assert a["bands"]["worst"]["net_profit"] <= exp <= a["bands"]["best"]["net_profit"]
    assert a["bands"]["cases"] == 27
    assert a["scenario"]["totals"] == b["scenario"]["totals"]


def test_milk_tea_price_cut_example():
    """The brief's example: 10% lower milk tea prices. With the demo's elasticity it lowers profit."""
    p = Profile.model_validate(demo_profile())
    sim = engine.simulate(p, Levers(price_change_pct=-10, horizon_months=12, start_month="2027-01"))
    assert sim["delta"]["revenue"]["change"] > 0          # more cups and slightly more revenue
    assert sim["delta"]["net_profit"]["change"] < 0       # but each cup earns less
    from app.whatif.ai import required_volume
    rv = required_volume(sim)
    assert rv["possible"] and rv["needed_change"] > rv["expected_change"]


def test_assumptions_and_confidence_are_traceable():
    p = Profile.model_validate(template("food_beverage", "x"))
    sim = engine.simulate(p, Levers(price_change_pct=-10, horizon_months=12))
    keys = {a["key"] for a in sim["assumptions"]}
    assert "lever.price_change_pct" in keys and any(k.startswith("elasticity.") for k in keys)
    assert all(a["source"] in ("default", "user", "scenario", "demo", "imported", "stated", "assumed", "ai") for a in sim["assumptions"])
    assert sim["confidence"]["level"] == "low"  # every core figure is a template estimate
    assert sim["confidence"]["reasons"]


@pytest.mark.parametrize("industry", list(INDUSTRIES))
def test_every_template_runs_and_starts_profitable(industry):
    p = Profile.model_validate(template(industry, "t"))
    pr = engine.project(p, Levers(horizon_months=12, start_month="2027-01"))
    assert 0 < pr["metrics"]["net_margin"] < 0.3
    assert pr["metrics"]["min_cash"] > 0


def test_history_trend_is_seasonally_adjusted():
    p = Profile.model_validate(demo_profile())
    t = engine.history_trend(p)
    assert t["seasonally_adjusted"]
    assert abs(t["slope_pct_per_month"]) < 0.01  # demo history is seasonal, flat underneath
    assert t["cost_slope_pct_per_month"] > 0.002   # ingredient costs creep up
