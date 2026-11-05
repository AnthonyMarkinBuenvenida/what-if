"""Risk Radar responds to scenario outcomes through the existing rules, keeps the current business separate from
hypothetical scenarios, and keeps each saved scenario's original assessment. (No thresholds are changed here.)"""
import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.agents.llm import llm
from app.main import app

H = {"X-StartUp-Client": "web"}
RANK = {"low": 0, "moderate": 1, "high": 2, "critical": 3}
SCENARIOS = {
    "A": {"price_change_pct": 5, "fixed_cost_change_pct": -10, "demand_change_pct": 5},        # healthier
    "B": {"unit_cost_change_pct": 15, "demand_change_pct": -8},                                 # cost pressure
    "C": {"demand_change_pct": -25, "fixed_cost_change_pct": 15, "unit_cost_change_pct": 10},   # serious decline
    "D": {"demand_change_pct": -50, "unit_cost_change_pct": 20},                                # far below break-even
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def setup(c):
    c.cookies.clear()
    c.post("/api/workspace", headers=H)
    bid = c.post("/api/whatif/demo", headers=H).json()["business"]["id"]
    return bid


def save(c, bid, name, lv):
    r = c.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H, json={"name": name, "levers": {**lv, "horizon_months": 12}, "client_key": uuid.uuid4().hex, "origin": "auto"})
    assert r.status_code == 200, r.text
    return r.json()


def rules(report):
    return {f["rule"]: f["severity"] for f in report["findings"]}


def test_risk_follows_the_calculated_outcome(client):
    bid = setup(client)
    s = {k: save(client, bid, k, lv) for k, lv in SCENARIOS.items()}
    risk = {k: v["risks"]["scenario"] for k, v in s.items()}
    profit = {k: v["result"]["scenario"]["totals"]["net_profit"] for k, v in s.items()}
    # Healthier scenario: profitable and no high or critical warning.
    assert profit["A"] > profit["B"] > profit["C"] > profit["D"]
    assert risk["A"]["counts"]["high"] == 0 and risk["A"]["counts"]["critical"] == 0
    # Deterioration raises the level and the score; losses are critical under the written net-margin rule (< 0%).
    assert RANK[risk["A"]["level"]] < RANK[risk["B"]["level"]]
    assert risk["A"]["score"] < risk["B"]["score"] < min(risk["C"]["score"], risk["D"]["score"])
    for k in ("B", "C", "D"):
        if profit[k] < 0:
            assert rules(risk[k])["net_margin"] == "critical"
    assert rules(risk["D"])["break_even"] in ("high", "critical") and "cash_shortfall" in rules(risk["C"])
    # Warnings follow the evidence: cost pressure only where variable costs rose.
    assert "cost_pressure" not in rules(risk["A"]) and "cost_pressure" in rules(risk["B"])
    # Unrelated rules are unaffected: supplier concentration is a profile fact, identical in every scenario.
    conc = {k: [f for f in risk[k]["findings"] if f["rule"] == "concentration" and f["metric"]["key"] == "supplier_share"] for k in s}
    assert all(len(v) == 1 and v[0]["severity"] == conc["A"][0]["severity"] for v in conc.values())
    assert not any(f["rule"] in ("weather", "inflation") for k in s for f in risk[k]["findings"])  # no external data retrieved


def test_identical_inputs_give_identical_risk(client):
    bid = setup(client)
    a = save(client, bid, "x", SCENARIOS["B"])["risks"]["scenario"]
    b = save(client, bid, "y", SCENARIOS["B"])["risks"]["scenario"]
    strip = lambda r: [(f["rule"], f["severity"], f["metric"]["value"]) for f in r["findings"]]  # noqa: E731
    assert a["level"] == b["level"] and a["score"] == b["score"] and strip(a) == strip(b)


def test_scenarios_never_change_the_current_business_assessment(client):
    bid = setup(client)
    before = client.get(f"/api/whatif/businesses/{bid}/risk").json()["baseline"]
    for k, lv in SCENARIOS.items():
        save(client, bid, k, lv)
    radar = client.get(f"/api/whatif/businesses/{bid}/risk").json()
    after = radar["baseline"]
    assert (after["level"], after["score"], rules(after)) == (before["level"], before["score"], rules(before))
    assert client.get(f"/api/whatif/businesses/{bid}/dashboard").json()["risk"]["score"] == after["score"]
    # Each scenario row carries its own assessment, distinct from the current business.
    rows = {r["name"]: r for r in radar["scenarios"]}
    assert rows["D"]["level"] == "critical" and rows["A"]["score"] != rows["D"]["score"]
    assert all(r["inputs_changed"] is False and r["saved"]["score"] == r["score"] for r in rows.values() if r["name"] in SCENARIOS)


def test_saved_assessment_is_kept_when_the_business_changes(client):
    bid = setup(client)
    a = save(client, bid, "A", SCENARIOS["A"])
    spec = client.get(f"/api/whatif/businesses/{bid}/profile").json()["profile"]["spec"]
    spec["fixed_costs"][0]["monthly_amount"] += 40000
    assert client.put(f"/api/whatif/businesses/{bid}/profile", headers=H, json={"spec": spec}).status_code == 200
    radar = client.get(f"/api/whatif/businesses/{bid}/risk").json()
    row = next(r for r in radar["scenarios"] if r["id"] == a["id"])
    # Today's figures give a different result, flagged as such; the stored assessment is unchanged.
    assert row["inputs_changed"] is True and row["saved"]["profile_version"] < radar["profile_version"]
    assert row["saved"]["level"] == a["risks"]["scenario"]["level"] and row["saved"]["score"] == a["risks"]["scenario"]["score"]
    assert row["score"] != row["saved"]["score"]
    reopened = client.get(f"/api/whatif/scenarios/{a['id']}").json()
    assert reopened["risks"] == a["risks"] and reopened["result"]["computed_at"] == a["result"]["computed_at"]
    hist = next(h for h in client.get("/api/whatif/history").json()["scenarios"] if h["id"] == a["id"])
    assert hist["summary"]["risk_level"] == a["risks"]["scenario"]["level"]


def test_ai_gets_the_selected_scenarios_risk_and_outdated_assessments_are_flagged(client, monkeypatch):
    bid = setup(client)
    d = save(client, bid, "D", SCENARIOS["D"])
    monkeypatch.setattr(type(llm), "available", property(lambda self: True))
    seen = []

    def fake(system, prompt, schema, effort="medium", timeout=None):
        facts = json.loads(prompt.split("Facts (JSON):\n", 1)[1])
        seen.append(facts)
        return schema.model_validate({"risk_level": "low", "risk_summary": "Summary.", "recommended_actions": [], "expected_impact": {"if_followed": "Testing could show the effect.", "if_ignored": "Losses continue."}})
    monkeypatch.setattr(llm, "structured", fake)
    url = f"/api/whatif/businesses/{bid}/risk/assessment"
    a = client.post(url, headers=H, json={"scope": str(d["id"])}).json()["assessment"]
    radar_row = next(r for r in client.get(f"/api/whatif/businesses/{bid}/risk").json()["scenarios"] if r["id"] == d["id"])
    # The AI was given this scenario's findings and level; its own level ("low") was overruled by the rules.
    assert seen[0]["risk_radar"]["level"] == radar_row["level"] == "critical"
    assert {f["rule"] for f in seen[0]["findings"]} == {f["rule"] for f in radar_row["findings"][:8]}
    assert a["level"] == "critical" and a["level_corrected"] is True
    # The current business assessment is separate.
    base = client.post(url, headers=H, json={"scope": "baseline"}).json()["assessment"]
    assert base["level"] != a["level"] and seen[1]["risk_radar"]["level"] == base["level"]
    # Changing the business makes both saved assessments outdated (no stale reuse).
    spec = client.get(f"/api/whatif/businesses/{bid}/profile").json()["profile"]["spec"]
    spec["marketing"]["monthly_budget"] += 1000
    client.put(f"/api/whatif/businesses/{bid}/profile", headers=H, json={"spec": spec})
    assert client.get(f"{url}?scope={d['id']}").json()["current"] is False
    assert client.get(f"{url}?scope=baseline").json()["current"] is False
