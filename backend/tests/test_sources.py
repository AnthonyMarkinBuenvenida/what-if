"""Public data connectors, tested against responses captured from the real APIs on 2026-10-22.

Fixtures in tests/fixtures/sources/ are trimmed copies of real responses (each
records the URL it came from). The GDELT article test is the exception: GDELT
answered every request with HTTP 429 during development, so that test builds
a response from GDELT's documented artlist fields and says so.

Set STARTUP_LIVE_TESTS=1 to also run test_live_* against the real services.
"""
import json
import os
from pathlib import Path

import httpx
import pytest

from app.research import gather_fx, proposals
from app.sources.base import SourceError
from app.sources.frankfurter import Frankfurter, convert
from app.sources.gdelt import Gdelt
from app.sources.open_food_facts import OpenFoodFacts
from app.sources.open_prices import OpenPrices, coverage, normalize_price
from app.sources.world_bank import WorldBank

FIX = Path(__file__).parent / "fixtures" / "sources"


def fixture(name):
    return json.loads((FIX / f"{name}.json").read_text(encoding="utf-8"))


def reply(name):
    f = fixture(name)
    if f["json"] is not None:
        return httpx.Response(f["status"], json=f["json"])
    return httpx.Response(f["status"], text=f["text"])


def fast(conn):
    """Remove politeness delays for offline tests; behaviour is otherwise unchanged."""
    conn.info.min_interval = 0
    return conn


def op_transport(log=None):
    def handler(req: httpx.Request):
        if log is not None:
            log.append(str(req.url))
        p, q = req.url.path, req.url.params
        if p.endswith("/locations/osm/countries"):
            return reply("op_countries")
        if p.endswith("/locations"):
            name = q.get("osm_address_country__like", "")
            if name == "Philippines":
                return reply("op_locations_philippines")
            if name == "Pilipinas":
                return reply("op_locations_pilipinas")
            return httpx.Response(200, json={"items": [], "total": 0, "page": 1, "pages": 0, "size": 100})
        if p.endswith("/prices"):
            return reply("op_prices_ph")
        return httpx.Response(404, json={"detail": "Not Found"})
    return httpx.MockTransport(handler)


# ------------------------------------------------------------- Open Prices

def test_open_prices_ph_reconciles_name_variants_and_reports_coverage():
    log = []
    op = fast(OpenPrices(op_transport(log)))
    res = op.country_observations("PH")
    cov = res["coverage"]
    summary = next(c for c in fixture("op_countries")["json"] if c["country_code_2"] == "PH")
    # Both "Philippines" and "Pilipinas" locations are found, and match the country summary.
    assert cov["locations_found"] == summary["location_count"]
    assert cov["observations"] == len(res["observations"]) == fixture("op_prices_ph")["json"]["total"]
    assert any("Pilipinas" in s for s in cov["statements"])
    # Prices are filtered by location id (the API has no country filter).
    assert any("location_id__in=" in u for u in log if "/prices" in u)
    # A record in another currency is kept and flagged, not converted or dropped.
    assert cov["currency_mismatch"] and all(o["currency"] != "PHP" for o in res["observations"] if o["id"] in cov["currency_mismatch"])
    assert cov["sufficient"] is False
    assert any("not zero" in s for s in cov["statements"])


def test_open_prices_records_are_observed_with_evidence_links():
    raw = fixture("op_prices_ph")["json"]["items"]
    obs = [normalize_price(p, "2026-10-22T00:00:00+00:00") for p in raw]
    for o, p in zip(obs, raw):
        assert o["kind"] == "observed"
        assert o["price"] == p["price"] and o["currency"] == p["currency"] and o["observed_on"] == p["date"]
        assert o["source_url"] == f"https://prices.openfoodfacts.org/prices/{p['id']}"
        if (p.get("proof") or {}).get("file_path"):
            assert o["evidence"]["proof_image_url"].endswith(p["proof"]["file_path"])
    assert any(o["evidence"] and o["evidence"]["proof_type"] for o in obs)


def test_open_prices_coverage_never_invents_values():
    cov = coverage("PH", [], {"price_count": 0, "location_count": 0}, 0, 0, [])
    assert cov["observations"] == 0 and cov["date_last"] is None and cov["freshness"] == "none" and not cov["sufficient"]


def test_open_prices_unknown_country_is_reported_not_filled():
    res = fast(OpenPrices(op_transport())).country_observations("ZZ")
    assert res["observations"] == [] and res["coverage"]["sufficient"] is False


def test_open_prices_malformed_response_raises():
    t = httpx.MockTransport(lambda req: httpx.Response(200, json={"unexpected": True}))
    with pytest.raises(SourceError) as e:
        fast(OpenPrices(t)).country_observations("PH")
    assert e.value.kind == "invalid_response"


# --------------------------------------------------------- Open Food Facts

def test_off_found_and_missing():
    def handler(req):
        return reply("off_v3_found" if "3017620422003" in req.url.path else "off_v3_missing")
    off = fast(OpenFoodFacts(httpx.MockTransport(handler)))
    p = off.product("3017620422003")
    real = fixture("off_v3_found")["json"]["product"]
    assert p["found"] and p["kind"] == "observed" and p["name"] == real["product_name"] and p["source_url"].startswith("https://world.openfoodfacts.org/api/v3/")
    missing = off.product("0000000000000")
    assert missing["found"] is False and "no product" in missing["note"]
    with pytest.raises(SourceError) as e:
        off.product("abc")
    assert e.value.kind == "invalid_request"


# -------------------------------------------------------------- World Bank

def test_world_bank_series_keeps_missing_years_and_flags_staleness():
    def handler(req):
        return reply("wb_lending_ph" if "FR.INR.LEND" in req.url.path else "wb_cpi_ph")
    wb = fast(WorldBank(httpx.MockTransport(handler)))
    cpi = wb.indicator("PH", "FP.CPI.TOTL.ZG", 8)
    real = [r for r in fixture("wb_cpi_ph")["json"][1] if r["value"] is not None]
    latest_real = max(real, key=lambda r: r["date"])
    assert cpi["kind"] == "historical" and cpi["latest"] == {"year": latest_real["date"], "value": latest_real["value"]}
    assert cpi["source_last_updated"] == fixture("wb_cpi_ph")["json"][0]["lastupdated"]
    lend = wb.indicator("PH", "FR.INR.LEND", 8)
    # The fixture holds only reported years, so a series that stopped is visible by its latest year.
    assert all(s["value"] is not None for s in lend["series"]) and lend["missing_years"] == []
    assert int(lend["latest"]["year"]) <= int(cpi["latest"]["year"]) - 5


def test_world_bank_errors_inside_http_200():
    wb = fast(WorldBank(httpx.MockTransport(lambda req: reply("wb_error"))))
    with pytest.raises(SourceError) as e:
        wb.indicator("XX", "FP.CPI.TOTL.ZG")
    assert e.value.kind == "not_found"
    msg = [{"message": [{"id": "120", "key": "Invalid value", "value": "The provided parameter value is not valid"}]}]
    wb2 = fast(WorldBank(httpx.MockTransport(lambda req: httpx.Response(200, json=msg))))
    with pytest.raises(SourceError) as e:
        wb2.indicator("PH", "NOT.A.CODE")
    assert "not valid" in e.value.message


# --------------------------------------------------------------- Frankfurter

def fx_transport():
    def handler(req):
        p = req.url.path
        if p.endswith("/providers"):
            return reply("fx_providers")
        q = req.url.params
        if q.get("quotes", "").upper() == "XYZ":
            return reply("fx_invalid")
        if p.endswith("/rates") and not q.get("from"):
            return reply("fx_rates_bsp")
        return reply("fx_series_bsp")
    return httpx.MockTransport(handler)


def test_frankfurter_prefers_bsp_for_php_and_labels_conversion_calculated():
    fx = fast(Frankfurter(fx_transport()))
    r = fx.rate("USD", "PHP")
    assert "providers=BSP" in r["source_url"] and r["provider"]["name"] == "Bangko Sentral ng Pilipinas"
    assert r["rate"] == fixture("fx_rates_bsp")["json"][0]["rate"] and r["kind"] == "observed" and r["rate_date"] == "2026-10-22"
    blended = fx.rate("USD", "PHP", provider=None)
    assert "providers" not in blended["source_url"] and blended["provider"] is None
    c = convert(250, r)
    assert c["kind"] == "calculated" and c["value"] == round(250 * r["rate"], 4) and c["inputs"][0] is r
    with pytest.raises(SourceError) as e:
        fx.rate("USD", "XYZ")
    assert e.value.kind == "http" and e.value.status == 422
    with pytest.raises(SourceError):
        fx.rate("US", "PHP")


def test_fx_scenario_requires_user_share_and_uses_real_series(monkeypatch):
    import app.research as research
    monkeypatch.setattr(research, "frankfurter", fast(Frankfurter(fx_transport())))
    without = gather_fx("USD", "PHP", None)
    assert proposals(None, without["data"], "PHP", "USD") == []
    with_share = gather_fx("USD", "PHP", 40)
    pts = fixture("fx_series_bsp")["json"]
    first, last = min(pts, key=lambda p: p["date"]), max(pts, key=lambda p: p["date"])
    expected = round((last["rate"] / first["rate"] - 1) * 100, 2)
    ch = with_share["data"]["change"]
    assert ch["kind"] == "calculated" and ch["one_year_change_pct"] == expected
    props = proposals(None, with_share["data"], "PHP", "USD")
    year = next(p for p in props if p["id"] == "fx-year")
    assert year["levers"]["supplier_cost_change_pct"] == round(expected * 40 / 100, 2)
    assert any("your figure" in a for a in year["assumptions"]) and any(a.startswith("Source: Frankfurter") for a in year["assumptions"])


# --------------------------------------------------------------- GDELT

def test_gdelt_429_plain_text_blocks_further_calls():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(429, text="Please limit requests to one every 5 seconds or contact the GDELT team for larger queries.")
    g = fast(Gdelt(httpx.MockTransport(handler)))
    with pytest.raises(SourceError) as e:
        g.articles("grocery prices", "Philippines")
    assert e.value.kind == "rate_limited" and e.value.retry_after >= 60
    with pytest.raises(SourceError) as e2:
        g.articles("other query")
    assert e2.value.kind == "rate_limited" and len(calls) == 1   # backed off without calling again
    assert g.describe()["rate_limited_for_seconds"] > 0


def test_gdelt_parses_documented_artlist_fields():
    # Built from GDELT's documented artlist JSON fields, not a captured response (see module docstring).
    body = {"articles": [{"url": "https://example.ph/a", "title": "Rice prices", "seendate": "20261020T101500Z",
                          "domain": "example.ph", "language": "English", "sourcecountry": "Philippines"}, {"title": "no url"}]}
    g = fast(Gdelt(httpx.MockTransport(lambda req: httpx.Response(200, json=body))))
    r = g.articles("rice prices", "Philippines")
    assert r["count"] == 1 and r["articles"][0]["seen_at"] == "2026-10-20T10:15:00+00:00" and r["articles"][0]["kind"] == "observed"
    assert "sourcecountry%3Aphilippines" in r["source_url"]
    empty = fast(Gdelt(httpx.MockTransport(lambda req: httpx.Response(200, json={}))))
    assert empty.articles("nothing matches")["articles"] == []
    html = fast(Gdelt(httpx.MockTransport(lambda req: httpx.Response(200, text="<html>error</html>"))))
    with pytest.raises(SourceError) as e:
        html.articles("x y")
    assert e.value.kind == "invalid_response"


# ------------------------------------------------------- shared behaviour

def test_timeout_unreachable_and_cache():
    def boom(req):
        raise httpx.ConnectTimeout("slow", request=req)
    with pytest.raises(SourceError) as e:
        fast(WorldBank(httpx.MockTransport(boom))).indicator("PH", "FP.CPI.TOTL.ZG")
    assert e.value.kind == "timeout"

    def down(req):
        raise httpx.ConnectError("refused", request=req)
    with pytest.raises(SourceError) as e:
        fast(WorldBank(httpx.MockTransport(down))).indicator("PH", "FP.CPI.TOTL.ZG")
    assert e.value.kind == "unreachable"

    n = []
    wb = fast(WorldBank(httpx.MockTransport(lambda req: (n.append(1), reply("wb_cpi_ph"))[1])))
    a, b = wb.indicator("PH", "FP.CPI.TOTL.ZG", 8), wb.indicator("PH", "FP.CPI.TOTL.ZG", 8)
    assert len(n) == 1 and not a["cached"] and b["cached"] and a["retrieved_at"] == b["retrieved_at"]


def test_user_agent_has_no_personal_contact_by_default(monkeypatch):
    monkeypatch.delenv("STARTUP_CONTACT", raising=False)
    seen = []
    wb = fast(WorldBank(httpx.MockTransport(lambda req: (seen.append(req.headers["user-agent"]), reply("wb_cpi_ph"))[1])))
    wb.indicator("PH", "FP.CPI.TOTL.ZG", 8)
    assert seen[0].startswith("WhatIf-BusinessSimulation/") and "@" not in seen[0]


# ------------------------------------------------------------ live (opt-in)

live = pytest.mark.skipif(os.getenv("STARTUP_LIVE_TESTS") != "1", reason="set STARTUP_LIVE_TESTS=1 to call the real APIs")


@live
def test_live_open_prices_ph():
    res = OpenPrices().country_observations("PH")
    assert res["coverage"]["observations"] > 0 and res["coverage"]["locations_found"] == res["coverage"]["reported_location_count"]


@live
def test_live_open_food_facts():
    assert OpenFoodFacts().product("3017620422003")["found"]


@live
def test_live_world_bank():
    assert WorldBank().indicator("PH", "FP.CPI.TOTL.ZG", 5)["latest"] is not None


@live
def test_live_frankfurter_bsp():
    r = Frankfurter().rate("USD", "PHP")
    assert r["rate"] > 0 and r["provider"]["key"] == "BSP"


@live
def test_live_gdelt():
    try:
        r = Gdelt().articles("rice prices", "Philippines", "1week", 5)
    except SourceError as exc:
        pytest.skip(f"GDELT unavailable: {exc.kind}: {exc.message}")
    assert isinstance(r["articles"], list)


def test_world_bank_retries_once_after_timeout():
    calls = []

    def flaky(req):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout("slow", request=req)
        return reply("wb_cpi_ph")
    assert fast(WorldBank(httpx.MockTransport(flaky))).indicator("PH", "FP.CPI.TOTL.ZG", 8)["latest"] and len(calls) == 2
