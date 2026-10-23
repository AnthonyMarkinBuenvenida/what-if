"""What-if's own operational telemetry, exposed at /metrics in the Prometheus
text format so a Prometheus server can scrape it.

These are application metrics (requests, simulation jobs). They describe how
What-if is running, never a business's sales or profit.
"""
from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, CollectorRegistry, Counter, Gauge, Histogram, generate_latest

from .engine.simulation import ENGINE_VERSION

registry = CollectorRegistry(auto_describe=True)

HTTP_REQUESTS = Counter("startup_http_requests_total", "HTTP requests handled by the What-if API.",
                        ["method", "route", "status"], registry=registry)
HTTP_LATENCY = Histogram("startup_http_request_duration_seconds", "API request duration.", ["route"], registry=registry,
                         buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5))
RUNS_FINISHED = Counter("startup_simulation_runs_total", "Workspace simulation runs that finished, by kind and final status.",
                        ["kind", "status"], registry=registry)
RUN_DURATION = Histogram("startup_simulation_duration_seconds", "Wall-clock time of workspace simulation runs.", ["kind"], registry=registry,
                         buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60))
RUNS_ACTIVE = Gauge("startup_simulation_runs_active", "Workspace simulation runs currently preparing or running.", registry=registry)
DEMO_RUNS = Counter("startup_demo_runs_total", "Public demo simulation runs that finished, by final status.", ["status"], registry=registry)
BUILD = Gauge("startup_build_info", "What-if build information.", ["engine"], registry=registry)
BUILD.labels(engine=ENGINE_VERSION).set(1)


def exposition() -> tuple[bytes, str]:
    return generate_latest(registry), CONTENT_TYPE_LATEST
