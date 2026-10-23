"""Server-side client for a Prometheus server's HTTP API.

Only documented Prometheus endpoints are used:
    GET /api/v1/status/buildinfo        reachability and version
    GET /api/v1/query                   instant queries
    GET /api/v1/query_range             range queries
    GET /api/v1/label/__name__/values   which metric names exist

Configuration comes from environment variables and never leaves the server
(see README "Live data"). The client does not guess what any metric means:
- What-if's own telemetry is recognised by the metric names What-if exports
  (app/telemetry.py) and the scrape job label (STARTUP_PROMETHEUS_JOB).
- A metric is treated as business data only if the operator maps it
  explicitly in STARTUP_BUSINESS_METRICS.
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from .. import config  # noqa: F401  (loads backend/.env before settings are read)

CACHE_SECONDS = 15.0


class PrometheusError(Exception):
    def __init__(self, message: str, kind: str = "error"):
        super().__init__(message)
        self.message = message
        self.kind = kind  # not_configured | unreachable | timeout | http | query | invalid_response


@dataclass
class BusinessMetric:
    key: str
    label: str
    query: str
    unit: str = ""
    use: str = "display"  # display | demand | revenue
    freshness_selector: str | None = None
    description: str = ""


@dataclass
class Settings:
    url: str | None
    display_name: str
    timeout: float
    verify_tls: bool
    bearer_token: str | None
    username: str | None
    password: str | None
    stale_after: float
    job: str
    business_metrics: list[BusinessMetric] = field(default_factory=list)
    business_config_error: str | None = None


def _load_business_metrics(raw: str | None) -> tuple[list[BusinessMetric], str | None]:
    if not raw:
        return [], None
    try:
        text = Path(raw).read_text(encoding="utf-8") if raw.strip().endswith(".json") and Path(raw).exists() else raw
        items = json.loads(text)
        if not isinstance(items, list):
            raise ValueError("expected a JSON list")
        out = []
        for it in items:
            m = BusinessMetric(key=str(it["key"]), label=str(it.get("label") or it["key"]), query=str(it["query"]),
                               unit=str(it.get("unit", "")), use=str(it.get("use", "display")),
                               freshness_selector=it.get("freshness_selector"), description=str(it.get("description", "")))
            if m.use not in ("display", "demand", "revenue"):
                raise ValueError(f"metric {m.key}: use must be display, demand or revenue")
            out.append(m)
        return out, None
    except Exception as exc:  # reported in the status, never raised at startup
        return [], f"STARTUP_BUSINESS_METRICS could not be read: {exc}"


def load_settings() -> Settings:
    metrics, err = _load_business_metrics(os.getenv("STARTUP_BUSINESS_METRICS"))
    url = (os.getenv("PROMETHEUS_URL") or "").strip().rstrip("/") or None
    return Settings(
        url=url, display_name=os.getenv("PROMETHEUS_DISPLAY_NAME", "Prometheus"),
        timeout=float(os.getenv("PROMETHEUS_TIMEOUT_SECONDS", "5")),
        verify_tls=os.getenv("PROMETHEUS_VERIFY_TLS", "1") != "0",
        bearer_token=os.getenv("PROMETHEUS_BEARER_TOKEN") or None,
        username=os.getenv("PROMETHEUS_USERNAME") or None, password=os.getenv("PROMETHEUS_PASSWORD") or None,
        stale_after=float(os.getenv("PROMETHEUS_STALE_AFTER_SECONDS", "300")),
        job=os.getenv("STARTUP_PROMETHEUS_JOB", "startup"),
        business_metrics=metrics, business_config_error=err,
    )


def _num(v: str) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


class PrometheusClient:
    def __init__(self, settings: Settings | None = None, transport: httpx.BaseTransport | None = None):
        self.settings = settings or load_settings()
        self._transport = transport
        self._cache: dict[tuple, tuple[float, object]] = {}
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- basics
    @property
    def configured(self) -> bool:
        return bool(self.settings.url)

    @property
    def display_name(self) -> str:
        return self.settings.display_name

    def _client(self) -> httpx.Client:
        s = self.settings
        headers = {"Accept": "application/json"}
        auth = None
        if s.bearer_token:
            headers["Authorization"] = f"Bearer {s.bearer_token}"
        elif s.username:
            auth = (s.username, s.password or "")
        return httpx.Client(base_url=s.url or "", timeout=s.timeout, verify=s.verify_tls, headers=headers, auth=auth,
                            transport=self._transport, follow_redirects=False)

    def _get(self, path: str, params: dict | None = None, cache: float = CACHE_SECONDS):
        if not self.configured:
            raise PrometheusError("Live data is not configured. Set PROMETHEUS_URL on the server.", "not_configured")
        key = (path, tuple(sorted((params or {}).items())))
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < cache:
                return hit[1]
        try:
            with self._client() as c:
                r = c.get(path, params=params)
        except httpx.TimeoutException as exc:
            raise PrometheusError(f"{self.display_name} did not answer within {self.settings.timeout:g} seconds.", "timeout") from exc
        except httpx.HTTPError as exc:
            raise PrometheusError(f"Could not reach {self.display_name} ({type(exc).__name__}).", "unreachable") from exc
        try:
            body = r.json()
        except ValueError as exc:
            raise PrometheusError(f"{self.display_name} returned HTTP {r.status_code} without a Prometheus API response.", "invalid_response") from exc
        if r.status_code >= 400 or body.get("status") != "success":
            msg = body.get("error") or f"HTTP {r.status_code}"
            kind = "query" if body.get("errorType") in ("bad_data", "execution") else "http"
            raise PrometheusError(f"{self.display_name} rejected the request: {msg}", kind)
        data = body.get("data")
        with self._lock:
            self._cache[key] = (now, data)
        return data

    # --------------------------------------------------------------- queries
    def buildinfo(self, cache: float = 60) -> dict:
        return self._get("/api/v1/status/buildinfo", cache=cache)

    def metric_names(self) -> list[str]:
        data = self._get("/api/v1/label/__name__/values", cache=60)
        return list(data) if isinstance(data, list) else []

    def query(self, promql: str) -> list[dict]:
        """Instant query -> [{labels, value, timestamp}] (vector or scalar)."""
        data = self._get("/api/v1/query", {"query": promql})
        rtype, result = data.get("resultType"), data.get("result")
        if rtype == "scalar":
            ts, v = result
            return [{"labels": {}, "value": _num(v), "timestamp": float(ts)}]
        if rtype == "vector":
            return [{"labels": s.get("metric", {}), "value": _num(s["value"][1]), "timestamp": float(s["value"][0])} for s in result]
        raise PrometheusError(f"Unexpected result type '{rtype}' for an instant query.", "invalid_response")

    def query_range(self, promql: str, seconds: int = 3600, step: int = 60) -> list[dict]:
        end = time.time()
        data = self._get("/api/v1/query_range", {"query": promql, "start": f"{end - seconds:.0f}", "end": f"{end:.0f}", "step": str(step)})
        if data.get("resultType") != "matrix":
            raise PrometheusError("Unexpected result type for a range query.", "invalid_response")
        return [{"labels": s.get("metric", {}), "points": [[float(t), _num(v)] for t, v in s.get("values", [])]} for s in data["result"]]

    def scalar(self, promql: str) -> tuple[float | None, float | None]:
        rows = self.query(promql)
        if not rows:
            return None, None
        return rows[0]["value"], rows[0]["timestamp"]

    # ------------------------------------------------------------ high level
    def status(self) -> dict:
        s = self.settings
        out = {"configured": self.configured, "name": s.display_name, "reachable": False, "version": None,
               "checked_at": time.time(), "latency_ms": None, "error": None, "error_kind": None,
               "metric_names_available": None, "startup_telemetry": {"found": False},
               "business_metrics_configured": len(s.business_metrics), "business_config_error": s.business_config_error}
        if not self.configured:
            out["error"], out["error_kind"] = "Live data is not configured. Set PROMETHEUS_URL on the server.", "not_configured"
            return out
        t0 = time.monotonic()
        try:
            info = self.buildinfo(cache=0)  # a real round trip, so reachability and latency are current
            out.update(reachable=True, version=info.get("version"), latency_ms=round((time.monotonic() - t0) * 1000, 1))
            names = self.metric_names()
            out["metric_names_available"] = len(names)
            out["startup_telemetry"] = self.telemetry_freshness(names)
        except PrometheusError as exc:
            out["error"], out["error_kind"] = exc.message, exc.kind
        return out

    def telemetry_freshness(self, names: list[str] | None = None) -> dict:
        names = names if names is not None else self.metric_names()
        if "startup_http_requests_total" not in names:
            return {"found": False, "reason": f"{self.display_name} has no What-if telemetry. Add a scrape job named '{self.settings.job}' for What-if's /metrics endpoint."}
        last, _ = self.scalar(f'max(timestamp(up{{job="{self.settings.job}"}}))')
        up, _ = self.scalar(f'max(up{{job="{self.settings.job}"}})')
        age = (time.time() - last) if last else None
        return {"found": True, "job": self.settings.job, "last_scrape_at": last, "age_seconds": age, "target_up": up == 1 if up is not None else None,
                "stale": age is None or age > self.settings.stale_after}

    def operational(self) -> dict:
        """What-if's own telemetry as recorded by Prometheus (application metrics, not business data)."""
        fresh = self.telemetry_freshness()
        if not fresh["found"]:
            return {"available": False, "reason": fresh["reason"], "freshness": fresh}
        j = self.settings.job
        sel = f'job="{j}"'
        queries = {
            "requests_per_second": (f"sum(rate(startup_http_requests_total{{{sel}}}[5m]))", "requests/s"),
            "error_ratio": (f'sum(rate(startup_http_requests_total{{{sel},status=~"5.."}}[5m])) / clamp_min(sum(rate(startup_http_requests_total{{{sel}}}[5m])), 1e-9)', "share"),
            "runs_active": (f"sum(startup_simulation_runs_active{{{sel}}})", "runs"),
            "runs_finished_1h": (f"sum(increase(startup_simulation_runs_total{{{sel}}}[1h]))", "runs"),
            "runs_failed_1h": (f'sum(increase(startup_simulation_runs_total{{{sel},status="failed"}}[1h]))', "runs"),
            "demo_runs_1h": (f"sum(increase(startup_demo_runs_total{{{sel}}}[1h]))", "runs"),
            "run_duration_p95_seconds": (f"histogram_quantile(0.95, sum by (le) (rate(startup_simulation_duration_seconds_bucket{{{sel}}}[1h])))", "seconds"),
            "api_latency_p95_seconds": (f"histogram_quantile(0.95, sum by (le) (rate(startup_http_request_duration_seconds_bucket{{{sel}}}[5m])))", "seconds"),
        }
        values = {}
        for k, (q, unit) in queries.items():
            try:
                v, ts = self.scalar(q)
                values[k] = {"value": v, "evaluated_at": ts, "unit": unit, "query": q}
            except PrometheusError as exc:
                values[k] = {"value": None, "error": exc.message, "unit": unit, "query": q}
        series = {}
        for k, q in {"requests_per_second": queries["requests_per_second"][0],
                     "runs_finished_per_minute": f"sum(increase(startup_simulation_runs_total{{{sel}}}[1m]))"}.items():
            try:
                rows = self.query_range(q, 3600, 60)
                series[k] = rows[0]["points"] if rows else []
            except PrometheusError as exc:
                series[k] = {"error": exc.message}
        return {"available": True, "freshness": fresh, "values": values, "series": series, "fetched_at": time.time()}

    def business(self) -> dict:
        s = self.settings
        if s.business_config_error:
            return {"metrics": [], "error": s.business_config_error}
        out = []
        for m in s.business_metrics:
            row = {"key": m.key, "label": m.label, "unit": m.unit, "use": m.use, "query": m.query, "description": m.description,
                   "value": None, "evaluated_at": None, "sample_at": None, "age_seconds": None, "stale": None, "series": [], "error": None}
            try:
                rows = self.query(m.query)
                if not rows or rows[0]["value"] is None:
                    row["error"] = "The query returned no data."
                else:
                    row["value"], row["evaluated_at"] = rows[0]["value"], rows[0]["timestamp"]
                    if len(rows) > 1:
                        row["error"] = f"The query returned {len(rows)} series; only the first is shown. Aggregate it in the mapping."
                if m.freshness_selector:
                    last, _ = self.scalar(f"max(timestamp({m.freshness_selector}))")
                    if last:
                        row["sample_at"], row["age_seconds"] = last, time.time() - last
                        row["stale"] = row["age_seconds"] > s.stale_after
                rng = self.query_range(m.query, 24 * 3600, 900)
                row["series"] = rng[0]["points"] if rng else []
            except PrometheusError as exc:
                row["error"] = exc.message
            out.append(row)
        return {"metrics": out, "fetched_at": time.time(), "error": None}

    def business_metric(self, key: str) -> BusinessMetric | None:
        return next((m for m in self.settings.business_metrics if m.key == key), None)


prometheus = PrometheusClient()
