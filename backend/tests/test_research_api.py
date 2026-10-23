"""Research endpoints and briefs, with every connector served from captured fixtures (no network)."""
import httpx
import pytest
from fastapi.testclient import TestClient

import app.research as research
import app.routers.research as research_router
from app.main import app
from app.sources.frankfurter import Frankfurter
from app.sources.gdelt import Gdelt
from app.sources.open_food_facts import OpenFoodFacts
from app.sources.open_prices import OpenPrices
from app.sources.world_bank import WorldBank

from .test_api import H, new_workspace
from .test_sources import fast, fx_transport, op_transport, reply


@pytest.fixture()
def client(monkeypatch):
    wb = fast(WorldBank(httpx.MockTransport(lambda req: reply("wb_lending_ph" if "FR.INR.LEND" in req.url.path else "wb_cpi_ph"))))
    conns = {
        "open_prices": fast(OpenPrices(op_transport())),
        "open_food_facts": fast(OpenFoodFacts(httpx.MockTransport(lambda req: reply("off_v3_missing")))),
        "world_bank": wb,
        "gdelt": fast(Gdelt(httpx.MockTransport(lambda req: httpx.Response(429, text="Please limit requests to one every 5 seconds.")))),
        "frankfurter": fast(Frankfurter(fx_transport())),
    }
    for mod in (research, research_router):
        for k, v in conns.items():
            if hasattr(mod, k):
                monkeypatch.setattr(mod, k, v)
    monkeypatch.setattr(research, "CONNECTORS", conns)
    monkeypatch.setattr(research_router, "CONNECTORS", conns)
    with TestClient(app) as c:
        yield c


def make_business(c):
    new_workspace(c)
    return c.post("/api/businesses", json={"name": "Sari-sari", "business_type": "grocery"}, headers=H).json()["business"]["id"]


def test_research_requires_workspace(client):
    client.cookies.clear()
    assert client.get("/api/research/prices").status_code == 401


def test_research_endpoints_label_data(client):
    make_business(client)
    p = client.get("/api/research/prices", params={"country": "PH"}).json()
    assert p["ok"] and all(o["kind"] == "observed" for o in p["observations"]) and p["coverage"]["sufficient"] is False
    fx = client.get("/api/research/fx", params={"base": "USD", "quote": "PHP", "amount": 10}).json()
    assert fx["ok"] and fx["rate"]["kind"] == "observed" and fx["conversion"]["kind"] == "calculated"
    news = client.get("/api/research/news", params={"q": "rice prices", "country": "PH"}).json()
    assert news["ok"] is False and news["error"]["kind"] == "rate_limited"   # reported, not replaced
    eco = client.get("/api/research/economy", params={"country": "PH", "indicators": "FP.CPI.TOTL.ZG"}).json()
    assert eco["ok"] and eco["indicators"][0]["kind"] == "historical"
    assert client.get("/api/research/prices", params={"country": "PHL"}).status_code == 422


def test_brief_keeps_kinds_separate_and_applies_only_on_request(client):
    bid = make_business(client)
    before = len(client.get(f"/api/businesses/{bid}/scenarios").json())
    r = client.post(f"/api/businesses/{bid}/research/briefs", json={"country": "PH", "business_currency": "PHP", "supplier_currency": "USD", "imported_share_pct": 30}, headers=H)
    assert r.status_code == 200, r.text
    b = r.json()["content"]
    status = {s["source"]: s["status"] for s in b["sources"]}
    assert status == {"open_prices": "ok", "world_bank": "ok", "gdelt": "failed", "frankfurter": "ok"}
    assert b["observed"]["news"] is None and any("GDELT" in l for l in b["limitations"])
    assert all(i["kind"] == "historical" for i in b["historical"]["indicators"])
    assert b["calculated"]["fx_change"]["kind"] == "calculated"
    assert b["ai_reading"]["kind"] == "ai_generated" and b["ai_reading"]["available"] is False
    assert any(q["kind"] == "upload" for q in b["requests"])
    ids = [p["id"] for p in b["proposals"]]
    assert "cpi-latest" in ids and "fx-year" in ids
    # Nothing is created until the user applies a proposal.
    assert len(client.get(f"/api/businesses/{bid}/scenarios").json()) == before
    brief_id = r.json()["id"]
    a = client.post(f"/api/research/briefs/{brief_id}/apply", json={"proposal_ids": ["cpi-latest"]}, headers=H).json()
    s = a["created"][0]
    prop = next(p for p in b["proposals"] if p["id"] == "cpi-latest")
    assert s["origin"] == "research:world_bank" and s["levers"] == prop["levers"] and s["assumptions"] == prop["assumptions"]
    again = client.post(f"/api/research/briefs/{brief_id}/apply", json={"proposal_ids": ["cpi-latest"]}, headers=H).json()
    assert again["created"] == []
    assert client.post(f"/api/research/briefs/{brief_id}/apply", json={"proposal_ids": ["made-up"]}, headers=H).status_code == 422
    # Other workspaces cannot read the brief.
    new_workspace(client)
    assert client.get(f"/api/research/briefs/{brief_id}").status_code == 404
