"""Marketstack: end-of-day stock prices for one ticker (apilayer, API key required).

Docs: https://marketstack.com/documentation
Endpoint used: GET https://api.marketstack.com/v2/eod?access_key=..&symbols=<TICKER>&date_from=..&date_to=..&limit=100
Plans (https://marketstack.com/product, 2026-10-23): the free plan has end-of-day data with
1 year of history, 100 requests/month, non-commercial use. No intraday or real-time prices.

One request returns the whole 90-day window, so the latest close and the 90-day move cost a
single call. Responses are cached for 24 h (end-of-day data changes once per trading day).

Labelling: closes are recorded prices (kind "observed"), dated by trading day. The 90-day move
uses adjusted closes (splits and dividends) when both ends have them, otherwise raw closes,
and says which.

Configuration (backend/.env):
    WHATIF_MARKETSTACK_API_KEY    your key; leave unset to hide the stock-price signal's data
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from .apilayer import ApiLayer
from .base import SourceInfo

SYMBOL = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,19}$")


class Marketstack(ApiLayer):
    key_env = "WHATIF_MARKETSTACK_API_KEY"
    info = SourceInfo(
        id="marketstack", name="Marketstack", base_url="https://api.marketstack.com/v2",
        docs_url="https://marketstack.com/documentation", min_interval=1.0, cache_seconds=24 * 3600,
        timeout=20, max_wait=10, retries=1,
        rate_note="free plan: 100 requests/month, end-of-day only, 1 year history, non-commercial",
    )

    def eod(self, symbol: str, days: int = 90) -> dict:
        symbol = (symbol or "").strip().upper()
        if not SYMBOL.match(symbol):
            raise self.fail("invalid_request", f"'{symbol}' is not a ticker symbol (letters, digits, '.' or '-', e.g. AAPL or JFC.XPHS).")
        today = date.today()
        f = self.call("/eod", {"symbols": symbol, "date_from": (today - timedelta(days=days)).isoformat(), "date_to": today.isoformat(), "limit": 100})
        rows = f.data.get("data") if isinstance(f.data, dict) else None
        if not isinstance(rows, list):
            raise self.fail("invalid_response", "Marketstack returned no price list.", f.url)
        points = []
        for r in rows:
            if not isinstance(r, dict) or r.get("close") is None or not r.get("date"):
                continue
            if (r.get("symbol") or symbol).upper() != symbol:
                continue
            points.append({"date": str(r["date"])[:10], "close": r["close"], "adj_close": r.get("adj_close"),
                           "open": r.get("open"), "high": r.get("high"), "low": r.get("low"), "volume": r.get("volume"),
                           "exchange": r.get("exchange"), "price_currency": r.get("price_currency")})
        if not points:
            raise self.fail("not_found", f"Marketstack has no end-of-day prices for {symbol} in the last {days} days.", f.url)
        points.sort(key=lambda p: p["date"])
        first, latest = points[0], points[-1]
        adjusted = first.get("adj_close") is not None and latest.get("adj_close") is not None
        a, b = (first["adj_close"], latest["adj_close"]) if adjusted else (first["close"], latest["close"])
        change = (b / a - 1) if len(points) >= 2 and a else None
        return {
            "kind": "observed", "source": self.info.id, "symbol": symbol, "exchange": latest.get("exchange"),
            "price_currency": latest.get("price_currency"), "points": points, "first": first, "latest": latest,
            "change": change, "change_basis": "adjusted closes" if adjusted else "closes",
            "window": {"from": first["date"], "to": latest["date"], "trading_days": len(points)},
            "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached,
        }


marketstack = Marketstack()
