"""Business setup and current-business figures: old stored profiles load complete, saved figures drive the
current-business numbers everywhere (Risk Radar, dashboard, simulator), edits recalculate, businesses stay separate."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import WhatIfProfile

H = {"X-StartUp-Client": "web"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def new_business(c, name="Test shop", industry="food_beverage"):
    c.cookies.clear()
    c.post("/api/workspace", headers=H)
    r = c.post("/api/whatif/businesses", headers=H, json={"name": name, "industry": industry, "currency": "PHP", "country": "PH"})
    assert r.status_code == 200, r.text
    return r.json()["business"]["id"]


def put_simple(c, bid, price=10.0, cost=4.0, units=1000.0, rent=2000.0, other=500.0, staff=2, wage=1000.0, marketing=500.0):
    """A profile that can be checked by hand: one product, flat months, no tax, no capacity limit."""
    spec = c.get(f"/api/whatif/businesses/{bid}/profile").json()["profile"]["spec"]
    spec["products"] = [{"id": "p1", "name": "Product", "price": price, "unit_cost": cost, "monthly_units": units, "elasticity": -1.2, "stock_units": None, "restock_units_per_month": None}]
    spec["staff"] = [{"id": "s1", "role": "Staff", "count": staff, "monthly_wage": wage}]
    spec["fixed_costs"] = [{"id": "f1", "name": "Rent", "category": "rent", "monthly_amount": rent}, {"id": "f2", "name": "Utilities", "category": "utilities", "monthly_amount": other}]
    spec["marketing"]["monthly_budget"] = marketing
    spec["finance"].update({"tax_rate_pct": 0, "monthly_debt_payment": 0, "starting_cash": 100000, "min_cash_buffer": 0})
    spec["growth"] = {"monthly_growth_pct": 0, "seasonality": [1.0] * 12}
    spec["operations"].update({"monthly_capacity_units": None, "capacity_per_staff": None})
    spec["subscription"]["enabled"] = False
    spec["suppliers"], spec["history"] = [], []
    spec["goals"] = {"target_monthly_profit": None, "max_investment": None, "min_margin_pct": None}
    r = c.put(f"/api/whatif/businesses/{bid}/profile", headers=H, json={"spec": spec})
    assert r.status_code == 200, r.text


def current(c, bid):
    radar = c.get(f"/api/whatif/businesses/{bid}/risk").json()
    dash = c.get(f"/api/whatif/businesses/{bid}/dashboard").json()
    sim = c.post(f"/api/whatif/businesses/{bid}/simulate", headers=H, json={"levers": {"horizon_months": 12}}).json()["result"]["baseline"]
    return radar, dash, sim


def test_profiles_saved_before_newer_fields_load_complete_without_changing_the_record(client):
    bid = new_business(client)
    with SessionLocal() as db:
        row = db.scalars(select(WhatIfProfile).where(WhatIfProfile.business_id == bid)).first()
        old = {k: v for k, v in row.spec.items() if k != "external"}   # as stored before 'external' existed
        row.spec = old
        db.commit()
    spec = client.get(f"/api/whatif/businesses/{bid}/profile").json()["profile"]["spec"]
    assert spec["external"]["foreign_currency"] is not None and "imported_cost_share_pct" in spec["external"]
    assert all(spec[k] == v for k, v in old.items() if k != "provenance")  # stored values unchanged
    with SessionLocal() as db:
        assert "external" not in db.scalars(select(WhatIfProfile).where(WhatIfProfile.business_id == bid)).first().spec
    # Pages that use the profile keep working.
    assert client.get(f"/api/whatif/businesses/{bid}/risk").status_code == 200


def test_current_business_figures_come_from_the_saved_profile_and_agree_everywhere(client):
    bid = new_business(client)
    put_simple(client, bid)
    radar, dash, sim = current(client, bid)
    f = radar["baseline_financials"]
    # Hand check per month: revenue 10 x 1000 = 10,000; variable 4,000; gross 6,000; costs 2x1000 + 2000 + 500 + 500 = 5,000; net 1,000.
    assert f["revenue"] == pytest.approx(120_000) and f["gross_profit"] == pytest.approx(72_000) and f["net_profit"] == pytest.approx(12_000)
    assert f["total_expenses"] == pytest.approx(108_000) and f["net_margin"] == pytest.approx(0.10) and f["break_even_units"] == pytest.approx(5000 / 6)
    assert dash["baseline"]["totals"]["net_profit"] == pytest.approx(f["net_profit"]) and dash["baseline"]["totals"]["revenue"] == pytest.approx(f["revenue"])
    assert sim["totals"]["net_profit"] == pytest.approx(f["net_profit"]) and sim["metrics"]["net_margin"] == pytest.approx(f["net_margin"])
    assert dash["risk"]["score"] == radar["baseline"]["score"]


def test_edits_recalculate_the_current_business(client):
    bid = new_business(client)
    put_simple(client, bid)
    base = current(client, bid)[0]["baseline_financials"]
    put_simple(client, bid, rent=5000)                      # expenses up: net 1,000 - 3,000 = -2,000 a month
    r = current(client, bid)[0]
    assert r["baseline_financials"]["net_profit"] == pytest.approx(-24_000) and r["baseline_financials"]["net_margin"] == pytest.approx(-0.20)
    assert r["baseline_financials"]["revenue"] == pytest.approx(base["revenue"])  # revenue unaffected by rent
    assert {f["rule"]: f["severity"] for f in r["baseline"]["findings"]}["net_margin"] == "critical"
    put_simple(client, bid, units=500)                      # volume down: revenue 5,000/month, net 3,000 - 5,000 = -2,000
    r = current(client, bid)[0]
    assert r["baseline_financials"]["revenue"] == pytest.approx(60_000) and r["baseline_financials"]["net_profit"] == pytest.approx(-24_000)
    put_simple(client, bid, units=0)                        # zero revenue: no division error, margin undefined
    radar, dash, _ = current(client, bid)
    assert radar["baseline_financials"]["revenue"] == 0 and radar["baseline_financials"]["net_margin"] is None
    assert "net_margin" in {f["rule"] for f in radar["baseline"]["findings"]} and dash["baseline"]["metrics"]["net_margin"] is None


def test_businesses_do_not_share_figures(client):
    a = new_business(client, "Shop A")
    put_simple(client, a, price=10)
    ra = current(client, a)[0]["baseline_financials"]["net_profit"]
    b = new_business(client, "Shop B")
    put_simple(client, b, price=14)
    rb = current(client, b)[0]["baseline_financials"]["net_profit"]
    assert ra == pytest.approx(12_000) and rb == pytest.approx(12_000 + 4 * 1000 * 12)


def test_the_starting_score_of_19_changes_when_your_own_figures_replace_the_estimates(client):
    bid = new_business(client)
    start = client.get(f"/api/whatif/businesses/{bid}/risk").json()["baseline"]
    # A new food & beverage business: two moderate warnings (top product > 60% of revenue; figures are estimates) = 19.
    assert start["score"] == 19 and {f["rule"] for f in start["findings"]} == {"concentration", "data_quality"}
    put_simple(client, bid)  # your own figures: estimates replaced; a single product is now 100% of revenue
    after = client.get(f"/api/whatif/businesses/{bid}/risk").json()["baseline"]
    rules = {f["rule"]: f["severity"] for f in after["findings"]}
    assert "data_quality" not in rules and rules.get("concentration") == "high" and after["score"] != 19
