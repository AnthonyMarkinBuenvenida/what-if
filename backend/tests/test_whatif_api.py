"""What-if API workflow: setup -> simulate -> save -> risk -> compare -> report."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

H = {"X-StartUp-Client": "web"}
ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def fresh(c):
    c.cookies.clear()
    assert c.post("/api/workspace", headers=H).status_code == 200


def make_business(c, industry="food_beverage"):
    r = c.post("/api/whatif/businesses", headers=H, json={"name": "Corner Tea", "industry": industry, "currency": "PHP", "country": "PH"})
    assert r.status_code == 200, r.text
    return r.json()["business"]["id"], r.json()["profile"]


def test_full_workflow(client):
    fresh(client)
    bid, prof = make_business(client)
    assert prof["version"] == 1 and set(prof["spec"]["provenance"].values()) <= {"default", "user"}

    # Business setup: change a price -> new version, that value becomes "user"
    spec = prof["spec"]
    spec["products"][0]["price"] = 5.5
    r = client.put(f"/api/whatif/businesses/{bid}/profile", headers=H, json={"spec": spec})
    assert r.status_code == 200, r.text
    p2 = r.json()["profile"]
    pid = spec["products"][0]["id"]
    assert p2["version"] == 2 and p2["spec"]["provenance"][f"products.{pid}.price"] == "user"
    assert p2["spec"]["provenance"][f"products.{pid}.unit_cost"] == "default"

    # Invalid inputs are rejected with a readable message
    bad = json.loads(json.dumps(spec))
    bad["products"][0]["price"] = -3
    r = client.put(f"/api/whatif/businesses/{bid}/profile", headers=H, json={"spec": bad})
    assert r.status_code == 422 and "price" in r.json()["detail"]
    assert client.post(f"/api/whatif/businesses/{bid}/simulate", headers=H, json={"levers": {"price_change_pct": -500}}).status_code == 422

    # Interpret (rule-based, AI disabled in tests) -> simulate
    r = client.post(f"/api/whatif/businesses/{bid}/interpret", headers=H, json={"question": "What if ingredient costs increase by 15%?"})
    it = r.json()
    assert it["mode"] == "rules" and it["levers"] == {"unit_cost_change_pct": 15.0}
    r = client.post(f"/api/whatif/businesses/{bid}/simulate", headers=H, json={"levers": {**it["levers"], "horizon_months": 12}})
    sim = r.json()
    assert sim["result"]["delta"]["net_profit"]["change"] < 0
    assert sim["explanation"]["mode"] == "calculation"
    assert sim["risks"]["scenario"]["findings"]

    # Save, list, rerun
    r = client.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H,
                    json={"name": "Ingredients +15%", "question": "What if ingredient costs increase by 15%?", "levers": it["levers"], "interpretation": it})
    s1 = r.json()
    assert s1["result"]["scenario"]["totals"]["net_profit"] == pytest.approx(sim["result"]["scenario"]["totals"]["net_profit"], rel=1e-6)
    s2 = client.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H, json={"name": "Price -10%", "levers": {"price_change_pct": -10}}).json()
    lst = client.get(f"/api/whatif/businesses/{bid}/scenarios").json()
    assert {x["id"] for x in lst} >= {s1["id"], s2["id"]}
    assert client.post(f"/api/whatif/scenarios/{s1['id']}/rerun", headers=H).json()["profile_id"] == p2["id"]

    # Risk Radar recalculated for baseline + scenarios, with links back to scenarios
    rr = client.get(f"/api/whatif/businesses/{bid}/risk").json()
    assert rr["baseline"]["findings"] is not None and len(rr["scenarios"]) == 2
    assert all(f["scenario_id"] in (s1["id"], s2["id"]) for sc in rr["scenarios"] for f in sc["findings"])
    assert rr["rules"]

    # Compare: consistent with individual simulations on the same period
    cmp_ = client.post(f"/api/whatif/businesses/{bid}/compare", headers=H,
                       json={"scenario_ids": [s1["id"], s2["id"]], "objective": "max_profit", "horizon_months": 12}).json()
    assert [r_["rank"] for r_ in cmp_["rows"]] == [1, 2, 3]
    row = next(r_ for r_ in cmp_["rows"] if r_["id"] == s1["id"])
    single = client.post(f"/api/whatif/businesses/{bid}/simulate", headers=H,
                         json={"levers": {**s1["levers"], "start_month": cmp_["start_month"], "horizon_months": 12}}).json()
    assert row["values"]["net_profit"] == pytest.approx(single["result"]["scenario"]["totals"]["net_profit"], abs=0.01)
    assert "overlap" in cmp_["ranking_note"] or "worst case" in cmp_["ranking_note"]
    assert client.post(f"/api/whatif/businesses/{bid}/compare", headers=H, json={"scenario_ids": [], "objective": "max_profit"}).status_code == 422
    assert client.post(f"/api/whatif/businesses/{bid}/compare", headers=H, json={"scenario_ids": [s1["id"]], "objective": "nope"}).status_code == 422

    # Report: numbers match the calculation; CSV export
    rep = client.post(f"/api/whatif/businesses/{bid}/reports", headers=H, json={"scenario_ids": [s1["id"], s2["id"]]}).json()
    rs = next(x for x in rep["content"]["scenarios"] if x["id"] == s1["id"])
    assert rs["delta"]["net_profit"]["scenario"] == pytest.approx(row["values"]["net_profit"], abs=0.01)
    assert rep["content"]["narrative"]["mode"] == "calculation" and rep["content"]["disclaimer"]
    csv_text = client.get(f"/api/whatif/reports/{rep['id']}/csv").text
    assert "net_profit" in csv_text and "Ingredients +15%" in csv_text
    assert client.get(f"/api/whatif/businesses/{bid}/reports").json()[0]["id"] == rep["id"]

    # Dashboard
    d = client.get(f"/api/whatif/businesses/{bid}/dashboard").json()
    assert d["profile_version"] == 2 and len(d["baseline"]["months"]) == 12 and d["ai"]["configured"] is False

    # Delete
    assert client.delete(f"/api/whatif/scenarios/{s2['id']}", headers=H).status_code == 200
    assert client.get(f"/api/whatif/scenarios/{s2['id']}").status_code == 404


def test_workspaces_are_isolated(client):
    fresh(client)
    bid, _ = make_business(client)
    sid = client.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H, json={"name": "x", "levers": {}}).json()["id"]
    fresh(client)
    assert client.get(f"/api/whatif/businesses/{bid}/profile").status_code == 404
    assert client.get(f"/api/whatif/scenarios/{sid}").status_code == 404
    assert client.post(f"/api/whatif/businesses/{bid}/simulate", headers=H, json={}).status_code == 404


def test_demo_business(client):
    fresh(client)
    r = client.post("/api/whatif/demo", headers=H).json()
    assert r["created"] and r["business"]["is_demo"]
    bid = r["business"]["id"]
    sc = client.get(f"/api/whatif/businesses/{bid}/scenarios").json()
    assert len(sc) == 6 and sc[0]["name"] == "Current pricing" and sc[0]["pinned"]
    assert client.post("/api/whatif/demo", headers=H).json()["created"] is False
    prof = client.get(f"/api/whatif/businesses/{bid}/profile").json()["profile"]
    assert set(prof["spec"]["provenance"].values()) <= {"demo", "default"}


def test_public_preview_and_status_never_leak_secrets(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-SECRET-123")
    r = client.post("/api/whatif/public/preview", headers=H, json={"price_change_pct": -10})
    assert r.status_code == 200 and r.json()["demo"] is True and len(r.json()["scenario"]) == 12
    st = client.get("/api/whatif/status").text
    assert "SECRET" not in st
    assert client.post("/api/whatif/public/preview", headers=H, json={"price_change_pct": -90}).status_code == 422


def test_signals_refresh_handles_failures(client, monkeypatch):
    from app.sources.base import SourceError
    from app.whatif import signals
    fresh(client)
    bid = client.post("/api/whatif/demo", headers=H).json()["business"]["id"]
    fx = json.loads((ROOT / "backend/tests/fixtures/sources/om_forecast_qc.json").read_text(encoding="utf-8"))["json"]

    def forecast(lat, lon, days=16):
        return {"kind": "forecast", "days": [{"date": d, "precipitation_sum": p, "temperature_2m_max": t} for d, p, t in
                                             zip(fx["daily"]["time"], fx["daily"]["precipitation_sum"], fx["daily"]["temperature_2m_max"])],
                "source_url": "https://api.open-meteo.com/v1/forecast", "retrieved_at": "2026-10-22T13:00:00+00:00", "cached": False}

    def boom(*a, **k):
        raise SourceError("world_bank", "timeout", "World Bank Indicators did not answer within 20 s.", "https://api.worldbank.org/v2/x")
    monkeypatch.setattr(signals.open_meteo, "forecast", forecast)
    monkeypatch.setattr(signals.world_bank, "indicator", boom)
    monkeypatch.setattr(signals.frankfurter, "rate", boom)
    r = client.post(f"/api/whatif/businesses/{bid}/signals/refresh", headers=H).json()
    assert r["signals"]["weather"]["status"] == "ok" and r["signals"]["weather"]["kind"] == "forecast"
    assert r["signals"]["inflation"]["status"] == "failed" and r["signals"]["inflation"]["data"] is None
    assert client.get(f"/api/whatif/businesses/{bid}/risk").status_code == 200
    assert client.get(f"/api/whatif/businesses/{bid}/signals").json()["signals"]["weather"]["status"] == "ok"


def test_twin_import(client):
    fresh(client)
    b = client.post("/api/businesses/demo", headers=H).json()
    r = client.post(f"/api/whatif/businesses/{b['id']}/profile/from-twin", headers=H)
    assert r.status_code == 200, r.text
    spec = r.json()["profile"]["spec"]
    assert spec["industry"] == "retail" and spec["products"] and spec["products"][0]["monthly_units"] > 0
