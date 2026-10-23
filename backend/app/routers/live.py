"""Live data from the configured Prometheus server.

Three kinds of numbers stay separate everywhere in What-if:
  live measurements   values returned by Prometheus, with their timestamps
  calculated outputs  results of the simulation engine
  example data        the fictional sample store used by the demo
"""
from __future__ import annotations

import os
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import current_workspace
from ..db import get_db
from ..domain.retail import normalize_spec
from ..engine.analysis import calibrate_spec
from ..integrations.prometheus import PrometheusError, prometheus
from ..models import Workspace
from ..services import active_version, audit, create_version, owned_business

router = APIRouter(prefix="/api", tags=["live"])
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}


def _business_access(request: Request) -> None:
    """Business metrics belong to whoever runs this server. By default they are
    only served to requests from this machine, so a public deployment does
    not show them to anonymous visitors."""
    policy = os.getenv("STARTUP_LIVE_BUSINESS_ACCESS", "local")
    if policy == "all":
        return
    if policy == "off":
        raise HTTPException(403, "Live business metrics are disabled on this server (STARTUP_LIVE_BUSINESS_ACCESS=off).")
    host = request.client.host if request.client else ""
    if host not in LOCAL_HOSTS:
        raise HTTPException(403, "Live business metrics are only available on the machine running What-if (STARTUP_LIVE_BUSINESS_ACCESS=local).")


@router.get("/live/status")
def live_status():
    return prometheus.status()


@router.get("/live/operational")
def live_operational():
    if not prometheus.configured:
        return {"available": False, "reason": "Live data is not configured. Set PROMETHEUS_URL on the server.", "kind": "not_configured"}
    try:
        return prometheus.operational()
    except PrometheusError as exc:
        return {"available": False, "reason": exc.message, "kind": exc.kind}


@router.get("/live/business")
def live_business(request: Request, ws: Workspace = Depends(current_workspace)):
    _business_access(request)
    if not prometheus.configured:
        return {"metrics": [], "error": "Live data is not configured. Set PROMETHEUS_URL on the server.", "kind": "not_configured"}
    if not prometheus.settings.business_metrics and not prometheus.settings.business_config_error:
        return {"metrics": [], "error": None, "kind": "no_mapping",
                "note": "No business metrics are mapped. Prometheus data is only treated as business data when the operator maps it in STARTUP_BUSINESS_METRICS."}
    return prometheus.business()


class LiveKey(BaseModel):
    key: str


def _expected(spec: dict, use: str) -> tuple[float, str]:
    s = normalize_spec(spec)
    if use == "demand":
        return sum(float(p["avg_daily_demand"]) for p in s["products"]), "units per day at average demand"
    return sum(float(p["avg_daily_demand"]) * float(p["price"]) for p in s["products"]), "sales per day at average demand"


def _observe(key: str) -> tuple[dict, float, float]:
    m = prometheus.business_metric(key)
    if m is None:
        raise HTTPException(404, "Unknown live metric.")
    if m.use not in ("demand", "revenue"):
        raise HTTPException(422, f"'{m.label}' is mapped for display only, so it cannot be compared with the model.")
    try:
        rows = prometheus.query(m.query)
    except PrometheusError as exc:
        raise HTTPException(502, exc.message) from exc
    if not rows or rows[0]["value"] is None:
        raise HTTPException(409, f"'{m.label}' returned no data, so there is nothing to compare.")
    return {"key": m.key, "label": m.label, "unit": m.unit, "use": m.use, "query": m.query}, rows[0]["value"], rows[0]["timestamp"]


@router.post("/businesses/{business_id}/live/compare")
def live_compare(business_id: int, data: LiveKey, request: Request, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    _business_access(request)
    b = owned_business(db, ws, business_id)
    v = active_version(db, b)
    meta, observed, at = _observe(data.key)
    expected, basis = _expected(v.spec, meta["use"])
    ratio = observed / expected if expected else None
    return {"metric": meta, "observed": observed, "evaluated_at": at, "expected": expected, "expected_basis": basis,
            "model_version": v.version, "ratio": ratio,
            "suggestion": (f"Scale every product's average daily demand by {ratio:.3f} to match the live measurement." if ratio and abs(ratio - 1) > 0.05
                           else "The live measurement is within 5% of the model; no change suggested.")}


@router.post("/businesses/{business_id}/live/apply")
def live_apply(business_id: int, data: LiveKey, request: Request, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Create a new model version calibrated to a live measurement (the user approves this explicitly)."""
    _business_access(request)
    b = owned_business(db, ws, business_id)
    v = active_version(db, b)
    meta, observed, at = _observe(data.key)  # re-read on the server; never trust a value sent by the browser
    expected, _ = _expected(v.spec, meta["use"])
    if not expected:
        raise HTTPException(409, "The model has no expected demand to compare with.")
    ratio = observed / expected
    when = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(at))
    new_spec, changes = calibrate_spec(v.spec, ratio, f"{prometheus.display_name} metric '{meta['key']}' = {observed:g} at {when}")
    nv = create_version(db, b, new_spec, f"Calibrated demand ×{ratio:.3f} to live metric '{meta['label']}' ({observed:g} {meta['unit']}, {when}).", "calibration:live")
    audit(db, b.id, "user", "live.calibrated", f"Model v{nv.version} calibrated from live metric '{meta['key']}'.", {"query": meta["query"], "observed": observed, "evaluated_at": at})
    db.commit()
    return {"new_version": {"id": nv.id, "version": nv.version}, "changes": changes, "observed": observed, "evaluated_at": at}
