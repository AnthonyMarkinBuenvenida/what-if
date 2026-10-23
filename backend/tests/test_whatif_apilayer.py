"""Weatherstack and Marketstack (apilayer, API key required): key handling, parsing, errors, and use in What-if.

Error bodies are the real responses both services gave to an invalid key on 2026-10-23.
Success bodies follow the documented response shapes (no key was available to capture live ones).
Set STARTUP_LIVE_TESTS=1 plus the keys to also run test_live_* against the real services.
"""
import os
from datetime import date, timedelta

import httpx
import pytest
from fastapi import HTTPException

from app.sources.base import SourceError, redact
from app.sources.marketstack import Marketstack
from app.sources.open_meteo import OpenMeteo
from app.sources.weatherstack import Weatherstack
from app.whatif import engine, signals
from app.whatif.schemas import Levers, Profile
from app.whatif.service import demo_profile

KEY = "secretkey123"
WS_401 = {"success": False, "error": {"code": 101, "type": "invalid_access_key",
                                       "info": "You have not supplied a valid API Access Key. [Technical Support: support@apilayer.com]"}}
MS_401 = {"error": {"code": "invalid_access_key", "message": "You have not supplied a valid API Access Key. [Technical Support: support@apilayer.com]"}}
WS_OK = {"request": {"type": "LatLon", "query": "Lat 14.60 and Lon 120.98", "language": "en", "unit": "m"},
         "location": {"name": "Manila", "country": "Philippines", "region": "Manila", "lat": "14.604", "lon": "120.982",
                      "timezone_id": "Asia/Manila", "localtime": "2026-10-23 13:45", "utc_offset": "8.0"},
         "current": {"observation_time": "05:45 AM", "temperature": 31, "weather_code": 116, "weather_descriptions": ["Partly cloudy"],
                     "wind_speed": 13, "precip": 0.1, "humidity": 70, "feelslike": 37, "cloudcover": 50}}
today = date.today()
MS_OK = {"pagination": {"limit": 100, "offset": 0, "count": 3, "total": 3},
         "data": [  # newest first, as Marketstack returns by default
             {"open": 110.0, "high": 112.0, "low": 109.0, "close": 111.0, "volume": 1000.0, "adj_close": 111.0,
              "symbol": "AAPL", "exchange": "XNAS", "date": f"{today - timedelta(days=1)}T00:00:00+0000"},
             {"open": 104.0, "high": 106.0, "low": 103.0, "close": 105.0, "volume": 900.0, "adj_close": 105.0,
              "symbol": "AAPL", "exchange": "XNAS", "date": f"{today - timedelta(days=30)}T00:00:00+0000"},
             {"open": 99.0, "high": 101.0, "low": 98.0, "close": 102.0, "volume": 800.0, "adj_close": 100.0,
              "symbol": "AAPL", "exchange": "XNAS", "date": f"{today - timedelta(days=88)}T00:00:00+0000"}]}
live = pytest.mark.skipif(os.getenv("STARTUP_LIVE_TESTS") != "1", reason="set STARTUP_LIVE_TESTS=1 for live API tests")


def fast(c):
    c.info.min_interval = 0
    return c


def counting(handler):
    calls = []

    def h(req):
        calls.append(str(req.url))
        return handler(req)
    return httpx.MockTransport(h), calls


@pytest.fixture
def keys(monkeypatch):
    monkeypatch.setenv("WHATIF_WEATHERSTACK_API_KEY", KEY)
    monkeypatch.setenv("WHATIF_MARKETSTACK_API_KEY", KEY)


def test_redact_removes_only_credentials():
    assert redact(f"https://x.test/a?access_key={KEY}&symbols=AAPL") == "https://x.test/a?symbols=AAPL"
    assert redact("https://x.test/a?apikey=k&q=1&API_KEY=z") == "https://x.test/a?q=1"
    assert redact("https://x.test/a") == "https://x.test/a"


def test_open_meteo_paid_key_never_recorded(monkeypatch):
    from tests.test_whatif_signals import OM
    t, calls = counting(lambda req: httpx.Response(200, json=OM))
    monkeypatch.setenv("WHATIF_OPEN_METEO_API_KEY", "k123")
    f = fast(OpenMeteo(t)).forecast(10, 10)
    assert "apikey=k123" in calls[0] and "k123" not in f["source_url"]          # sent, but not stored


def test_weatherstack_current_parsing_and_key_kept_out_of_records(keys):
    t, calls = counting(lambda req: httpx.Response(200, json=WS_OK))
    ws = fast(Weatherstack(t))
    r = ws.current(14.5995, 120.9842)
    assert r["temperature"] == 31 and r["weather"] == "Partly cloudy" and r["observation_time_utc"] == "05:45 AM"
    assert r["kind"] == "current_reported" and r["place"] == "Manila, Philippines"
    assert f"access_key={KEY}" in calls[0] and "query=14.5995%2C120.9842" in calls[0] and calls[0].startswith("https://")
    assert KEY not in r["source_url"] and "access_key" not in r["source_url"]
    ws.current(14.5995, 120.9842)
    assert len(calls) == 1                                                       # cached: saves the monthly allowance


def test_apilayer_errors_explained_and_key_never_in_error(keys):
    ws = fast(Weatherstack(httpx.MockTransport(lambda req: httpx.Response(401, json=WS_401))))
    with pytest.raises(SourceError) as e:
        ws.current(1, 1)
    assert e.value.kind == "auth" and "WHATIF_WEATHERSTACK_API_KEY" in e.value.message and KEY not in (e.value.url or "")
    assert KEY not in str(ws.describe())
    ms = fast(Marketstack(httpx.MockTransport(lambda req: httpx.Response(401, json=MS_401))))
    with pytest.raises(SourceError) as e:
        ms.eod("AAPL")
    assert e.value.kind == "auth" and KEY not in (e.value.url or "")
    limit = {"error": {"code": "usage_limit_reached", "message": "Your monthly usage limit has been reached."}}
    ms = fast(Marketstack(httpx.MockTransport(lambda req: httpx.Response(429, json=limit))))
    with pytest.raises(SourceError) as e:
        ms.eod("AAPL")
    assert e.value.kind == "rate_limited"


def test_weatherstack_error_inside_http_200_is_not_cached(keys):
    replies = [httpx.Response(200, json={"success": False, "error": {"code": 104, "type": "usage_limit_reached", "info": "limit"}}),
               httpx.Response(200, json=WS_OK)]
    t, calls = counting(lambda req: replies.pop(0))
    ws = fast(Weatherstack(t))
    with pytest.raises(SourceError) as e:
        ws.current(1, 1)
    assert e.value.kind == "rate_limited" and "100 per month" in e.value.message
    assert ws.current(1, 1)["temperature"] == 31 and len(calls) == 2


def test_not_configured_makes_no_request(monkeypatch):
    monkeypatch.delenv("WHATIF_MARKETSTACK_API_KEY", raising=False)
    t, calls = counting(lambda req: httpx.Response(200, json=MS_OK))
    with pytest.raises(SourceError) as e:
        fast(Marketstack(t)).eod("AAPL")
    assert e.value.kind == "not_configured" and calls == []


def test_marketstack_eod_window_and_adjusted_move(keys):
    t, calls = counting(lambda req: httpx.Response(200, json=MS_OK))
    r = fast(Marketstack(t)).eod("aapl")
    assert r["symbol"] == "AAPL" and r["latest"]["close"] == 111.0 and r["first"]["date"] == str(today - timedelta(days=88))
    assert r["change"] == pytest.approx(111 / 100 - 1) and r["change_basis"] == "adjusted closes"   # not raw 111/102
    assert r["window"]["trading_days"] == 3 and r["exchange"] == "XNAS"
    assert "symbols=AAPL" in calls[0] and "limit=100" in calls[0] and KEY not in r["source_url"]
    with pytest.raises(SourceError):
        fast(Marketstack(t)).eod("AAPL; DROP")
    empty = fast(Marketstack(httpx.MockTransport(lambda req: httpx.Response(200, json={"pagination": {}, "data": []}))))
    with pytest.raises(SourceError) as e:
        empty.eod("ZZZZ")
    assert e.value.kind == "not_found"


def profile(symbol="AAPL"):
    spec = demo_profile()
    spec["external"]["market_symbol"] = symbol
    return Profile.model_validate(spec)


def test_market_signal_relevance_and_unconfigured(monkeypatch):
    monkeypatch.delenv("WHATIF_MARKETSTACK_API_KEY", raising=False)
    assert "market" in signals.relevant(profile()) and "market" not in signals.relevant(profile(""))
    s = signals.fetch(profile(), "market")
    assert s["status"] == "unavailable" and "WHATIF_MARKETSTACK_API_KEY" in s["reason"]
    with pytest.raises(ValueError):
        profile("bad symbol!")


def test_market_signal_and_rule_roundtrip(keys, monkeypatch):
    monkeypatch.setattr(signals, "marketstack", fast(Marketstack(httpx.MockTransport(lambda req: httpx.Response(200, json=MS_OK)))))
    p = profile()
    s = signals.fetch(p, "market")
    assert s["status"] == "ok" and s["kind"] == "observed" and "AAPL on XNAS closed at 111.00" in s["summary"] and "+11.00%" in s["summary"]
    assert KEY not in str(s)
    lv, link = signals.apply_rule(p, Levers(horizon_months=12), {"market": s}, "market_move", {"target": "unit_cost_change_pct", "sensitivity": 0.5})
    assert lv.unit_cost_change_pct == pytest.approx(0.5 * 11, abs=1e-3)
    assert link["signal"] == "market" and link["value"] == 111.0 and link["kind"] == "observed" and "sensitivity 0.5" in link["rule_text"]
    sim = engine.simulate(p, lv)
    assert sim["scenario"]["totals"] != sim["baseline"]["totals"]
    assert signals.remove_link(lv, link["id"]).unit_cost_change_pct == pytest.approx(0)
    with pytest.raises(HTTPException):
        signals.apply_rule(p, Levers(), {"market": s}, "market_move", {"target": "rent_change_pct", "sensitivity": 1})
    with pytest.raises(HTTPException):
        signals.apply_rule(p, Levers(), {"market": s}, "market_move", {"target": "demand_change_pct"})       # sensitivity is the user's
    with pytest.raises(HTTPException):
        signals.apply_rule(p, Levers(demand_change_pct=990), {"market": s}, "market_move", {"target": "demand_change_pct", "sensitivity": 5})


def test_weather_signal_adds_weatherstack_reading_and_survives_its_failure(keys, monkeypatch):
    from tests.test_whatif_signals import OM
    monkeypatch.setattr(signals, "open_meteo", fast(OpenMeteo(httpx.MockTransport(lambda req: httpx.Response(200, json=OM)))))
    p = Profile.model_validate({**demo_profile(), "location": {"city": "Manila", "latitude": 14.5995, "longitude": 120.9842}})
    monkeypatch.setattr(signals, "weatherstack", fast(Weatherstack(httpx.MockTransport(lambda req: httpx.Response(200, json=WS_OK)))))
    s = signals.fetch(p, "weather")
    assert s["status"] == "ok" and s["data"]["reported_now"]["temperature"] == 31
    assert "Reported by Weatherstack (observed 05:45 AM UTC): Partly cloudy, 31 °C" in s["summary"] and "Weatherstack" in s["terms"]
    monkeypatch.setattr(signals, "weatherstack", fast(Weatherstack(httpx.MockTransport(lambda req: httpx.Response(401, json=WS_401)))))
    s = signals.fetch(p, "weather")
    assert s["status"] == "ok" and s["data"]["days"] and s["data"]["reported_now_error"]["source"] == "weatherstack"
    monkeypatch.delenv("WHATIF_WEATHERSTACK_API_KEY")
    s = signals.fetch(p, "weather")
    assert "reported_now" not in s["data"] and "Weatherstack" not in s["terms"]


@live
@pytest.mark.skipif(not os.getenv("WHATIF_WEATHERSTACK_API_KEY"), reason="needs WHATIF_WEATHERSTACK_API_KEY")
def test_live_weatherstack_manila():
    r = Weatherstack().current(14.5995, 120.9842)
    assert r["temperature"] is not None and "access_key" not in r["source_url"]


@live
@pytest.mark.skipif(not os.getenv("WHATIF_MARKETSTACK_API_KEY"), reason="needs WHATIF_MARKETSTACK_API_KEY")
def test_live_marketstack_aapl():
    r = Marketstack().eod("AAPL")
    assert r["latest"]["close"] > 0 and r["window"]["trading_days"] > 30 and "access_key" not in r["source_url"]
