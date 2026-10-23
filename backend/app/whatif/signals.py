"""External signals for a What-if business, and the rules that let them inform a scenario.

    weather    Open-Meteo: current model estimate + 16-day forecast at the business location (kind: forecast)
               + Weatherstack's reported current conditions, when WHATIF_WEATHERSTACK_API_KEY is set
    inflation  World Bank FP.CPI.TOTL.ZG, latest non-null year                                     (kind: historical)
    lending    World Bank FR.INR.LEND, latest non-null year                                        (kind: historical)
    gdp        World Bank NY.GDP.MKTP.KD.ZG, latest non-null year                                  (kind: historical)
    fx         Frankfurter v2 reference rate, foreign currency -> business currency, + 90-day move (kind: observed)
    market     Marketstack end-of-day closes for the profile's ticker, + 90-day move               (kind: observed)

Retrieval: only when the user opens or refreshes signals (no background monitoring).
Connectors cache responses in memory (weather 3 h, World Bank 24 h, Frankfurter 6 h, Marketstack 24 h)
and every retrieval is stored in the database. If a refresh fails, the last good
value is kept and marked "stale" with its age; nothing is invented.

Use in simulations: signals never change a scenario by themselves. The user applies
a rule (apply_rule below); the rule turns the data point into explicit lever changes
and a DataLink record (source, indicator, value, unit, observation/forecast date,
retrieval time, kind, rule text, and the amounts applied). Removing the link removes
exactly those amounts.
"""
from __future__ import annotations

import calendar
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException

from ..sources import frankfurter, marketstack, open_meteo, weatherstack, world_bank
from ..sources.base import SourceError, utcnow_iso
from ..sources.open_meteo import provider as weather_provider
from .industries import INDUSTRIES
from .schemas import Levers, Profile

LABELS = {
    "weather": ("Weather (current and forecast)", "Open-Meteo", "forecast", "https://open-meteo.com/en/docs"),
    "inflation": ("Consumer price inflation", "World Bank Indicators", "historical", "https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG"),
    "lending": ("Lending interest rate", "World Bank Indicators", "historical", "https://data.worldbank.org/indicator/FR.INR.LEND"),
    "gdp": ("GDP growth", "World Bank Indicators", "historical", "https://data.worldbank.org/indicator/NY.GDP.MKTP.KD.ZG"),
    "fx": ("Exchange rate", "Frankfurter", "observed", "https://frankfurter.dev"),
    "market": ("Stock price", "Marketstack", "observed", "https://marketstack.com/documentation"),
}
WB_CODES = {"inflation": "FP.CPI.TOTL.ZG", "lending": "FR.INR.LEND", "gdp": "NY.GDP.MKTP.KD.ZG"}
TERMS = {
    "weather": "Open-Meteo free API: non-commercial use only, under 10,000 calls/day; data CC-BY 4.0 (attribution: Weather data by Open-Meteo.com). Commercial use needs a paid plan or another provider.",
    "inflation": "World Bank Indicators: CC-BY 4.0, no key required.",
    "lending": "World Bank Indicators: CC-BY 4.0, no key required.",
    "gdp": "World Bank Indicators: CC-BY 4.0, no key required.",
    "fx": "Frankfurter: free and keyless, published central-bank reference rates (not live market quotes).",
    "market": "Marketstack free plan: end-of-day prices only (no intraday), 1 year of history, 100 requests/month, non-commercial use. Needs WHATIF_MARKETSTACK_API_KEY.",
}
WEATHERSTACK_TERMS = " Current conditions also from Weatherstack (free plan: current weather only, 100 requests/month, non-commercial use)."


def relevant(profile: Profile) -> list[str]:
    wanted = set(INDUSTRIES[profile.industry]["external"]) | {"inflation", "lending", "gdp"}
    if profile.external.imported_cost_share_pct:
        wanted.add("fx")
    if profile.external.market_symbol:
        wanted.add("market")
    out = []
    for key in ("weather", "inflation", "lending", "gdp", "fx", "market"):
        if key not in wanted:
            continue
        if key == "fx" and profile.external.foreign_currency == profile.business.currency:
            continue
        out.append(key)
    return out


def _base(key: str) -> dict:
    label, source, kind, docs = LABELS[key]
    return {"key": key, "label": label, "source": source, "kind": kind, "docs_url": docs, "terms": TERMS[key]}


def _unavailable(key: str, reason: str) -> dict:
    return {**_base(key), "status": "unavailable", "reason": reason, "data": None, "retrieved_at": None, "source_url": None}


def _ok(key: str, data: dict, summary: str) -> dict:
    return {**_base(key), "status": "ok", "summary": summary, "data": data, "retrieved_at": data.get("retrieved_at"),
            "source_url": data.get("source_url"), "cached": data.get("cached")}


def _failed(key: str, err: SourceError) -> dict:
    return {**_base(key), "status": "failed", "error": err.as_dict(), "data": None, "retrieved_at": utcnow_iso(), "source_url": err.url}


def fetch(profile: Profile, key: str) -> dict:
    country = profile.business.country
    try:
        if key == "weather":
            if weather_provider() == "none":
                return _unavailable(key, "Weather is turned off (WHATIF_WEATHER_PROVIDER=none).")
            loc = profile.location
            if loc.latitude is None or loc.longitude is None:
                return _unavailable(key, "Add the business location in Business setup to get a local forecast.")
            d = open_meteo.forecast(loc.latitude, loc.longitude)
            d["location"] = loc.city or f"{loc.latitude:.3f}, {loc.longitude:.3f}"
            days = d["days"]
            rain = [x.get("precipitation_sum") or 0 for x in days]
            highs = [x["temperature_2m_max"] for x in days if x.get("temperature_2m_max") is not None]
            cur = d.get("current") or {}
            now = f"Now (model estimate, {cur['time_local'][11:16]} local): {cur.get('weather')}, {cur.get('temperature_2m')} °C. " if cur else ""
            d.setdefault("forecast_period", {"from": days[0]["date"], "to": days[-1]["date"], "days": len(days)} if days else {"from": None, "to": None, "days": 0})
            fc = f"Forecast {d['forecast_period']['from']} to {d['forecast_period']['to']}: highs {min(highs):.0f}–{max(highs):.0f} °C, up to {max(rain):.0f} mm rain in a day." if highs else "Forecast received."
            if not weatherstack.configured():
                return _ok(key, d, now + fc)
            try:  # optional second reading; its failure never hides the forecast
                ws = d["reported_now"] = weatherstack.current(loc.latitude, loc.longitude)
                now += f"Reported by Weatherstack (observed {ws['observation_time_utc']} UTC): {ws.get('weather') or 'conditions not described'}, {ws['temperature']} °C. "
            except SourceError as exc:
                d["reported_now_error"] = exc.as_dict()
            out = _ok(key, d, now + fc)
            out["terms"] += WEATHERSTACK_TERMS
            return out
        if key in WB_CODES:
            if len(country) != 2:
                return _unavailable(key, "Add the business country in Business setup.")
            d = world_bank.indicator(country, WB_CODES[key])
            latest = d.get("latest")
            if not latest:
                return _unavailable(key, f"World Bank has no reported value for {d.get('country') or country} in the last 15 years.")
            age = date.today().year - int(latest["year"])
            d["latest_age_years"] = age
            note = f" Latest reported year is {age} years old; later years are not published." if age >= 3 else ""
            return _ok(key, d, f"{latest['value']:.2f}% in {latest['year']} ({d.get('country')}).{note}")
        if key == "fx":
            foreign, cur = profile.external.foreign_currency, profile.business.currency
            r = frankfurter.rate(foreign, cur)
            start = (date.today() - timedelta(days=90)).isoformat()
            try:
                s = frankfurter.series(foreign, cur, start)
                pts = s["points"]
                change = (pts[-1]["rate"] / pts[0]["rate"] - 1) if len(pts) >= 2 else None
                ref = pts[0] if pts else None
            except SourceError:
                pts, change, ref = [], None, None
            d = {**r, "series": pts, "change_90d": change, "reference": ref}
            return _ok(key, d, f"1 {foreign} = {r['rate']:,.4g} {cur} (reference rate dated {r['rate_date']})"
                       + (f"; {change * 100:+.2f}% since {ref['date']}" if change is not None else "") + ".")
        if key == "market":
            if not marketstack.configured():
                return _unavailable(key, "Add a free Marketstack API key as WHATIF_MARKETSTACK_API_KEY in backend/.env, then restart What-if.")
            d = marketstack.eod(profile.external.market_symbol)
            last, first = d["latest"], d["first"]
            ccy = f" {d['price_currency'].upper()}" if d.get("price_currency") else ""
            where = f" on {d['exchange']}" if d.get("exchange") else ""
            move = f"; {d['change'] * 100:+.2f}% since {first['date']} ({d['change_basis']})" if d["change"] is not None else ""
            return _ok(key, d, f"{d['symbol']}{where} closed at {last['close']:,.2f}{ccy} on {last['date']} (end of day){move}.")
    except SourceError as exc:
        return _failed(key, exc)
    return _unavailable(key, "Unknown signal.")


def with_fallback(new: dict, previous: dict | None) -> dict:
    """Keep the last good value when a refresh fails, marked stale with its age."""
    if new["status"] == "failed" and previous and previous.get("status") in ("ok", "stale") and previous.get("data"):
        kept = {**previous, "status": "stale", "refresh_error": new.get("error"), "refresh_failed_at": new.get("retrieved_at")}
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(previous["retrieved_at"])
            kept["age_hours"] = round(age.total_seconds() / 3600, 1)
        except (TypeError, ValueError):
            kept["age_hours"] = None
        return kept
    return new


def fetch_all(profile: Profile, previous: dict | None = None) -> dict:
    previous = previous or {}
    return {k: with_fallback(fetch(profile, k), previous.get(k)) for k in relevant(profile)}


# ---------------------------------------------------------------- apply rules

RULES = {
    "fx_imported_costs": {"signal": "fx", "label": "Exchange-rate move on imported costs",
                          "text": "Variable cost change = imported share × exchange-rate change ({move})."},
    "inflation_costs": {"signal": "inflation", "label": "Costs rise with published inflation",
                        "text": "If costs rise steadily at the latest annual inflation rate, their average level over a {h}-month period is rate × (h ÷ 12) ÷ 2 higher. Applied to: {targets}."},
    "lending_interest": {"signal": "lending", "label": "Interest on a loan at the published lending rate",
                         "text": "Monthly interest = loan amount × annual lending rate ÷ 12, added to operating costs (principal and repayments not modelled)."},
    "weather_demand": {"signal": "weather", "label": "Your demand adjustment on forecast weather days",
                       "text": "Demand in a month changes by your adjustment × (forecast days meeting the condition ÷ days in that month). The adjustment is yours; the day count comes from the forecast."},
    "market_move": {"signal": "market", "label": "Your sensitivity to a stock's observed price move",
                    "text": "Variable cost or demand change = your sensitivity × the stock's observed price change. The sensitivity is yours; the price change comes from end-of-day closes."},
}
MARKET_TARGETS = {"unit_cost_change_pct": "Variable cost", "demand_change_pct": "Demand"}


def _need(cond, msg: str):
    if not cond:
        raise HTTPException(422, msg)


def _signal_ok(signals: dict, key: str) -> dict:
    s = signals.get(key)
    _need(s and s.get("status") in ("ok", "stale") and s.get("data"), f"No retrieved {LABELS[key][0].lower()} is available. Refresh external data first.")
    return s


def apply_rule(profile: Profile, levers: Levers, signals: dict, rule: str, params: dict) -> tuple[Levers, dict]:
    """Return new levers with the rule applied, plus the DataLink that documents it."""
    _need(rule in RULES, f"Unknown rule '{rule}'.")
    meta = RULES[rule]
    s = _signal_ok(signals, meta["signal"])
    d = s["data"]
    lv = levers.model_dump()
    applied: dict = {}
    H = levers.horizon_months

    def add(lever: str, amount: float):
        amount = round(amount, 4)
        lv[lever] = round((lv.get(lever) or 0) + amount, 4)
        applied[lever] = amount

    if rule == "fx_imported_costs":
        share = params.get("imported_share_pct", profile.external.imported_cost_share_pct)
        _need(share is not None and 0 <= float(share) <= 100, "Enter the share of variable costs priced in the foreign currency (0–100%).")
        mode = params.get("mode", "observed_90d")
        if mode == "hypothetical":
            new_rate = float(params.get("new_rate") or 0)
            _need(new_rate > 0, "Enter the exchange rate to test.")
            change = new_rate / d["rate"] - 1
            move = f"tested rate {new_rate:g} vs {d['rate']:g} on {d['rate_date']} = {change * 100:+.2f}%"
        else:
            _need(d.get("change_90d") is not None, "The 90-day exchange-rate history could not be retrieved; test a specific rate instead.")
            change = d["change_90d"]
            move = f"observed change since {d['reference']['date']} = {change * 100:+.2f}%"
        add("unit_cost_change_pct", float(share) * change)
        value, unit, observed = d["rate"], f"{d['quote']} per {d['base']}", d["rate_date"]
        indicator = f"{d['base']}→{d['quote']} reference rate" + (f" ({d['provider']['name']})" if d.get("provider") and d["provider"].get("name") else "")
        text = meta["text"].format(move=move) + f" Imported share {float(share):g}%."
        params = {"imported_share_pct": float(share), "mode": mode, **({"new_rate": params.get("new_rate")} if mode == "hypothetical" else {})}
    elif rule == "inflation_costs":
        targets = [t for t in params.get("targets", ["unit_cost_change_pct"]) if t in ("unit_cost_change_pct", "wage_change_pct", "fixed_cost_change_pct")]
        _need(targets, "Choose at least one cost to apply inflation to.")
        rate = d["latest"]["value"]
        uplift = rate * (H / 12) / 2
        for t in targets:
            add(t, uplift)
        value, unit, observed = rate, "% per year", d["latest"]["year"]
        indicator = d.get("official_name") or "Inflation, consumer prices (annual %)"
        names = {"unit_cost_change_pct": "variable costs", "wage_change_pct": "wages", "fixed_cost_change_pct": "other fixed costs"}
        text = meta["text"].format(h=H, targets=", ".join(names[t] for t in targets)) + f" {rate:.2f}% × ({H} ÷ 12) ÷ 2 = {uplift:.2f}%."
        params = {"targets": targets}
    elif rule == "lending_interest":
        amount = float(params.get("loan_amount") or 0)
        _need(amount > 0, "Enter the loan amount.")
        rate = d["latest"]["value"]
        monthly = amount * rate / 100 / 12
        lv.setdefault("extra_monthly_costs", []).append({"label": f"Interest on {amount:,.0f} at {rate:.2f}%", "amount": round(monthly, 2)})
        applied["extra_monthly_costs"] = round(monthly, 2)
        value, unit, observed = rate, "% per year", d["latest"]["year"]
        indicator = d.get("official_name") or "Lending interest rate (%)"
        text = meta["text"] + f" {amount:,.0f} × {rate:.2f}% ÷ 12 = {monthly:,.2f} per month."
        if d.get("latest_age_years", 0) >= 3:
            text += f" Note: the latest published rate is from {d['latest']['year']}."
        params = {"loan_amount": amount}
    elif rule == "market_move":
        target = params.get("target", "unit_cost_change_pct")
        _need(target in MARKET_TARGETS, "Choose variable costs or demand.")
        sens = params.get("sensitivity")
        _need(sens is not None and -5 <= float(sens) <= 5, "Enter your sensitivity to the price move (−5 to 5; 0.5 = half of the move, −1 = the opposite direction).")
        _need(d.get("change") is not None, "Only one trading day was retrieved, so there is no price move to apply.")
        effect = float(sens) * d["change"] * 100
        low = -95 if target == "unit_cost_change_pct" else -100
        _need(low <= (lv.get(target) or 0) + effect <= 1000, f"That would move {MARKET_TARGETS[target].lower()} by {effect:+.1f}%, outside what the model accepts ({low}% to +1000% in total).")
        add(target, effect)
        value, unit, observed = d["latest"]["close"], (d.get("price_currency") or "").upper()[:10] or "per share", d["latest"]["date"]
        indicator = f"{d['symbol']} end-of-day close" + (f" ({d['exchange']})" if d.get("exchange") else "")
        text = meta["text"] + f" Applied to {MARKET_TARGETS[target].lower()}. {d['first']['date']} to {d['latest']['date']}: {d['change'] * 100:+.2f}% ({d['change_basis']}); sensitivity {float(sens):g} → {effect:+.2f}%."
        params = {"target": target, "sensitivity": float(sens)}
    else:  # weather_demand
        cond = params.get("condition", "rain_probability")
        threshold = float(params.get("threshold", 70))
        pct = params.get("demand_change_pct")
        _need(pct is not None and -100 <= float(pct) <= 200, "Enter your demand adjustment for those days (−100% to +200%).")
        field = {"rain_probability": "precipitation_probability_max", "rain_mm": "precipitation_sum", "heat": "temperature_2m_max"}.get(cond)
        _need(field, "Condition must be rain_probability, rain_mm or heat.")
        start = levers.start_month or "%04d-%02d" % (date.today().year + (date.today().month == 12), date.today().month % 12 + 1)
        end_y, end_m = int(start[:4]), int(start[5:7]) + H - 1
        end_y, end_m = end_y + (end_m - 1) // 12, (end_m - 1) % 12 + 1
        end = f"{end_y:04d}-{end_m:02d}"
        by_month: dict[str, int] = {}
        for day in d["days"]:
            v = day.get(field)
            if v is not None and v >= threshold:
                ym = day["date"][:7]
                if start <= ym <= end:
                    by_month[ym] = by_month.get(ym, 0) + 1
        _need(by_month, f"No forecast day inside the simulation period ({start} to {end}) meets the condition. The forecast covers {d['forecast_period']['from']} to {d['forecast_period']['to']}; start the scenario in the current month to use it.")
        shifts = []
        for ym, n in sorted(by_month.items()):
            y, m = int(ym[:4]), int(ym[5:])
            effect = float(pct) * n / calendar.monthrange(y, m)[1]
            lv.setdefault("seasonal", []).append({"months": [m], "demand_change_pct": round(effect, 3), "label": f"Forecast weather {ym}", "year_month": ym})
            shifts.append({"year_month": ym, "days": n, "demand_change_pct": round(effect, 3)})
        applied["seasonal"] = shifts
        unit_name = {"rain_probability": "% rain probability", "rain_mm": "mm rain", "heat": "°C max"}[cond]
        value, unit = threshold, unit_name
        observed = f"forecast {d['forecast_period']['from']} to {d['forecast_period']['to']}"
        indicator = f"Forecast days with {unit_name} ≥ {threshold:g} at {d.get('location', 'the business location')}"
        text = meta["text"] + f" Your adjustment: {float(pct):+g}% on those days. " + "; ".join(f"{x['year_month']}: {x['days']} day(s) → {x['demand_change_pct']:+.2f}%" for x in shifts) + "."
        params = {"condition": cond, "threshold": threshold, "demand_change_pct": float(pct)}

    link = {"id": uuid.uuid4().hex[:12], "signal": meta["signal"], "rule": rule, "source": s["source"], "indicator": indicator,
            "value": value, "unit": unit, "observed_at": str(observed), "retrieved_at": s.get("retrieved_at"), "kind": s["kind"],
            "rule_text": text + (" (Data was stale when applied.)" if s["status"] == "stale" else ""), "params": params, "applied": applied,
            "source_url": s.get("source_url")}
    lv.setdefault("data_links", []).append(link)
    return Levers.model_validate(lv), link


def remove_link(levers: Levers, link_id: str) -> Levers:
    """Undo exactly what one DataLink added."""
    lv = levers.model_dump()
    link = next((x for x in lv.get("data_links", []) if x["id"] == link_id), None)
    _need(link, "That data link is not part of this scenario.")
    for lever, amount in link["applied"].items():
        if lever == "extra_monthly_costs":
            costs = lv.get("extra_monthly_costs", [])
            idx = next((i for i, c in enumerate(costs) if abs(c["amount"] - amount) < 0.01), None)
            if idx is not None:
                costs.pop(idx)
        elif lever == "seasonal":
            months = {x["year_month"] for x in amount}
            lv["seasonal"] = [s for s in lv.get("seasonal", []) if not (s.get("year_month") in months and s.get("label", "").startswith("Forecast weather"))]
        else:
            lv[lever] = round((lv.get(lever) or 0) - amount, 4)
    lv["data_links"] = [x for x in lv["data_links"] if x["id"] != link_id]
    return Levers.model_validate(lv)


def rules_catalog() -> list[dict]:
    return [{"id": k, "signal": v["signal"], "label": v["label"], "rule": v["text"]} for k, v in RULES.items()]
