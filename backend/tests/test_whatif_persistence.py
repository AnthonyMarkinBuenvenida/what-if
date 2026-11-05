"""Saved simulations: automatic saving, idempotency, history, restore, duplicates, saved AI explanations,
database health, outages and additive migrations. Runs against the configured test database
(SQLite by default; set TEST_DATABASE_URL to run the same tests on Postgres)."""
import json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker

from app.agents.llm import llm
from app.db import SessionLocal, _add_missing_columns, engine
from app.main import app
from app.models import WhatIfScenario

H = {"X-StartUp-Client": "web"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def demo(c):
    c.cookies.clear()
    assert c.post("/api/workspace", headers=H).status_code == 200
    return c.post("/api/whatif/demo", headers=H).json()["business"]["id"]


def autosave(c, bid, levers, key=None, name="Run"):
    key = key or uuid.uuid4().hex
    r = c.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H, json={"name": name, "levers": levers, "client_key": key, "origin": "auto"})
    assert r.status_code == 200, r.text
    return r.json(), key


def test_autosave_stores_the_complete_record_and_is_idempotent(client):
    bid = demo(client)
    before = len(client.get(f"/api/whatif/businesses/{bid}/scenarios").json())
    sim = client.post(f"/api/whatif/businesses/{bid}/simulate", headers=H, json={"levers": {"price_change_pct": -10}}).json()
    s, key = autosave(client, bid, {"price_change_pct": -10})
    # The saved result matches what the simulator showed.
    assert s["result"]["scenario"]["totals"]["net_profit"] == pytest.approx(sim["result"]["scenario"]["totals"]["net_profit"], rel=1e-9)
    assert s["origin"] == "auto" and s["calc_ms"] is not None and s["engine"] and s["computed_at"]
    # Everything needed to understand the result later is in the record.
    r = s["result"]
    for k in ("levers", "baseline", "scenario", "bands", "baseline_bands", "bridge", "confidence", "assumptions", "delta"):
        assert k in r
    assert s["risks"]["scenario"]["level"] and s["explanation"]["chart_notes"]
    assert s["profile"]["spec"]["products"] and s["profile"]["version"] >= 1  # the exact business inputs used
    # Repeated click / network retry with the same key: same record, no duplicate.
    again, _ = autosave(client, bid, {"price_change_pct": -10}, key=key)
    assert again["id"] == s["id"] and again.get("duplicate_request")
    assert len(client.get(f"/api/whatif/businesses/{bid}/scenarios").json()) == before + 1
    # A different run is a new record; nothing earlier is overwritten.
    s2, _ = autosave(client, bid, {"unit_cost_change_pct": 15})
    assert s2["id"] != s["id"]
    assert client.get(f"/api/whatif/scenarios/{s['id']}").json()["result"] == s["result"]


def test_records_survive_a_new_database_connection(client):
    """A fresh engine on the same database (what a backend restart does) reads the saved record unchanged."""
    bid = demo(client)
    s, _ = autosave(client, bid, {"demand_change_pct": 7})
    fresh = create_engine(engine.url, future=True)
    try:
        with sessionmaker(bind=fresh)() as db:
            row = db.get(WhatIfScenario, s["id"])
            assert row is not None and row.result["scenario"]["totals"] == s["result"]["scenario"]["totals"] and row.client_key
    finally:
        fresh.dispose()


def test_open_restore_rename_duplicate_delete(client):
    bid = demo(client)
    a, _ = autosave(client, bid, {"price_change_pct": 5}, name="A")
    b, _ = autosave(client, bid, {"price_change_pct": -5}, name="B")
    # Opening records the last viewed run; "latest" restores it after a restart.
    client.get(f"/api/whatif/scenarios/{a['id']}?open=true")
    assert client.get(f"/api/whatif/businesses/{bid}/scenarios/latest").json()["scenario"]["id"] == a["id"]
    # Opening restores the stored result without recalculating.
    opened = client.get(f"/api/whatif/scenarios/{a['id']}").json()
    assert opened["result"]["computed_at"] == a["result"]["computed_at"]
    # Naming an automatic run keeps it as a user scenario.
    r = client.patch(f"/api/whatif/scenarios/{b['id']}", headers=H, json={"name": "Discount test"}).json()
    assert r["name"] == "Discount test" and r["origin"] == "user"
    # Duplicate: exact copy linked to its source.
    d = client.post(f"/api/whatif/scenarios/{a['id']}/duplicate", headers=H, json={}).json()
    assert d["id"] != a["id"] and d["source_scenario_id"] == a["id"] and d["result"] == opened["result"] and d["name"].endswith("(copy)")
    # Delete removes only that record (and its saved Risk Radar assessments).
    client.post(f"/api/whatif/businesses/{bid}/risk/assessment", headers=H, json={"scope": str(d["id"])})
    assert client.delete(f"/api/whatif/scenarios/{d['id']}", headers=H).json()["ok"]
    assert client.get(f"/api/whatif/scenarios/{d['id']}").status_code == 404
    assert client.get(f"/api/whatif/scenarios/{a['id']}").status_code == 200
    with SessionLocal() as db:
        assert db.execute(text("SELECT count(*) FROM wi_risk_assessments WHERE scope = :s"), {"s": f"scenario:{d['id']}"}).scalar() == 0


def test_history_search_sort_filter_and_isolation(client):
    bid = demo(client)
    autosave(client, bid, {"price_change_pct": 3}, name="Zeta price")
    autosave(client, bid, {"marketing_change_pct": 20}, name="Alpha marketing")
    h = client.get("/api/whatif/history?sort=name&order=asc").json()
    names = [s["name"] for s in h["scenarios"]]
    assert names == sorted(names, key=str.lower) and all(s["business_name"] for s in h["scenarios"])
    assert h["storage"]["ok"] and h["storage"]["kind"] in ("sqlite", "postgresql")
    assert [s["name"] for s in client.get("/api/whatif/history?q=marketing").json()["scenarios"]] == ["Alpha marketing"]
    profits = [s["summary"]["net_profit"] for s in client.get("/api/whatif/history?sort=profit&order=desc").json()["scenarios"]]
    assert profits == sorted(profits, reverse=True)
    assert {s["origin"] for s in client.get("/api/whatif/history?origin=auto").json()["scenarios"]} == {"auto"}
    # Another browser's workspace sees none of it.
    client.cookies.clear()
    client.post("/api/workspace", headers=H)
    assert client.get("/api/whatif/history").json()["scenarios"] == []


def test_saved_explanation_uses_the_stored_result_and_is_kept(client, monkeypatch):
    bid = demo(client)
    s, _ = autosave(client, bid, {"price_change_pct": -10})
    computed = s["result"]["computed_at"]
    monkeypatch.setattr(type(llm), "available", property(lambda self: True))
    calls = []

    def fake(system, prompt, schema, effort="medium", timeout=None):
        calls.append(prompt)
        facts = json.loads(prompt.split("Facts (JSON):\n", 1)[1])
        cmp_ = facts["charts"]["comparison"]
        return schema.model_validate({
            "summary": f"Net profit falls from {cmp_['current_course']['net_profit']:,.0f} to {cmp_['scenario']['net_profit']:,.0f}.",
            "key_points": [], "recommendations": [{"text": "Consider testing a 5% price cut instead."}],
            "chart_notes": [{"chart": "comparison", "note": "Revenue rises slightly but net profit falls."},
                            {"chart": "expenses", "note": "Variable costs are 99,999,999 of spending."},  # invented -> removed
                            {"chart": "range", "note": "This decision will restore profitability."}],  # overclaim -> removed
            "not_recommended": ["Avoid applying the cut to every product at once."], "next_step": "Test a 5% price reduction."})
    monkeypatch.setattr(llm, "structured", fake)
    e = client.post(f"/api/whatif/scenarios/{s['id']}/explain", headers=H, json={}).json()
    assert e["mode"] == "ai" and e["chart_notes"]["comparison"] == "Revenue rises slightly but net profit falls."
    assert "99,999,999" not in json.dumps(e) and "will restore" not in json.dumps(e) and e["dropped"] == 2
    assert e["chart_notes"]["expenses"] and e["chart_notes"]["range"]  # kept from the rules
    assert e["not_recommended"] and e["next_step"] == "Test a 5% price reduction." and "context" not in e
    saved = client.get(f"/api/whatif/scenarios/{s['id']}").json()
    assert saved["explanation"]["mode"] == "ai" and saved["result"]["computed_at"] == computed  # not recalculated
    with SessionLocal() as db:
        assert db.get(WhatIfScenario, s["id"]).explanation["context"]["charts"]  # what the AI was given is stored
    # Second request: the saved explanation, no new AI call.
    assert client.post(f"/api/whatif/scenarios/{s['id']}/explain", headers=H, json={}).json().get("cached") and len(calls) == 1
    # A refresh that fails (quota) keeps the stored AI explanation.
    monkeypatch.setattr(llm, "structured", lambda *a, **k: None)
    monkeypatch.setattr(llm, "last_error", "The AI service is rate limited")
    r = client.post(f"/api/whatif/scenarios/{s['id']}/explain", headers=H, json={"refresh": True}).json()
    assert r["mode"] == "ai" and r["cached"] and "rate limiting" in r["notice"]


def test_health_and_database_outage(client, monkeypatch):
    h = client.get("/api/health")
    assert h.status_code == 200 and h.json()["database"]["ok"]
    bid = demo(client)

    def broken(*a, **k):
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))
    monkeypatch.setattr("app.whatif.service.create_scenario", broken)
    r = client.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H, json={"name": "x", "levers": {}, "client_key": uuid.uuid4().hex})
    assert r.status_code == 503 and "nothing was saved" in r.json()["detail"] and "refused" not in r.text


def test_migration_adds_columns_without_touching_rows(tmp_path):
    old = create_engine(f"sqlite:///{tmp_path / 'old.db'}", future=True)
    with old.begin() as c:
        c.execute(text("CREATE TABLE wi_scenarios (id INTEGER PRIMARY KEY, business_id INTEGER, profile_id INTEGER, name VARCHAR(160), "
                       "question TEXT, levers JSON, interpretation JSON, result JSON, risks JSON, explanation JSON, origin VARCHAR(60), "
                       "pinned BOOLEAN, created_at DATETIME, updated_at DATETIME)"))
        c.execute(text("INSERT INTO wi_scenarios (id, business_id, profile_id, name, result) VALUES (1, 1, 1, 'kept', '{\"x\": 1}')"))
    added = _add_missing_columns(old)
    assert {"wi_scenarios.client_key", "wi_scenarios.calc_ms", "wi_scenarios.source_scenario_id", "wi_scenarios.opened_at"} <= set(added)
    assert _add_missing_columns(old) == []  # running again changes nothing
    with old.connect() as c:
        assert c.execute(text("SELECT name, result FROM wi_scenarios")).one() == ("kept", '{"x": 1}')
    assert "ux_wi_scenarios_business_client_key" in {i["name"] for i in inspect(old).get_indexes("wi_scenarios")}
    old.dispose()


def test_risk_radar_keeps_named_scenarios_and_recent_automatic_runs(client):
    bid = demo(client)
    named = client.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H, json={"name": "Kept", "levers": {"price_change_pct": 2}}).json()
    autos = [autosave(client, bid, {"price_change_pct": -i})[0] for i in range(1, 9)]
    radar = client.get(f"/api/whatif/businesses/{bid}/risk").json()
    ids = {s["id"] for s in radar["scenarios"]}
    assert named["id"] in ids and {a["id"] for a in autos[-5:]} <= ids and not ({a["id"] for a in autos[:3]} & ids)
    assert radar["older_automatic_runs"] == 3
