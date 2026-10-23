"""External data (Frankfurter, World Bank, Open-Meteo): parsing, caching, failures, and use in simulations.

Offline tests use responses captured from the real services on 2026-10-22.
Set STARTUP_LIVE_TESTS=1 to also run test_live_* against the real services.
"""
import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.main import app
from app.sources.base import SourceError
from app.sources.frankfurter import Frankfurter
from app.sources.open_meteo import OpenMeteo
from app.sources.world_bank import WorldBank
from app.whatif import engine, signals
from app.whatif.schemas import Levers, Profile
from app.whatif.service import demo_profile

FIX = Path(__file__).parent / "fixtures" / "sources"
H = {"X-StartUp-Client": "web"}
live = pytest.mark.skipif(os.getenv("STARTUP_LIVE_TESTS") != "1", reason="set STARTUP_LIVE_TESTS=1 for live API tests")

# Real World Bank response shape for the Philippines lending rate: newest first, 2020-2025 null.
WB_LENDING = [{"page": 1, "pages": 5, "per_page": 15, "total": 66, "sourceid": "2", "lastupdated": "2026-10-08"},
              [{"indicator": {"id": "FR.INR.LEND", "value": "Lending interest rate (%)"}, "country": {"id": "PH", "value": "Philippines"},
                "countryiso3code": "PHL", "date": str(y), "value": v, "unit": "", "obs_status": "", "decimal": 1}
               for y, v in [(2025, None), (2024, None), (2023, None), (2022, None), (2021, None), (2020, None),
                            (2019, 7.09583333333333), (2018, 6.1185), (2017, 5.62724999999999)]]]
# Real Open-Meteo response for Manila (current + daily), 2026-10-22, trimmed to 3 days.
OM = {"latitude": 14.586995, "longitude": 121.002785, "utc_offset_seconds": 28800, "timezone": "Asia/Manila", "timezone_abbreviation": "GMT+8",
      "current_units": {"time": "iso8601", "interval": "seconds", "temperature_2m": "°C", "relative_humidity_2m": "%", "precipitation": "mm", "weather_code": "wmo code", "wind_speed_10m": "km/h"},
      "current": {"time": "2026-10-22T23:30", "interval": 900, "temperature_2m": 29.3, "relative_humidity_2m": 72, "precipitation": 0.0, "weather_code": 3, "wind_speed_10m": 8.0},
      "daily_units": {"time": "iso8601"}, "daily": {"time": ["2026-10-22", "2026-10-23", "2026-10-24"], "temperature_2m_max": [33.7, 32.0, 31.9],
      "temperature_2m_min": [27.7, 28.3, 27.3], "precipitation_sum": [0.8, 0.3, 3.2], "precipitation_probability_max": [88, 41, 51], "wind_speed_10m_max": [10, 17.7, 16.3]}}


def fast(c):
    c.info.min_interval = 0
    return c


def counting(handler):
    calls = []

    def h(req):
        calls.append(str(req.url))
        return handler(req)
    return httpx.MockTransport(h), calls


def test_frankfurter_v2_rates_parsing_and_cache():
    body = json.loads((FIX / "fx_rates_bsp.json").read_text(encoding="utf-8"))["json"]
    t, calls = counting(lambda req: httpx.Response(200, json=body) if req.url.path.endswith("/rates") else httpx.Response(200, json=[]))
    fx = fast(Frankfurter(t))
    a = fx.rate("USD", "PHP", provider=None)
    b = fx.rate("USD", "PHP", provider=None)
    assert a["rate"] == 63.35 and a["rate_date"] == "2026-10-22" and a["base"] == "USD" and a["quote"] == "PHP"
    assert "/v2/rates?base=USD&quotes=PHP" in a["source_url"]
    assert len([c for c in calls if "/rates" in c]) == 1 and b["cached"] is True   # second call served from cache


def test_frankfurter_unsupported_currency_and_empty_and_offline():
    t, _ = counting(lambda req: httpx.Response(422, json={"status": 422, "message": "invalid currency: XXX"}))
    with pytest.raises(SourceError) as e:
        fast(Frankfurter(t)).rate("USD", "XXX", provider=None)
    assert e.value.status == 422
    t, _ = counting(lambda req: httpx.Response(200, json=[]))
    with pytest.raises(SourceError) as e:
        fast(Frankfurter(t)).rate("USD", "EUR", provider=None)
    assert e.value.kind == "not_found"

    def down(req):
        raise httpx.ConnectError("offline")
    with pytest.raises(SourceError) as e:
        fast(Frankfurter(httpx.MockTransport(down))).rate("USD", "EUR", provider=None)
    assert e.value.kind == "unreachable"


def test_world_bank_latest_non_null_year():
    t, calls = counting(lambda req: httpx.Response(200, json=WB_LENDING))
    wb = fast(WorldBank(t))
    r = wb.indicator("PHL", "FR.INR.LEND")
    assert r["latest"] == {"year": "2019", "value": 7.09583333333333}            # not the first (null) record
    assert set(r["missing_years"]) == {"2020", "2021", "2022", "2023", "2024", "2025"}
    assert r["official_name"] == "Lending interest rate (%)" and r["source_last_updated"] == "2026-10-08"
    assert "per_page=15" in calls[0] and "mrv" not in calls[0]
    wb.indicator("PHL", "FR.INR.LEND")
    assert len(calls) == 1                                                           # cached


def test_open_meteo_current_and_forecast_with_timezone_and_config(monkeypatch):
    t, calls = counting(lambda req: httpx.Response(200, json=OM))
    om = fast(OpenMeteo(t))
    f = om.forecast(14.5995, 120.9842)
    c = f["current"]
    assert c["kind"] == "current_model_estimate" and c["time_local"] == "2026-10-22T23:30:00+08:00" and c["time_utc"] == "2026-10-22T15:30:00+00:00"
    assert c["weather"] == "Overcast" and c["temperature_2m"] == 29.3
    assert f["forecast_period"] == {"from": "2026-10-22", "to": "2026-10-24", "days": 3} and f["kind"] == "forecast"
    assert "current=temperature_2m" in calls[0] and "apikey" not in calls[0]
    monkeypatch.setenv("WHATIF_OPEN_METEO_BASE_URL", "https://customer-api.open-meteo.com/v1")
    monkeypatch.setenv("WHATIF_OPEN_METEO_API_KEY", "k123")
    om.forecast(10, 10)
    assert calls[-1].startswith("https://customer-api.open-meteo.com/v1/forecast") and "apikey=k123" in calls[-1]


def demo():
    return Profile.model_validate(demo_profile())


def sig(**over):
    """Signals as stored after a refresh (shapes produced by signals.fetch)."""
    base = {
        "fx": {**signals._base("fx"), "status": "ok", "retrieved_at": "2026-10-22T15:38:48+00:00", "source_url": "https://api.frankfurter.dev/v2/rates?base=USD&quotes=PHP",
               "data": {"base": "USD", "quote": "PHP", "rate": 63.35, "rate_date": "2026-10-22", "provider": {"name": "Bangko Sentral ng Pilipinas"},
                        "change_90d": 0.04, "reference": {"date": "2026-07-24", "rate": 60.913}}},
        "inflation": {**signals._base("inflation"), "status": "ok", "retrieved_at": "2026-10-22T15:38:40+00:00",
                      "data": {"latest": {"year": "2025", "value": 1.6587364525509}, "official_name": "Inflation, consumer prices (annual %)"}},
        "lending": {**signals._base("lending"), "status": "ok", "retrieved_at": "2026-10-22T15:38:41+00:00",
                    "data": {"latest": {"year": "2019", "value": 7.09583333333333}, "latest_age_years": 7, "official_name": "Lending interest rate (%)"}},
        "weather": {**signals._base("weather"), "status": "ok", "retrieved_at": "2026-10-22T15:38:29+00:00",
                    "data": {"location": "Quezon City", "forecast_period": {"from": "2026-10-22", "to": "2026-11-06", "days": 16},
                             "days": [{"date": f"2026-10-{d}", "precipitation_probability_max": p} for d, p in [(22, 88), (23, 41), (26, 90), (27, 78)]]
                             + [{"date": "2026-11-02", "precipitation_probability_max": 64}]}},
    }
    base.update(over)
    return base


def test_fx_rule_changes_costs_traceably():
    p = demo()
    lv, link = signals.apply_rule(p, Levers(horizon_months=12), sig(), "fx_imported_costs", {})
    assert lv.unit_cost_change_pct == pytest.approx(35 * 0.04)                       # imported share × 90-day move
    assert link["value"] == 63.35 and link["observed_at"] == "2026-10-22" and link["kind"] == "observed"
    assert link["retrieved_at"] == "2026-10-22T15:38:48+00:00" and "imported share" in link["rule_text"].lower()
    hyp, l2 = signals.apply_rule(p, lv, sig(), "fx_imported_costs", {"mode": "hypothetical", "new_rate": 66.5175})
    assert hyp.unit_cost_change_pct == pytest.approx(1.4 + 35 * (66.5175 / 63.35 - 1), abs=1e-3)
    back = signals.remove_link(hyp, l2["id"])
    assert back.unit_cost_change_pct == pytest.approx(1.4) and len(back.data_links) == 1


def test_inflation_rule_documented_and_opt_in():
    p = demo()
    sim0 = engine.simulate(p, Levers(horizon_months=12))
    assert sim0["scenario"]["totals"] == sim0["baseline"]["totals"]                  # data never applied silently
    lv, link = signals.apply_rule(p, Levers(horizon_months=12), sig(), "inflation_costs", {"targets": ["unit_cost_change_pct", "wage_change_pct"]})
    uplift = 1.6587364525509 * (12 / 12) / 2
    assert lv.unit_cost_change_pct == pytest.approx(uplift, abs=1e-4) and lv.wage_change_pct == pytest.approx(uplift, abs=1e-4)
    sim = engine.simulate(p, lv)
    row = next(a for a in sim["assumptions"] if a["key"] == f"data.{link['id']}")
    assert row["source"] == "historical" and "2025" in row["note"] and "retrieved" in row["note"]


def test_lending_rule_adds_interest_cost():
    p = demo()
    lv, link = signals.apply_rule(p, Levers(horizon_months=12), sig(), "lending_interest", {"loan_amount": 200000})
    monthly = 200000 * 7.09583333333333 / 100 / 12
    assert lv.extra_monthly_costs[0].amount == pytest.approx(monthly, abs=0.01)
    assert "2019" in link["rule_text"]                                                # stale year is disclosed
    sim = engine.simulate(p, lv)
    assert sim["delta"]["operating_expenses"]["change"] == pytest.approx(monthly * 12, abs=0.2)
    assert signals.remove_link(lv, link["id"]).extra_monthly_costs == []


def test_weather_rule_uses_forecast_days_only_in_their_month():
    p = demo()
    with pytest.raises(HTTPException):                                                # default start = next month: Oct days excluded
        signals.apply_rule(p, Levers(horizon_months=12, start_month="2026-12"), sig(), "weather_demand", {"demand_change_pct": -30})
    lv, link = signals.apply_rule(p, Levers(horizon_months=12, start_month="2026-10"), sig(), "weather_demand",
                                  {"condition": "rain_probability", "threshold": 70, "demand_change_pct": -30})
    oct_shift = next(s for s in lv.seasonal if s.year_month == "2026-10")
    assert oct_shift.demand_change_pct == pytest.approx(-30 * 3 / 31, abs=1e-3)      # 3 forecast days ≥ 70% in October
    assert all(s.year_month != "2026-11" for s in lv.seasonal)                        # 64% < 70%
    assert link["kind"] == "forecast" and "2026-10-22 to 2026-11-06" in link["observed_at"]
    sim = engine.simulate(p, lv)
    m = {x["month"]: x for x in sim["scenario"]["months"]}
    b = {x["month"]: x for x in sim["baseline"]["months"]}
    assert m["2026-10"]["demand_units"] < b["2026-10"]["demand_units"]
    assert m["2026-11"]["demand_units"] == pytest.approx(b["2026-11"]["demand_units"])  # no effect outside the forecast


def test_missing_or_failed_data_cannot_be_applied_and_stale_is_kept():
    with pytest.raises(HTTPException):
        signals.apply_rule(demo(), Levers(), {}, "inflation_costs", {})
    prev = sig()["inflation"]
    failed = {**signals._base("inflation"), "status": "failed", "error": {"message": "timeout"}, "data": None, "retrieved_at": "2026-10-23T00:00:00+00:00"}
    kept = signals.with_fallback(failed, prev)
    assert kept["status"] == "stale" and kept["data"] == prev["data"] and kept["refresh_error"]["message"] == "timeout" and kept["age_hours"] is not None
    assert signals.with_fallback(failed, None)["status"] == "failed"                  # nothing to fall back on: no invented value
    lv, link = signals.apply_rule(demo(), Levers(), {"inflation": kept}, "inflation_costs", {})
    assert "stale" in link["rule_text"]


def test_apply_endpoint_and_saved_scenario_keep_the_data_record(monkeypatch):
    with TestClient(app) as c:
        c.cookies.clear()
        c.post("/api/workspace", headers=H)
        bid = c.post("/api/whatif/demo", headers=H).json()["business"]["id"]
        monkeypatch.setattr(signals, "fetch", lambda profile, key: sig()[key] if key in sig() else signals._unavailable(key, "test"))
        r = c.post(f"/api/whatif/businesses/{bid}/signals/refresh", headers=H).json()
        assert r["signals"]["fx"]["status"] == "ok" and r["signals"]["lending"]["status"] == "ok"
        a = c.post(f"/api/whatif/businesses/{bid}/signals/apply", headers=H, json={"levers": {"horizon_months": 12}, "rule": "lending_interest", "params": {"loan_amount": 100000}}).json()
        assert a["levers"]["data_links"][0]["source"] == "World Bank Indicators"
        s = c.post(f"/api/whatif/businesses/{bid}/scenarios", headers=H, json={"name": "Loan", "levers": a["levers"]}).json()
        assert s["levers"]["data_links"][0]["observed_at"] == "2019"
        assert any(x["key"].startswith("data.") for x in s["result"]["assumptions"])
        rep = c.post(f"/api/whatif/businesses/{bid}/reports", headers=H, json={"scenario_ids": [s["id"]]}).json()
        assert any(x["key"].startswith("data.") for x in rep["content"]["scenarios"][0]["assumptions"])
        u = c.post(f"/api/whatif/businesses/{bid}/signals/unapply", headers=H, json={"levers": a["levers"], "link_id": a["link"]["id"]}).json()
        assert "data_links" not in u["levers"] and "extra_monthly_costs" not in u["levers"]
        st = c.get("/api/whatif/status").json()
        assert st["weather_provider"] == "open_meteo" and "non-commercial" in st["terms"]["weather"] and "creative" not in st
        assert c.get("/api/whatif/creative/status").status_code == 404                     # TRIBE endpoints are gone


@live
def test_live_frankfurter_v2_rates():
    r = Frankfurter().rate("USD", "PHP", provider=None)
    assert r["rate"] > 0 and r["rate_date"] and "/v2/rates?base=USD&quotes=PHP" in r["source_url"]


@live
def test_live_world_bank_three_indicators():
    for code in ("FP.CPI.TOTL.ZG", "FR.INR.LEND", "NY.GDP.MKTP.KD.ZG"):
        r = WorldBank().indicator("PHL", code)
        assert r["latest"] and r["latest"]["value"] is not None and r["latest"]["year"].isdigit()


@live
def test_live_open_meteo_manila():
    f = OpenMeteo().forecast(14.5995, 120.9842)
    assert f["current"]["time_local"].endswith("+08:00") and f["timezone"] == "Asia/Manila" and len(f["days"]) == 16
