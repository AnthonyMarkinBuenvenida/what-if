"""Open Food Facts — product metadata by barcode.

Docs: https://openfoodfacts.github.io/openfoodfacts-server/api/
Endpoint used (verified live): GET https://world.openfoodfacts.org/api/v3/product/{barcode}.json?fields=…
Documented limits: 15 product reads per minute per IP (exceeding them can get the
IP banned); a custom User-Agent is required. What-if spaces requests 4.2 s apart
and caches products for 24 hours.

Matching rule: a product is only enriched by an exact barcode match. Names are
never fuzzy-matched to a different product.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from .base import Connector, SourceError, SourceInfo

FIELDS = "code,product_name,generic_name,brands,quantity,product_quantity,product_quantity_unit,categories_tags,countries_tags,image_front_url,last_modified_t"
BARCODE = re.compile(r"^\d{8,14}$")


class OpenFoodFacts(Connector):
    info = SourceInfo(
        id="open_food_facts", name="Open Food Facts", base_url="https://world.openfoodfacts.org/api/v3",
        docs_url="https://openfoodfacts.github.io/openfoodfacts-server/api/", min_interval=4.2, cache_seconds=86400,
        timeout=20, max_wait=13, rate_note="15 product reads per minute per IP (documented)",
    )

    def product(self, code: str) -> dict:
        code = code.strip()
        if not BARCODE.match(code):
            raise SourceError(self.info.id, "invalid_request", "A barcode is 8 to 14 digits.")
        try:
            f = self.get(f"/product/{code}.json", {"fields": FIELDS})
        except SourceError as exc:
            # v3 answers 404 for unknown barcodes; that is "no record", not a failure of the service.
            if exc.kind == "not_found":
                return {"found": False, "code": code, "source": self.info.id, "source_url": exc.url, "retrieved_at": None,
                        "note": "Open Food Facts has no product with this barcode."}
            raise
        d = f.data
        if not isinstance(d, dict) or "result" not in d:
            raise self.fail("invalid_response", "Open Food Facts returned an unexpected product response.", f.url)
        if (d.get("result") or {}).get("id") != "product_found" or not d.get("product"):
            msgs = [((e.get("message") or {}).get("id")) for e in d.get("errors") or []]
            return {"found": False, "code": code, "source": self.info.id, "source_url": f.url, "retrieved_at": f.retrieved_at,
                    "note": "Open Food Facts has no product with this barcode." if "product_not_found" in msgs else f"Not found ({', '.join(m for m in msgs if m)})."}
        p = d["product"]
        lm = p.get("last_modified_t")
        return {
            "found": True, "kind": "observed", "source": self.info.id, "code": p.get("code") or code,
            "name": p.get("product_name") or p.get("generic_name"), "brands": p.get("brands"), "quantity": p.get("quantity"),
            "product_quantity": p.get("product_quantity"), "product_quantity_unit": p.get("product_quantity_unit"),
            "categories_tags": p.get("categories_tags") or [], "countries_tags": p.get("countries_tags") or [],
            "image_url": p.get("image_front_url"),
            "last_modified": datetime.fromtimestamp(lm, timezone.utc).replace(microsecond=0).isoformat() if isinstance(lm, (int, float)) else None,
            "page_url": f"https://world.openfoodfacts.org/product/{code}",
            "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached,
        }


open_food_facts = OpenFoodFacts()
