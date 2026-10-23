"""GDELT DOC 2.0 API — recent news coverage search.

Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ (data overview: https://gdeltproject.org/data.html)
Endpoint: GET https://api.gdeltproject.org/api/v2/doc/doc?query=…&mode=artlist&format=json&maxrecords=…&timespan=…&sort=datedesc
- Searches a rolling window of roughly the last 3 months; maxrecords is at most 250.
- `sourcecountry:` and `sourcelang:` are operators inside the query string.
- GDELT asks for at most one request every 5 seconds and answers HTTP 429 with a
  plain-text message otherwise (observed during verification). What-if spaces
  requests 6 s apart and backs off after a 429.

An article record means "this article was published"; its content is not
verified, and any summary of what the coverage means is AI-generated or the
user's own reading.
"""
from __future__ import annotations

from datetime import datetime, timezone

from .base import Connector, SourceInfo

TIMESPANS = {"1week", "2weeks", "1month", "2months", "3months", "7d", "14d", "30d"}


def _seen(v: str | None) -> str | None:
    # GDELT uses compact timestamps such as 20261020T101500Z.
    if not v:
        return None
    for fmt in ("%Y%m%dT%H%M%SZ", "%Y%m%d%H%M%S"):
        try:
            return datetime.strptime(v, fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return v


class Gdelt(Connector):
    info = SourceInfo(
        id="gdelt", name="GDELT DOC 2.0", base_url="https://api.gdeltproject.org/api/v2/doc",
        docs_url="https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/", min_interval=6.0, cache_seconds=900,
        timeout=30, max_wait=13, rate_note="one request every 5 seconds (GDELT's stated limit)",
    )

    def articles(self, query: str, source_country: str | None = None, timespan: str = "1month", max_records: int = 25) -> dict:
        q = query.strip()
        if not q:
            raise self.fail("invalid_request", "Enter words to search for.")
        if source_country:
            q = f"{q} sourcecountry:{source_country.replace(' ', '').lower()}"
        span = timespan if timespan in TIMESPANS else "1month"
        f = self.get("/doc", {"query": q, "mode": "artlist", "format": "json", "maxrecords": max(1, min(250, max_records)),
                              "timespan": span, "sort": "datedesc"})
        d = f.data
        if not isinstance(d, dict):
            raise self.fail("invalid_response", "GDELT returned an unexpected response.", f.url)
        raw = d.get("articles")
        if raw is None:
            # GDELT returns an empty object when nothing matches.
            raw = []
        if not isinstance(raw, list):
            raise self.fail("invalid_response", "GDELT's article list was not a list.", f.url)
        arts = []
        for a in raw:
            if not isinstance(a, dict) or not a.get("url"):
                continue
            arts.append({
                "kind": "observed", "source": self.info.id, "title": a.get("title"), "url": a.get("url"), "domain": a.get("domain"),
                "language": a.get("language"), "source_country": a.get("sourcecountry"), "seen_at": _seen(a.get("seendate")),
            })
        return {"query": q, "timespan": span, "articles": arts, "count": len(arts), "source": self.info.id,
                "source_url": f.url, "retrieved_at": f.retrieved_at, "cached": f.cached,
                "note": "Articles are what GDELT indexed in this window; they are not a complete record of news coverage."}


gdelt = Gdelt()
