"""End-to-end API workflow against a temporary database."""
import time
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app

H = {"X-StartUp-Client": "web"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def new_workspace(c):
    """Start a fresh anonymous workspace (there are no accounts)."""
    c.cookies.clear()
    r = c.post("/api/workspace", headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def wait_runs(c, business_id, ids, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        runs = c.get(f"/api/businesses/{business_id}/runs", params={"ids": ",".join(map(str, ids))}).json()
        if all(r["status"] not in ("queued", "preparing", "running") for r in runs):
            return {r["id"]: r for r in runs}
        time.sleep(0.15)
    raise AssertionError("runs did not finish")


def test_csrf_header_required(client):
    client.cookies.clear()
    assert client.post("/api/workspace").status_code == 403


def test_workspace_without_login(client):
    client.cookies.clear()
    assert client.get("/api/workspace").status_code == 401
    assert client.get("/api/businesses").status_code == 401
    first = client.post("/api/workspace", headers=H).json()
    again = client.post("/api/workspace", headers=H).json()  # same browser, same workspace
    assert first["id"] == again["id"] and first["businesses"] == 0
    assert client.get("/api/workspace").json()["id"] == first["id"]
    # The account endpoints no longer exist.
    for path in ("/api/auth/signup", "/api/auth/login", "/api/auth/logout"):
        assert client.post(path, json={}, headers=H).status_code in (404, 405)
    assert client.get("/api/auth/me").status_code == 404
    # A forged cookie does not open another workspace.
    client.cookies.clear()
    client.cookies.set("startup_workspace", f"{first['id'] + 1}.9999999999.deadbeef")
    assert client.get("/api/workspace").status_code == 401


def test_clear_workspace(client):
    new_workspace(client)
    client.post("/api/businesses", json={"name": "Temp", "business_type": "grocery"}, headers=H)
    assert client.post("/api/workspace/clear", json={"confirm": "no"}, headers=H).status_code == 422
    assert client.post("/api/workspace/clear", json={"confirm": "DELETE"}, headers=H).json()["businesses"] == 0


def test_system_status_reports_deterministic_mode(client):
    s = client.get("/api/system/status").json()
    assert s["ai"]["mode"] == "deterministic" and s["ai"]["model"] is None


def test_full_workflow(client):
    new_workspace(client)
    desc = ("I operate a neighborhood grocery store. I want to reduce expired inventory and determine whether starting a "
            "delivery service would increase profit without exceeding my $15,000 budget.")
    r = client.post("/api/businesses", json={"name": "Corner Grocer", "business_type": "grocery", "description": desc, "mode": "build"}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    bid = body["business"]["id"]
    assert [s["agent"] for s in body["steps"]] == ["Digital Twin", "Data Analyst", "Scenario Designer"]
    assert all(s["mode"] == "deterministic" for s in body["steps"])

    scenarios = client.get(f"/api/businesses/{bid}/scenarios").json()
    names = [s["name"] for s in scenarios]
    assert names[0] == "Baseline World" and "Delivery Service World" in names and "Lean Ordering World" in names

    # Model: validate, edit -> new version
    versions = client.get(f"/api/businesses/{bid}/models").json()
    assert len(versions) == 1 and versions[0]["calibration"] == "exploratory"
    v1 = client.get(f"/api/models/{versions[0]['id']}").json()
    assert v1["spec"]["goals"]["max_investment_budget"] == 15000
    assert v1["spec"]["provenance"]["goals.max_investment_budget"] == "user"

    # Run all scenarios in parallel (small config for speed)
    ids = [s["id"] for s in scenarios]
    queued = client.post(f"/api/businesses/{bid}/runs/batch", json={"scenario_ids": ids, "config": {"runs": 60, "horizon_days": 60}}, headers=H).json()
    assert all(q["status"] == "queued" for q in queued)
    runs = wait_runs(client, bid, [q["id"] for q in queued])
    assert all(r["status"] in ("completed", "completed_with_warnings") for r in runs.values())
    for r in runs.values():
        assert r["model_version_id"] == versions[0]["id"] and r["progress"] == 1.0
        assert any("Exploratory" in w for w in r["warnings"])
    full = client.get(f"/api/runs/{queued[0]['id']}").json()
    assert full["results"]["config"]["runs"] == 60 and full["results"]["engine_version"]

    # Compare
    run_ids = [q["id"] for q in queued]
    cmp = client.post(f"/api/businesses/{bid}/compare", json={"run_ids": run_ids}, headers=H).json()
    assert cmp["comparison"]["rows"][0]["scenario_name"] == "Baseline World"
    assert cmp["analysis"]["agent"] == "Decision Analyst" and cmp["analysis"]["mode"] == "deterministic"

    # Report tied to model version
    rep = client.post(f"/api/businesses/{bid}/reports", json={"run_ids": run_ids}, headers=H).json()
    assert rep["model_version_ids"] == [versions[0]["id"]]
    for key in ("business", "decision", "data", "assumptions", "scenarios", "comparison", "outcomes", "risks",
                "sensitivity", "recommendation", "limitations", "confidence"):
        assert key in rep["content"], key
    # Report numbers equal the engine output of the runs it cites
    base_row = rep["content"]["comparison"]["rows"][0]
    base_run = client.get(f"/api/runs/{base_row['run_id']}").json()
    assert base_row["revenue"]["mean"] == base_run["results"]["summary"]["revenue"]["mean"]
    csv_text = client.get(f"/api/reports/{rep['id']}/csv").text
    assert "Operating profit per month" in csv_text and "Baseline World" in csv_text

    # Changing a scenario marks its last run as outdated
    sid = scenarios[1]["id"]
    client.patch(f"/api/scenarios/{sid}", json={"levers": {**scenarios[1]["levers"], "demand_change_pct": -5}}, headers=H)
    stale_run = next(r for r in runs.values() if r["scenario_id"] == sid)
    assert client.get(f"/api/runs/{stale_run['id']}").json()["outdated"]
    bad = client.patch(f"/api/scenarios/{sid}", json={"levers": {"not_a_lever": 1}}, headers=H)
    assert bad.status_code == 422

    # Saving a new model version keeps old report/run attached to the old version
    spec = v1["spec"]
    spec["finance"]["starting_cash"] = 50000
    nv = client.post(f"/api/businesses/{bid}/models", json={"spec": spec, "change_note": "Updated cash"}, headers=H).json()
    assert nv["version"] == 2
    again = client.get(f"/api/reports/{rep['id']}").json()
    assert again["model_version_ids"] == [versions[0]["id"]] and again["content"] == rep["content"]
    assert any("newer model version" in m for m in client.get(f"/api/runs/{base_row['run_id']}").json()["outdated"])

    # Invalid model cannot be simulated
    spec_bad = dict(spec)
    spec_bad["products"] = [dict(spec["products"][0], starting_inventory=-1)]
    assert client.post("/api/models/validate", json={"spec": spec_bad}, headers=H).json()["status"] == "invalid"

    # Stress test + sensitivity
    st = client.post(f"/api/runs/{base_row['run_id']}/stress", json={"shocks": ["demand_drop", "staff_shortage"], "runs": 40}, headers=H).json()
    se = client.post(f"/api/runs/{base_row['run_id']}/sensitivity", headers=H).json()
    done = wait_runs(client, bid, [st["id"], se["id"]])
    assert done[st["id"]]["status"].startswith("completed"), done[st["id"]]
    st_full = client.get(f"/api/runs/{st['id']}").json()
    assert {r["key"] for r in st_full["results"]["rows"]} == {"unstressed", "demand_drop", "staff_shortage", "combined"}
    assert client.get(f"/api/runs/{st['id']}/vulnerabilities").json()["vulnerabilities"]
    assert client.get(f"/api/runs/{se['id']}").json()["results"]["rows"]

    # Failure Museum: only failed runs without a reason
    failures = client.get(f"/api/businesses/{bid}/failures").json()
    passed = [r for r in runs.values() if r["outcome"] == "passed"]
    failed = [r for r in runs.values() if r["outcome"] == "failed_constraints"]
    if passed:
        x = client.post(f"/api/businesses/{bid}/failures", json={"run_id": passed[0]["id"]}, headers=H)
        assert x.status_code == 422
    assert failed, "the stress world should break at least one limit"
    assert any(c["run_id"] == failed[0]["id"] for c in failures["candidates"])
    f = client.post(f"/api/businesses/{bid}/failures", json={"run_id": failed[0]["id"], "lessons": "Too thin"}, headers=H).json()
    assert f["category"] == "failed" and f["limits_exceeded"] and f["next_changes"]
    rev = client.post(f"/api/failures/{f['id']}/revise", headers=H).json()
    assert rev["name"].endswith("(revised)")

    # Reality feedback + approved calibration creates version 3; history preserved
    start = date.fromisoformat(base_run["config"]["start_date"])
    pred = sum(base_run["results"]["daily_expected"]["revenue"][0:14])
    fb = client.post(f"/api/businesses/{bid}/feedback", json={
        "run_id": base_run["id"], "period_start": start.isoformat(), "period_end": (start + timedelta(days=13)).isoformat(),
        "revenue": round(pred * 0.85, 2)}, headers=H).json()
    assert fb["comparison"]["errors"]["revenue"]["pct"] == pytest.approx(-0.15, abs=1e-3)
    assert fb["calibration_status"] == "pending"
    applied = client.post(f"/api/feedback/{fb['id']}/apply", headers=H).json()
    assert applied["new_version"]["version"] == 3
    assert client.get(f"/api/runs/{base_run['id']}").json()["model_version_id"] == versions[0]["id"]
    out_of_window = client.post(f"/api/businesses/{bid}/feedback", json={
        "run_id": base_run["id"], "period_start": "2001-01-01", "period_end": "2001-01-02", "revenue": 1}, headers=H)
    assert out_of_window.status_code == 422

    dash = client.get("/api/dashboard").json()
    assert dash["totals"]["completed_runs"] >= len(run_ids) and dash["totals"]["reports"] == 1
    assert client.get(f"/api/businesses/{bid}/audit").json()


def test_plan_mode_requires_approval(client):
    new_workspace(client)
    r = client.post("/api/businesses", json={"name": "Plan Shop", "business_type": "grocery", "mode": "plan",
                                            "description": "Should I raise prices?"}, headers=H).json()
    bid = r["business"]["id"]
    assert r["business"]["plan_status"] == "draft" and r["business"]["scenario_count"] == 0
    plan = client.get(f"/api/businesses/{bid}").json()["plan"]
    assert plan["proposed_scenarios"] and plan["assumptions_to_verify"]
    ok = client.post(f"/api/businesses/{bid}/plan/approve", json={"scenario_indexes": [0, 1]}, headers=H).json()
    assert ok["plan_status"] == "approved" and ok["scenario_count"] == 2


def test_imports_review_then_apply(client):
    new_workspace(client)
    bid = client.post("/api/businesses", json={"name": "Imp", "business_type": "grocery"}, headers=H).json()["business"]["id"]
    files = {"file": ("products.csv", b"name,price,cost,stock\nFresh produce,3.4,2.0,800\nBroken,x,1,1\n", "text/csv")}
    rep = client.post(f"/api/businesses/{bid}/imports", data={"kind": "products"}, files=files, headers=H).json()
    assert rep["status"] == "reviewed" and rep["report"]["rejected_rows"] == 1
    assert len(client.get(f"/api/businesses/{bid}/models").json()) == 1  # nothing applied yet
    applied = client.post(f"/api/imports/{rep['id']}/apply", headers=H).json()
    assert applied["version"]["version"] == 2 and applied["changes"]
    assert client.post(f"/api/imports/{rep['id']}/apply", headers=H).status_code == 409
    bad = client.post(f"/api/businesses/{bid}/imports", data={"kind": "products"}, files={"file": ("x.exe", b"MZ", "application/octet-stream")}, headers=H)
    assert bad.status_code == 422


def test_other_workspaces_cannot_access(client):
    new_workspace(client)
    bid = client.post("/api/businesses", json={"name": "Mine", "business_type": "grocery"}, headers=H).json()["business"]["id"]
    new_workspace(client)
    assert client.get(f"/api/businesses/{bid}").status_code == 404
    assert client.get(f"/api/businesses/{bid}/scenarios").status_code == 404


def test_demo_workspace_runs_real_engine(client):
    new_workspace(client)
    b = client.post("/api/businesses/demo", headers=H).json()
    assert b["is_demo"] and "(demo)" in b["name"]
    runs = client.get(f"/api/businesses/{b['id']}/runs").json()
    done = wait_runs(client, b["id"], [r["id"] for r in runs])
    assert len(done) == 5 and all(r["status"].startswith("completed") for r in done.values())


def test_public_demo_session_isolated(client):
    client.cookies.clear()
    s = client.post("/api/public/demo/session", headers=H).json()
    sid = s["session_id"]
    assert s["business"]["sample_data"] and len(s["scenarios"]) == 6  # five standard worlds + lean ordering
    queued = client.post("/api/public/demo/runs", json={"session_id": sid, "scenario_ids": ["baseline", "delivery"], "runs": 50}, headers=H).json()
    end = time.time() + 30
    while time.time() < end:
        runs = client.get("/api/public/demo/runs", params={"session_id": sid}).json()
        if all(r["status"] in ("completed", "completed_with_warnings", "failed") for r in runs):
            break
        time.sleep(0.1)
    assert all(r["status"].startswith("completed") for r in runs)
    assert [t["status"] for t in runs[0]["timeline"]][:3] == ["queued", "preparing", "running"]
    cmp = client.post("/api/public/demo/compare", json={"session_id": sid, "run_ids": [r["id"] for r in queued]}, headers=H).json()
    assert cmp["comparison"]["rows"][0]["scenario_name"] == "Baseline World"
    # Changing an assumption and rerunning produces different numbers
    q2 = client.post("/api/public/demo/runs", json={"session_id": sid, "scenario_ids": ["baseline"], "runs": 50,
                                                   "assumptions": {"demand_change_pct": -20}}, headers=H).json()
    time.sleep(0.5)
    r2 = client.get("/api/public/demo/runs", params={"session_id": sid, "ids": str(q2[0]["id"]), "results": "true"}).json()[0]
    r1 = client.get("/api/public/demo/runs", params={"session_id": sid, "ids": str(queued[0]["id"]), "results": "true"}).json()[0]
    assert r2["results"]["summary"]["revenue"]["mean"] < r1["results"]["summary"]["revenue"]["mean"]
    st = client.post("/api/public/demo/stress", json={"session_id": sid, "scenario_id": "baseline", "shocks": ["supplier_increase"], "runs": 40}, headers=H).json()
    assert st["result"]["rows"][1]["delta"]["monthly_operating_profit"] < 0
    assert client.get("/api/public/demo/runs", params={"session_id": "nope"}).status_code == 410
    # Goals, the visitor's budget as a real limit, and sensitivity
    assert [g["id"] for g in s["goals"]] == ["profit", "waste", "cash"]
    dq = client.post("/api/public/demo/runs", json={"session_id": sid, "scenario_ids": ["delivery"], "runs": 30, "budget": 1000}, headers=H).json()
    time.sleep(0.6)
    dr = client.get("/api/public/demo/runs", params={"session_id": sid, "ids": str(dq[0]["id"]), "results": "true"}).json()[0]
    budget = next(c for c in dr["results"]["constraints"] if c["key"] == "budget")
    assert budget["violated"] and dr["results"]["outcome"] == "failed_constraints"  # $3,500 setup > $1,000 budget
    sens = client.post("/api/public/demo/sensitivity", json={"session_id": sid, "scenario_id": "lean"}, headers=H).json()
    assert sens["scenario"] == "Lean Ordering World" and sens["rows"]
    sc = client.get("/api/public/showcase", params={"demand": -10}).json()
    assert len(sc["worlds"]) == 5 and sc["label"].startswith("Sample data")
