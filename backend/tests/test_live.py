"""Prometheus integration tests against the documented Prometheus API response shapes."""
import json
import time

import httpx
import pytest

from app.integrations.prometheus import BusinessMetric, PrometheusClient, PrometheusError, Settings


def settings(**kw):
    base = dict(url="http://prom.test", display_name="Prometheus", timeout=1, verify_tls=True, bearer_token=None,
                username=None, password=None, stale_after=300, job="startup", business_metrics=[], business_config_error=None)
    base.update(kw)
    return Settings(**base)


def ok(data):
    return httpx.Response(200, json={"status": "success", "data": data})


def make_transport(now, scrape_age=10.0, names=("up", "startup_http_requests_total", "shop_units_sold_total"), log=None):
    def handler(req: httpx.Request):
        if log is not None:
            log.append((req.url.path, dict(req.url.params), req.headers.get("authorization")))
        path, q = req.url.path, req.url.params.get("query", "")
        if path == "/api/v1/status/buildinfo":
            return ok({"version": "3.7.1", "revision": "x", "branch": "HEAD"})
        if path == "/api/v1/label/__name__/values":
            return ok(list(names))
        if path == "/api/v1/query":
            if q.startswith("max(timestamp(up"):
                return ok({"resultType": "vector", "result": [{"metric": {}, "value": [now, str(now - scrape_age)]}]})
            if q.startswith("max(up"):
                return ok({"resultType": "vector", "result": [{"metric": {}, "value": [now, "1"]}]})
            if q == "broken(":
                return httpx.Response(400, json={"status": "error", "errorType": "bad_data", "error": "parse error"})
            if q == "empty":
                return ok({"resultType": "vector", "result": []})
            if q.startswith("max(timestamp(shop"):
                return ok({"resultType": "vector", "result": [{"metric": {}, "value": [now, str(now - 30)]}]})
            return ok({"resultType": "vector", "result": [{"metric": {}, "value": [now, "742.5"]}]})
        if path == "/api/v1/query_range":
            return ok({"resultType": "matrix", "result": [{"metric": {}, "values": [[now - 120, "1"], [now - 60, "NaN"], [now, "2.5"]]}]})
        return httpx.Response(404, text="not found")
    return httpx.MockTransport(handler)


def test_not_configured():
    c = PrometheusClient(settings(url=None))
    st = c.status()
    assert not st["configured"] and st["error_kind"] == "not_configured"
    with pytest.raises(PrometheusError):
        c.query("up")


def test_status_and_fresh_telemetry_with_auth_header():
    now, log = time.time(), []
    c = PrometheusClient(settings(bearer_token="secret-token"), make_transport(now, log=log))
    st = c.status()
    assert st["reachable"] and st["version"] == "3.7.1" and st["metric_names_available"] == 3
    assert st["startup_telemetry"]["found"] and st["startup_telemetry"]["target_up"] is True
    assert not st["startup_telemetry"]["stale"]
    assert all(a == "Bearer secret-token" for _, _, a in log)
    assert "secret-token" not in json.dumps(st)  # credentials never appear in responses


def test_stale_telemetry():
    c = PrometheusClient(settings(stale_after=60), make_transport(time.time(), scrape_age=600))
    assert c.status()["startup_telemetry"]["stale"] is True


def test_no_startup_telemetry_is_reported_honestly():
    c = PrometheusClient(settings(), make_transport(time.time(), names=("up", "node_cpu_seconds_total")))
    st = c.status()
    assert st["reachable"] and not st["startup_telemetry"]["found"]
    assert not c.operational()["available"]


def test_operational_values_and_range_parsing():
    c = PrometheusClient(settings(), make_transport(time.time()))
    op = c.operational()
    assert op["available"] and op["values"]["requests_per_second"]["value"] == 742.5
    pts = op["series"]["requests_per_second"]
    assert [p[1] for p in pts] == [1.0, None, 2.5]  # NaN becomes a gap, never a made-up number


def test_unreachable_and_timeout():
    def refused(req):
        raise httpx.ConnectError("refused", request=req)
    st = PrometheusClient(settings(), httpx.MockTransport(refused)).status()
    assert not st["reachable"] and st["error_kind"] == "unreachable"

    def slow(req):
        raise httpx.ReadTimeout("slow", request=req)
    assert PrometheusClient(settings(), httpx.MockTransport(slow)).status()["error_kind"] == "timeout"


def test_query_errors_are_surfaced():
    c = PrometheusClient(settings(), make_transport(time.time()))
    with pytest.raises(PrometheusError) as e:
        c.query("broken(")
    assert e.value.kind == "query"


def test_business_metrics_only_when_mapped():
    now = time.time()
    mapped = [BusinessMetric(key="units", label="Units sold per day", query="sum(increase(shop_units_sold_total[1d]))",
                             unit="units/day", use="demand", freshness_selector="shop_units_sold_total"),
              BusinessMetric(key="nothing", label="Empty", query="empty")]
    b = PrometheusClient(settings(business_metrics=mapped), make_transport(now)).business()
    units, empty = b["metrics"]
    assert units["value"] == 742.5 and units["evaluated_at"] == pytest.approx(now) and units["stale"] is False
    assert units["age_seconds"] == pytest.approx(30, abs=2)
    assert empty["value"] is None and "no data" in empty["error"]
    # Nothing is treated as business data unless it is mapped.
    assert PrometheusClient(settings(), make_transport(now)).business()["metrics"] == []


def test_cache_limits_requests():
    log = []
    c = PrometheusClient(settings(), make_transport(time.time(), log=log))
    c.query("up"), c.query("up"), c.query("up")
    assert sum(1 for p, params, _ in log if p == "/api/v1/query" and params.get("query") == "up") == 1


def test_metrics_endpoint_exposes_startup_telemetry():
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as tc:
        tc.get("/api/health")
        body = tc.get("/metrics").text
    assert "startup_http_requests_total" in body and "startup_simulation_runs_active" in body
    assert 'route="/api/health"' in body


def test_live_endpoints_when_not_configured(monkeypatch):
    from fastapi.testclient import TestClient
    from app.integrations import prometheus as mod
    from app.main import app
    monkeypatch.setattr(mod.prometheus, "settings", settings(url=None))
    with TestClient(app) as tc:
        assert tc.get("/api/live/status").json()["configured"] is False
        op = tc.get("/api/live/operational").json()
        assert op["available"] is False and op["kind"] == "not_configured"


def test_live_calibration_uses_server_side_measurement(monkeypatch):
    from fastapi.testclient import TestClient
    from app.integrations import prometheus as mod
    from app.main import app
    mapped = [BusinessMetric(key="units", label="Units sold per day", query="sum(increase(shop_units_sold_total[1d]))", unit="units/day", use="demand")]
    monkeypatch.setattr(mod.prometheus, "settings", settings(business_metrics=mapped))
    monkeypatch.setattr(mod.prometheus, "_transport", make_transport(time.time()))
    monkeypatch.setattr(mod.prometheus, "_cache", {})
    H = {"X-StartUp-Client": "web"}
    with TestClient(app) as tc:
        tc.post("/api/workspace", headers=H)
        bid = tc.post("/api/businesses", json={"name": "Live", "business_type": "grocery"}, headers=H).json()["business"]["id"]
        cmp = tc.post(f"/api/businesses/{bid}/live/compare", json={"key": "units"}, headers=H).json()
        assert cmp["observed"] == 742.5 and cmp["expected"] == pytest.approx(645)  # sum of the template's daily demand
        applied = tc.post(f"/api/businesses/{bid}/live/apply", json={"key": "units"}, headers=H).json()
        assert applied["new_version"]["version"] == 2
        v2 = tc.get(f"/api/models/{applied['new_version']['id']}").json()
        assert sum(p["avg_daily_demand"] for p in v2["spec"]["products"]) == pytest.approx(742.5, rel=1e-3)
        assert tc.post(f"/api/businesses/{bid}/live/compare", json={"key": "nope"}, headers=H).status_code == 404
