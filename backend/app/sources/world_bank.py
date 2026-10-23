"""World Bank Indicators API (v2) — annual official statistics.

Docs: https://datahelpdesk.worldbank.org/knowledgebase/articles/889392 and
"API Basic Call Structures" (898581). Endpoint used (verified live 2026-10-22; no key):
    GET https://api.worldbank.org/v2/country/{country}/indicator/{code}?format=json&per_page=N
`country` may be ISO2 ("PH") or ISO3 ("PHL"). Rows come newest first; recent years are
often null (e.g. the Philippines lending rate has no value after 2019), so the latest
NON-NULL observation is used and its year is always reported.
Responses are a two-element array [paging metadata, rows]. Errors arrive as
HTTP 200 with [{"message": [...]}], so the body is checked, not the status.
Missing years are kept as missing (value null), never as zero.
"""
from __future__ import annotations

from .base import Connector, SourceInfo

# Indicators that matter for a small retail business, with how What-if may use them.
INDICATORS: dict[str, dict] = {
    "FP.CPI.TOTL.ZG": {"label": "Consumer price inflation", "unit": "% per year", "use": "Supplier-cost and price-change assumptions"},
    "NY.GDP.MKTP.KD.ZG": {"label": "GDP growth", "unit": "% per year", "use": "Demand outlook context"},
    "NE.CON.PRVT.KD.ZG": {"label": "Household consumption growth", "unit": "% per year", "use": "Demand outlook context"},
    "NY.GDP.PCAP.CD": {"label": "GDP per person", "unit": "current US$", "use": "Purchasing-power context"},
    "SL.UEM.TOTL.ZS": {"label": "Unemployment", "unit": "% of labour force", "use": "Labour-market context"},
    "PA.NUS.FCRF": {"label": "Official exchange rate", "unit": "local currency per US$ (yearly average)", "use": "Long-run currency context"},
    "SP.POP.TOTL": {"label": "Population", "unit": "people", "use": "Market-size context"},
    "SP.URB.TOTL.IN.ZS": {"label": "Urban population", "unit": "% of population", "use": "Market-size context"},
    "FR.INR.LEND": {"label": "Lending interest rate", "unit": "%", "use": "Cost of borrowing context"},
}


class WorldBank(Connector):
    info = SourceInfo(
        id="world_bank", name="World Bank Indicators", base_url="https://api.worldbank.org/v2",
        docs_url="https://datahelpdesk.worldbank.org/knowledgebase/articles/889392", min_interval=0.5, cache_seconds=86400,
        timeout=20, max_wait=20, retries=1, rate_note="no documented limit; What-if sends at most 2 requests per second",
    )

    def indicator(self, country: str, code: str, years: int = 15) -> dict:
        f = self.get(f"/country/{country}/indicator/{code}", {"format": "json", "per_page": years})
        d = f.data
        if isinstance(d, list) and d and isinstance(d[0], dict) and "message" in d[0]:
            msg = "; ".join(m.get("value", "") for m in d[0]["message"])
            raise self.fail("not_found", f"World Bank rejected the request: {msg} (country '{country}', indicator '{code}').", f.url)
        if not (isinstance(d, list) and len(d) == 2 and isinstance(d[0], dict)):
            raise self.fail("invalid_response", "World Bank returned an unexpected response.", f.url)
        meta, rows = d[0], d[1] or []
        if not rows:
            # Unknown countries come back as empty paging metadata and null rows.
            raise self.fail("not_found", f"World Bank has no data for country '{country}' and indicator '{code}'.", f.url)
        series = sorted(({"year": r.get("date"), "value": r.get("value")} for r in rows), key=lambda x: x["year"] or "")
        reported = [s for s in series if s["value"] is not None]
        info = INDICATORS.get(code, {})
        latest = reported[-1] if reported else None
        return {
            "kind": "historical", "source": self.info.id, "code": code,
            "label": info.get("label") or (rows[0]["indicator"]["value"] if rows else code),
            "official_name": rows[0]["indicator"]["value"] if rows else None,
            "unit": info.get("unit"), "use": info.get("use"),
            "country": rows[0]["country"]["value"] if rows else country, "country_iso3": rows[0].get("countryiso3code") if rows else None,
            "series": series, "latest": latest, "missing_years": [s["year"] for s in series if s["value"] is None],
            "source_last_updated": meta.get("lastupdated"),
            "source_url": f.url, "page_url": f"https://data.worldbank.org/indicator/{code}?locations={country}",
            "retrieved_at": f.retrieved_at, "cached": f.cached,
        }


world_bank = WorldBank()
