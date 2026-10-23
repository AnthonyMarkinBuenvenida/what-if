"""Open Prices (Open Food Facts) — crowdsourced, receipt- or photo-backed price observations.

Docs and schema: https://prices.openfoodfacts.org/api/docs (OpenAPI at /api/schema).
Endpoints used (all GET, verified live):
    /api/v1/locations/osm/countries                       per-country location and price counts
    /api/v1/locations/osm/countries/{cc}/cities           per-city counts in one country
    /api/v1/locations?osm_address_country__like=…         shop locations (paginated)
    /api/v1/locations?osm_address_city__like=…
    /api/v1/prices?location_id__in=…&order_by=-date       price observations (paginated)
    /api/v1/prices?product_code=…

Important behaviour found while verifying the API:
- /prices has no country filter. Unknown query parameters are ignored silently,
  so filtering must go through location ids.
- A country's locations can carry different country names (the Philippines
  appears as both "Philippines" and "Pilipinas"), so locations are gathered
  for every name variant and reconciled against the per-country counts.
- Each price is one shopper's record from one shop on one day. It is never a
  market average, and a product without a recent record has no known current price.
"""
from __future__ import annotations

from collections import Counter
from datetime import date, datetime, timezone

from .base import Connector, SourceError, SourceInfo

WEB = "https://prices.openfoodfacts.org"
# Local-language country names seen in Open Prices location data, in addition
# to the names the countries endpoint reports.
COUNTRY_NAME_ALIASES: dict[str, list[str]] = {"PH": ["Pilipinas"]}
LOCAL_CURRENCY: dict[str, str] = {"PH": "PHP", "FR": "EUR", "DE": "EUR", "US": "USD", "GB": "GBP", "NO": "NOK", "SE": "SEK", "IN": "INR"}
PAGE_SIZE = 100


class OpenPrices(Connector):
    info = SourceInfo(
        id="open_prices", name="Open Prices", base_url=f"{WEB}/api/v1", docs_url=f"{WEB}/api/docs",
        min_interval=1.0, cache_seconds=900, timeout=20, max_wait=20,
        rate_note="no documented limit; What-if sends at most 1 request per second",
    )

    # ------------------------------------------------------------ countries
    def countries(self) -> tuple[list[dict], dict]:
        f = self.get("/locations/osm/countries", {"size": 300})
        items = f.data.get("items") if isinstance(f.data, dict) else f.data
        if not isinstance(items, list) or not all(isinstance(c, dict) and "country_code_2" in c for c in items):
            raise self.fail("invalid_response", "Open Prices returned an unexpected country list.", f.url)
        return items, f.provenance(self.info.id)

    def country_summary(self, cc: str) -> tuple[dict | None, dict]:
        items, prov = self.countries()
        cc = cc.upper()
        hit = next((c for c in items if (c.get("country_code_2") or "").upper() == cc), None)
        return hit, prov

    def cities(self, cc: str) -> list[dict]:
        f = self.get(f"/locations/osm/countries/{cc.upper()}/cities", {"size": 300})
        items = f.data.get("items") if isinstance(f.data, dict) else f.data
        return items if isinstance(items, list) else []

    def _locations(self, params: dict) -> list[dict]:
        out, page = [], 1
        while True:
            f = self.get("/locations", {**params, "size": PAGE_SIZE, "page": page})
            if not isinstance(f.data, dict) or "items" not in f.data:
                raise self.fail("invalid_response", "Open Prices returned an unexpected location list.", f.url)
            out += f.data["items"]
            if page >= int(f.data.get("pages") or 1) or page >= 20:
                return out
            page += 1

    def country_locations(self, cc: str, summary: dict | None) -> tuple[list[dict], list[str]]:
        """Locations in a country, found by every known name variant, then by city if counts don't reconcile."""
        cc = cc.upper()
        notes: list[str] = []
        names = {n for n in ((summary or {}).get("name"), (summary or {}).get("osm_name")) if n} | set(COUNTRY_NAME_ALIASES.get(cc, []))
        found: dict[int, dict] = {}
        for name in sorted(names):
            for loc in self._locations({"osm_address_country__like": name}):
                if (loc.get("osm_address_country_code") or "").upper() == cc:
                    found[loc["id"]] = loc
        expected = (summary or {}).get("location_count")
        if expected and len(found) < expected:
            notes.append(f"Country-name search found {len(found)} of {expected} locations; searching city by city for the rest.")
            for city in self.cities(cc):
                for loc in self._locations({"osm_address_city__like": city.get("osm_name", "")}):
                    if (loc.get("osm_address_country_code") or "").upper() == cc:
                        found[loc["id"]] = loc
        if len(names) > 1:
            notes.append(f"Locations in this country use different country names in Open Prices ({', '.join(sorted(names))}); all were included.")
        return list(found.values()), notes

    # --------------------------------------------------------------- prices
    def _prices(self, params: dict, max_items: int) -> tuple[list[dict], int, list[str]]:
        items, page, total, urls = [], 1, 0, []
        while len(items) < max_items:
            f = self.get("/prices", {**params, "size": PAGE_SIZE, "page": page, "order_by": "-date"})
            if not isinstance(f.data, dict) or "items" not in f.data or "total" not in f.data:
                raise self.fail("invalid_response", "Open Prices returned an unexpected price list.", f.url)
            total = int(f.data["total"])
            items += f.data["items"]
            urls.append(f.url)
            if page >= int(f.data.get("pages") or 1):
                break
            page += 1
        return items[:max_items], total, urls

    def country_observations(self, cc: str, max_items: int = 500) -> dict:
        cc = cc.upper()
        summary, prov = self.country_summary(cc)
        retrieved_at = prov["retrieved_at"]
        if summary is None:
            return {"country_code": cc, "observations": [], "coverage": _empty_coverage(cc, "Open Prices has no locations in this country."),
                    "source_urls": [prov["url"]], "retrieved_at": retrieved_at}
        locs, notes = self.country_locations(cc, summary)
        if not locs:
            return {"country_code": cc, "observations": [], "coverage": _empty_coverage(cc, "No shop locations could be found for this country."),
                    "source_urls": [prov["url"]], "retrieved_at": retrieved_at}
        ids = ",".join(str(l["id"]) for l in sorted(locs, key=lambda l: l["id"]))
        raw, total, urls = self._prices({"location_id__in": ids}, max_items)
        obs = [normalize_price(p, retrieved_at) for p in raw]
        cov = coverage(cc, obs, summary, len(locs), total, notes)
        return {"country_code": cc, "country_name": summary.get("name"), "observations": obs, "coverage": cov,
                "source_urls": [prov["url"], *urls], "retrieved_at": retrieved_at}

    def product_observations(self, code: str, cc: str | None = None, max_items: int = 200) -> dict:
        raw, total, urls = self._prices({"product_code": code}, max_items)
        retrieved = _now()
        obs = [normalize_price(p, retrieved) for p in raw]
        if cc:
            obs = [o for o in obs if (o["location"] or {}).get("country_code") == cc.upper()]
        return {"product_code": code, "country_code": cc, "observations": obs, "total_worldwide": total, "source_urls": urls, "retrieved_at": retrieved}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_price(p: dict, retrieved_at: str) -> dict:
    loc = p.get("location") or {}
    proof = p.get("proof") or {}
    prod = p.get("product") or {}
    return {
        "kind": "observed",
        "source": "open_prices",
        "id": p.get("id"),
        "price": p.get("price"),
        "currency": p.get("currency"),
        "price_per": p.get("price_per"),
        "is_discounted": bool(p.get("price_is_discounted")),
        "price_without_discount": p.get("price_without_discount"),
        "observed_on": p.get("date"),
        "recorded_at": p.get("created"),
        "type": p.get("type"),
        "product_code": p.get("product_code"),
        "category_tag": p.get("category_tag"),
        "name_entered": p.get("product_name"),
        "product": {
            # Product metadata comes from Open Food Facts, synced into Open Prices.
            "name": prod.get("product_name"), "brands": prod.get("brands"), "quantity": prod.get("quantity"),
            "categories_tags": prod.get("categories_tags") or [], "image_url": prod.get("image_url"),
            "source": prod.get("source"), "synced_at": prod.get("source_last_synced"),
        } if prod else None,
        "location": {
            "id": loc.get("id"), "name": loc.get("osm_name"), "city": loc.get("osm_address_city"),
            "country": loc.get("osm_address_country"), "country_code": (loc.get("osm_address_country_code") or "").upper() or None,
            "type": loc.get("type"), "osm_type": loc.get("osm_type"), "osm_id": loc.get("osm_id"),
        } if loc else None,
        "evidence": {
            "proof_type": proof.get("type"),
            "proof_image_url": f"{WEB}/img/{proof['file_path']}" if proof.get("file_path") else None,
            "proof_thumb_url": f"{WEB}/img/{proof['image_thumb_path']}" if proof.get("image_thumb_path") else None,
        } if proof else None,
        "source_url": f"{WEB}/prices/{p.get('id')}",
        "api_url": f"{WEB}/api/v1/prices/{p.get('id')}",
        "retrieved_at": retrieved_at,
    }


def _age_days(d: str | None) -> int | None:
    if not d:
        return None
    try:
        return (date.today() - date.fromisoformat(d[:10])).days
    except ValueError:
        return None


def freshness(age_days: int | None) -> str:
    if age_days is None:
        return "none"
    return "current" if age_days <= 30 else "aging" if age_days <= 180 else "stale"


def _empty_coverage(cc: str, reason: str) -> dict:
    return {"country_code": cc, "sufficient": False, "observations": 0, "statements": [reason,
            "Upload your own price list or sales data (Digital Twin → Import data) to use real prices in simulations."]}


def coverage(cc: str, obs: list[dict], summary: dict, locations_found: int, total_reported_by_query: int, notes: list[str]) -> dict:
    """What the data can and cannot support. Nothing here fills gaps."""
    local = LOCAL_CURRENCY.get(cc) or (Counter(o["currency"] for o in obs if o["currency"]).most_common(1) or [(None, 0)])[0][0]
    dates = sorted(o["observed_on"] for o in obs if o["observed_on"])
    latest_age = _age_days(dates[-1]) if dates else None
    by_product = Counter(o["product_code"] for o in obs if o["product_code"])
    mismatched = [o for o in obs if local and o["currency"] and o["currency"] != local]
    no_currency = sum(1 for o in obs if not o["currency"])
    with_meta = sum(1 for o in obs if o["product"] and o["product"]["name"])
    last_90 = sum(1 for o in obs if (_age_days(o["observed_on"]) or 10**6) <= 90)
    reported_prices = summary.get("price_count")
    stmts = list(notes)
    stmts.append(f"Open Prices reports {reported_prices} price records and {summary.get('location_count')} shop locations for this country; "
                 f"What-if retrieved {len(obs)} records from {locations_found} locations.")
    if reported_prices is not None and len(obs) != reported_prices:
        stmts.append("The retrieved count differs from the reported count; the country totals may include records What-if could not reach through location filters.")
    stmts.append(f"{len(by_product)} distinct products; {sum(1 for c in by_product.values() if c >= 2)} have two or more records, so most products have a single shopper's price.")
    if dates:
        stmts.append(f"Records span {dates[0]} to {dates[-1]}; the newest is {latest_age} days old and {last_90} are from the last 90 days.")
    if mismatched:
        stmts.append(f"{len(mismatched)} record(s) are in a currency other than {local} ({', '.join(sorted({o['currency'] for o in mismatched}))}); they are kept as recorded and flagged.")
    if no_currency:
        stmts.append(f"{no_currency} record(s) have no currency and cannot be compared.")
    sufficient = len(obs) >= 200 and last_90 >= 50
    if not sufficient:
        stmts.append("This is not enough to represent typical market prices. Each record is one shopper's observation in one shop on one day; "
                     "products without records have no known price (not zero). Upload your own supplier or shelf prices for simulations.")
    return {
        "country_code": cc, "local_currency": local, "observations": len(obs), "reported_price_count": reported_prices,
        "reported_location_count": summary.get("location_count"), "locations_found": locations_found,
        "date_first": dates[0] if dates else None, "date_last": dates[-1] if dates else None, "latest_age_days": latest_age,
        "freshness": freshness(latest_age), "observations_last_90_days": last_90,
        "distinct_products": len(by_product), "products_with_repeat_observations": sum(1 for c in by_product.values() if c >= 2),
        "by_city": Counter((o["location"] or {}).get("city") or "unknown" for o in obs).most_common(),
        "by_currency": Counter(o["currency"] or "missing" for o in obs).most_common(),
        "by_proof_type": Counter(((o["evidence"] or {}).get("proof_type")) or "none" for o in obs).most_common(),
        "currency_mismatch": [o["id"] for o in mismatched],
        "with_product_metadata": with_meta,
        "sufficient": sufficient,
        "sufficiency_rule": "At least 200 records with 50 or more from the last 90 days before What-if treats a country's coverage as usable for price benchmarks.",
        "statements": stmts,
    }


open_prices = OpenPrices()
__all__ = ["OpenPrices", "open_prices", "normalize_price", "coverage", "SourceError"]
