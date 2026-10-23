"""Shared machinery for public data-source connectors.

Every connector call returns data together with where it came from:
the exact request URL, the retrieval time (UTC), whether it was served from
What-if's cache, and how long the request took. Failures raise SourceError
with a kind the interface can explain (rate_limited, timeout, unreachable,
not_found, invalid_response, http). Nothing in this module ever substitutes
sample or estimated values for a failed request.

Data kinds used across What-if:
    observed    a value someone recorded at a point in time (a shelf price,
                a published reference exchange rate, a news article)
    historical  official statistics for past periods (World Bank series)
    forecast    a third party's model output for future periods (Open-Meteo weather)
    calculated  computed by What-if from observed/historical inputs
                (currency conversions, summaries, simulation results)
    ai_generated  wording or interpretation produced by an AI model
"""
from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from .. import config  # noqa: F401  (loads backend/.env)

KINDS = ("observed", "historical", "forecast", "calculated", "ai_generated")
# Query parameters that carry credentials. They are sent to the source but removed from every URL
# What-if stores, returns or shows (Fetched.url, SourceError.url, source_url in reports).
SECRET_PARAMS = ("access_key", "apikey", "api_key")


def redact(url: str) -> str:
    parts = urlsplit(url)
    if not parts.query:
        return url
    kept = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k.lower() not in SECRET_PARAMS]
    return urlunsplit(parts._replace(query=urlencode(kept)))


def user_agent() -> str:
    """Identify What-if to public APIs. A contact address is added only if the
    operator configures one (STARTUP_CONTACT); none is sent by default."""
    contact = os.getenv("STARTUP_CONTACT", "").strip()
    return f"WhatIf-BusinessSimulation/2.0 ({contact or 'self-hosted research tool'})"


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class SourceError(Exception):
    def __init__(self, source: str, kind: str, message: str, url: str | None = None,
                 status: int | None = None, retry_after: float | None = None):
        super().__init__(message)
        self.source, self.kind, self.message, self.url, self.status, self.retry_after = source, kind, message, url, status, retry_after

    def as_dict(self) -> dict:
        return {"source": self.source, "kind": self.kind, "message": self.message, "url": self.url,
                "status": self.status, "retry_after_seconds": self.retry_after}


@dataclass
class Fetched:
    data: Any
    url: str
    retrieved_at: str
    cached: bool
    elapsed_ms: float | None
    status: int

    def provenance(self, source: str) -> dict:
        return {"source": source, "url": self.url, "retrieved_at": self.retrieved_at, "cached": self.cached}


@dataclass
class SourceInfo:
    id: str
    name: str
    base_url: str
    docs_url: str
    min_interval: float          # seconds between requests (documented or polite limit)
    cache_seconds: float
    timeout: float = 15.0
    max_wait: float = 12.0       # longest we will queue behind our own throttle before giving up
    rate_note: str = ""
    retries: int = 0             # extra attempts after a timeout or dropped connection (idempotent GETs only)


@dataclass
class Health:
    last_success_at: str | None = None
    last_error: dict | None = None
    last_error_at: str | None = None
    requests: int = 0
    cache_hits: int = 0
    blocked_until: float = 0.0   # set after a 429 so we stop calling until it passes


class Connector:
    """Base class: throttled, cached, validated GET requests for one source."""

    info: SourceInfo

    def __init__(self, transport: httpx.BaseTransport | None = None):
        self._transport = transport
        self._cache: dict[str, tuple[float, Fetched]] = {}
        self._lock = threading.Lock()
        self._next_allowed = 0.0
        self.health = Health()

    # ------------------------------------------------------------ throttling
    def _reserve_slot(self, url: str) -> None:
        now = time.monotonic()
        with self._lock:
            if self.health.blocked_until > now:
                wait = self.health.blocked_until - now
                raise SourceError(self.info.id, "rate_limited",
                                  f"{self.info.name} asked What-if to slow down. Try again in about {wait:.0f} s.", url, 429, wait)
            start = max(now, self._next_allowed)
            if start - now > self.info.max_wait:
                raise SourceError(self.info.id, "rate_limited",
                                  f"{self.info.name} allows {self.info.rate_note or 'limited requests'}; What-if's queue is full. Try again in about {start - now:.0f} s.",
                                  url, None, start - now)
            self._next_allowed = start + self.info.min_interval
        if start > now:
            time.sleep(start - now)

    # -------------------------------------------------------------- requests
    def _url(self, path: str, params: dict | None) -> str:
        clean = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
        q = urlencode(clean, doseq=True)
        return f"{self.info.base_url}{path}" + (f"?{q}" if q else "")

    def get(self, path: str, params: dict | None = None, expect: str = "json", cache: bool = True) -> Fetched:
        real = self._url(path, params)
        url = redact(real)  # everything below that is stored or reported uses the redacted form
        if cache:
            with self._lock:
                hit = self._cache.get(real)
            if hit and time.monotonic() - hit[0] < self.info.cache_seconds:
                self.health.cache_hits += 1
                f = hit[1]
                return Fetched(f.data, f.url, f.retrieved_at, True, None, f.status)
        try:
            self._reserve_slot(url)
        except SourceError as exc:
            self._record_error(exc)
            raise
        t0 = time.perf_counter()
        self.health.requests += 1
        try:
            r = self._send(real)
        except httpx.TimeoutException as exc:
            err = SourceError(self.info.id, "timeout", f"{self.info.name} did not answer within {self.info.timeout:g} s" + (f" ({self.info.retries + 1} attempts)." if self.info.retries else "."), url)
            self._record_error(err)
            raise err from exc
        except httpx.HTTPError as exc:
            err = SourceError(self.info.id, "unreachable", f"Could not reach {self.info.name} ({type(exc).__name__}).", url)
            self._record_error(err)
            raise err from exc
        elapsed = (time.perf_counter() - t0) * 1000
        if r.status_code >= 400 and r.status_code != 429:
            err = self.http_error(r, url)
            if err:
                self._record_error(err)
                raise err
        if r.status_code == 429:
            retry = _retry_after(r) or max(60.0, self.info.min_interval * 6)
            with self._lock:
                self.health.blocked_until = time.monotonic() + retry
            snippet = r.text.strip().split(".")[0][:160]
            err = SourceError(self.info.id, "rate_limited", f"{self.info.name} is rate-limiting requests (HTTP 429): {snippet}.", url, 429, retry)
            self._record_error(err)
            raise err
        if r.status_code == 404:
            err = SourceError(self.info.id, "not_found", f"{self.info.name} has no record at this address (HTTP 404).", url, 404)
            self._record_error(err)
            raise err
        if r.status_code >= 400:
            detail = r.text.strip()[:200]
            err = SourceError(self.info.id, "http", f"{self.info.name} returned HTTP {r.status_code}: {detail}", url, r.status_code)
            self._record_error(err)
            raise err
        if expect == "json":
            try:
                data = r.json()
            except ValueError as exc:
                err = SourceError(self.info.id, "invalid_response", f"{self.info.name} returned a non-JSON response: {r.text.strip()[:160]}", url, r.status_code)
                self._record_error(err)
                raise err from exc
        else:
            data = r.text
        fetched = Fetched(data, url, utcnow_iso(), False, round(elapsed, 1), r.status_code)
        with self._lock:
            self._cache[real] = (time.monotonic(), fetched)
        self.health.last_success_at = fetched.retrieved_at
        return fetched

    def _send(self, url: str) -> httpx.Response:
        for attempt in range(self.info.retries + 1):
            try:
                with httpx.Client(timeout=self.info.timeout, headers={"User-Agent": user_agent(), "Accept": "application/json"},
                                  transport=self._transport, follow_redirects=True) as c:
                    return c.get(url)
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt >= self.info.retries:
                    raise
                self._reserve_slot(redact(url))
        raise AssertionError("unreachable")

    def http_error(self, r: httpx.Response, url: str) -> SourceError | None:
        """Override to explain a source's own error body for HTTP 4xx/5xx; None uses the generic message."""
        return None

    def fail(self, kind: str, message: str, url: str | None = None) -> SourceError:
        """Create (and record) a validation failure for a response that arrived but is unusable."""
        err = SourceError(self.info.id, kind, message, url)
        self._record_error(err)
        return err

    def _record_error(self, err: SourceError) -> None:
        self.health.last_error = err.as_dict()
        self.health.last_error_at = utcnow_iso()

    def describe(self) -> dict:
        h = self.health
        blocked = max(0.0, h.blocked_until - time.monotonic())
        return {
            "id": self.info.id, "name": self.info.name, "base_url": self.info.base_url, "docs_url": self.info.docs_url,
            "rate_note": self.info.rate_note, "cache_seconds": self.info.cache_seconds,
            "requests_made": h.requests, "cache_hits": h.cache_hits, "last_success_at": h.last_success_at,
            "last_error": h.last_error, "last_error_at": h.last_error_at,
            "rate_limited_for_seconds": round(blocked) if blocked else 0,
        }


def _retry_after(r: httpx.Response) -> float | None:
    v = r.headers.get("retry-after")
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def record(kind: str, value: Any, *, source: str, url: str | None, retrieved_at: str | None,
           observed_at: str | None = None, note: str | None = None, **extra) -> dict:
    """A single labelled data point. `kind` must be one of KINDS."""
    assert kind in KINDS, kind
    out = {"kind": kind, "value": value, "source": source, "source_url": url, "retrieved_at": retrieved_at, "observed_at": observed_at}
    if note:
        out["note"] = note
    out.update(extra)
    return out
