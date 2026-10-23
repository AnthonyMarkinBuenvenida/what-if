"""Frankfurter v2 — official reference exchange rates from central banks.

Docs: https://frankfurter.dev/ (v1 is deprecated but available; What-if uses v2).
Endpoints used (verified live 2026-10-22):
    GET https://api.frankfurter.dev/v2/rates?base=USD&quotes=PHP[&date=&providers=]   latest (or dated) rate
    GET https://api.frankfurter.dev/v2/rates?base=&quotes=&from=&to=[&providers=]     time series
Both return a JSON list of {"date", "base", "quote", "rate"}; unknown currencies get HTTP 422.
    GET https://api.frankfurter.dev/v2/providers
There is no conversion endpoint; What-if multiplies by the published rate and
labels the result as calculated. Rates are reference rates published on working
days, not live market quotes. The default rate blends many central banks;
`providers` restricts it to one (e.g. BSP, Bangko Sentral ng Pilipinas).
"""
from __future__ import annotations

import re

from .base import Connector, SourceError, SourceInfo

CCY = re.compile(r"^[A-Za-z]{3}$")
# Prefer the home country's own central bank for its currency when Frankfurter carries it.
HOME_PROVIDER = {"PHP": "BSP"}


class Frankfurter(Connector):
    info = SourceInfo(
        id="frankfurter", name="Frankfurter exchange rates", base_url="https://api.frankfurter.dev/v2",
        docs_url="https://frankfurter.dev/", min_interval=0.3, cache_seconds=6 * 3600, timeout=15, max_wait=10,
        rate_note="no quotas; requests are rate-limited against abuse (documented)",
    )

    def _check(self, *codes: str) -> None:
        for c in codes:
            if not CCY.match(c or ""):
                raise SourceError(self.info.id, "invalid_request", f"'{c}' is not a three-letter currency code.")

    def providers(self) -> dict[str, dict]:
        f = self.get("/providers")
        return {p["key"]: p for p in f.data if isinstance(p, dict) and "key" in p} if isinstance(f.data, list) else {}

    def _provider_info(self, key: str | None) -> dict | None:
        if not key:
            return None
        try:
            p = self.providers().get(key)
        except SourceError:
            return {"key": key}
        return {k: p.get(k) for k in ("key", "name", "country_code", "rate_type", "data_url")} if p else {"key": key}

    def _pick(self, base: str, quote: str, provider: str | None) -> str | None:
        if provider == "auto":
            return HOME_PROVIDER.get(quote) or HOME_PROVIDER.get(base)
        return provider.upper() if provider else None

    def rate(self, base: str, quote: str, date: str | None = None, provider: str | None = "auto") -> dict:
        base, quote = base.upper(), quote.upper()
        self._check(base, quote)
        prov = self._pick(base, quote, provider)

        def fetch(p):
            return self.get("/rates", {"base": base, "quotes": quote, "date": date, "providers": p})
        try:
            f = fetch(prov)
        except SourceError as exc:
            if exc.kind in ("http", "not_found") and prov:
                # The preferred provider may not publish this pair or date; fall back to the blended rate, and say so.
                f, prov = fetch(None), None
            else:
                raise
        rows = f.data if isinstance(f.data, list) else []
        d = next((r for r in rows if isinstance(r, dict) and str(r.get("quote", "")).upper() == quote), None)
        if d is None and rows == [] and isinstance(f.data, list):
            raise self.fail("not_found", f"Frankfurter has no {base}/{quote} rate{' for ' + date if date else ''}.", f.url)
        if not isinstance(d, dict) or not isinstance(d.get("rate"), (int, float)):
            raise self.fail("invalid_response", "Frankfurter returned an unexpected rate response.", f.url)
        return {"kind": "observed", "source": self.info.id, "base": d.get("base", base), "quote": d.get("quote", quote),
                "rate": d["rate"], "rate_date": d.get("date"), "provider": self._provider_info(prov),
                "provider_note": None if prov else "Blended from several central banks' published reference rates.",
                "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached}

    def series(self, base: str, quote: str, start: str, end: str | None = None, provider: str | None = "auto") -> dict:
        base, quote = base.upper(), quote.upper()
        self._check(base, quote)
        prov = self._pick(base, quote, provider)
        f = self.get("/rates", {"base": base.lower(), "quotes": quote.lower(), "from": start, "to": end, "providers": prov})
        if not isinstance(f.data, list):
            raise self.fail("invalid_response", "Frankfurter returned an unexpected time series.", f.url)
        pts = [{"date": r["date"], "rate": r["rate"]} for r in f.data if isinstance(r, dict) and isinstance(r.get("rate"), (int, float))]
        pts.sort(key=lambda p: p["date"])
        return {"kind": "observed", "source": self.info.id, "base": base, "quote": quote, "points": pts,
                "provider": self._provider_info(prov), "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached}


def convert(amount: float, rate: dict) -> dict:
    """A conversion is calculated by What-if from an observed published rate."""
    return {"kind": "calculated", "value": round(amount * rate["rate"], 4), "amount": amount, "from": rate["base"], "to": rate["quote"],
            "method": f"{amount:g} {rate['base']} × {rate['rate']} ({rate['rate_date']} reference rate)", "inputs": [rate]}


frankfurter = Frankfurter()
