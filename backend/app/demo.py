"""Public live demo: real engine, sample data, no account, no database writes.

Each visitor gets an anonymous demo session held in memory. Runs execute on the
same simulation engine as the product, on a fictional grocery store's sample
data. Nothing here can read or change any workspace's data, and sessions expire.
"""
from __future__ import annotations

import copy
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .agents.workflow import data_analyst, decision_analyst, stress_test_agent, stress_vulnerabilities
from .domain.retail import grocery_template, validate_spec
from .domain.worlds import LEAN_WORLD, world_templates
from .engine.analysis import compare_runs, run_stress_test
from .engine.simulation import default_criteria, levers_hash, merge_config, simulate
from .telemetry import DEMO_RUNS

SESSION_TTL = 2 * 3600
MAX_SESSIONS = 500
MAX_RUNS_PER_SESSION = 60
DEMO_MAX_MC_RUNS = 500
DEMO_NAME = "Maple Street Grocer"
DEMO_LABEL = "Sample data — fictional store"

_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="demo")
_lock = threading.Lock()
_sessions: dict[str, dict] = {}


def demo_spec() -> dict:
    spec = grocery_template(DEMO_NAME)
    spec["business"]["sample_data"] = True
    return spec


def demo_scenarios() -> list[dict]:
    worlds = [(w["kind"], w) for w in world_templates()] + [("lean", LEAN_WORLD)]
    out = []
    for i, (wid, w) in enumerate(worlds):
        out.append({"id": wid, "kind": w["kind"], "name": w["name"], "description": w["description"],
                    "decision": w["decision"], "levers": w["levers"], "assumptions": w["assumptions"], "color_index": i})
    return out


# The demo's three goals. Each picks a baseline plus a few worlds that test it,
# and the measures that matter most for it. Results are always calculated.
GOALS = [
    {"id": "profit", "label": "Increase profitability", "short": "Profit",
     "description": "Find a change that raises monthly operating profit without breaking the cash or budget limits.",
     "scenario_ids": ["baseline", "price", "delivery", "inventory"],
     "metrics": ["avg_monthly_operating_profit", "revenue", "min_cash"]},
    {"id": "waste", "label": "Reduce inventory waste", "short": "Waste",
     "description": "Cut the share of stock that expires on the shelf while still serving customers.",
     "scenario_ids": ["baseline", "lean", "inventory"],
     "metrics": ["waste_rate", "waste_cost", "fill_rate", "avg_monthly_operating_profit"]},
    {"id": "cash", "label": "Protect available cash", "short": "Cash",
     "description": "Keep the lowest cash balance safely above the buffer, even in a bad run.",
     "scenario_ids": ["baseline", "lean", "inventory", "delivery"],
     "metrics": ["min_cash", "ending_cash", "avg_monthly_operating_profit"]},
]


def _now() -> float:
    return time.time()


def _gc() -> None:
    cutoff = _now() - SESSION_TTL
    for sid in [k for k, v in _sessions.items() if v["touched"] < cutoff]:
        _sessions.pop(sid, None)
    if len(_sessions) > MAX_SESSIONS:
        for sid, _ in sorted(_sessions.items(), key=lambda kv: kv[1]["touched"])[: len(_sessions) - MAX_SESSIONS]:
            _sessions.pop(sid, None)


def new_session() -> dict:
    with _lock:
        _gc()
        sid = secrets.token_urlsafe(16)
        _sessions[sid] = {"id": sid, "created": _now(), "touched": _now(), "runs": {}, "next_run": 1}
    spec = demo_spec()
    return {"session_id": sid, "label": DEMO_LABEL, "business": overview(spec), "spec": spec,
            "validation": validate_spec(spec), "scenarios": demo_scenarios(), "criteria": default_criteria(spec), "goals": GOALS,
            "analyst": data_analyst(spec)}


def overview(spec: dict) -> dict:
    """Stage 1 figures, computed from the sample model (not invented)."""
    a = data_analyst(spec)["output"]["facts"]
    return {
        "name": DEMO_NAME, "type": "Neighborhood grocery", "sample_data": True,
        "products": [{"name": p["name"], "category": p["category"], "price": p["price"], "unit_cost": p["unit_cost"],
                      "avg_daily_demand": p["avg_daily_demand"], "stock": p["starting_inventory"],
                      "shelf_life_days": p["shelf_life_days"]} for p in spec["products"]],
        "expected_monthly_revenue": a["expected_monthly_revenue"],
        "gross_margin": a["gross_margin"],
        "monthly_fixed_costs_incl_labor": a["monthly_fixed_costs_incl_labor"],
        "monthly_labor": a["monthly_labor"],
        "expenses": spec["expenses"], "staff": spec["staff"],
        "inventory_units": sum(p["starting_inventory"] for p in spec["products"]),
        "inventory_value": round(sum(p["starting_inventory"] * p["unit_cost"] for p in spec["products"]), 2),
        "starting_cash": spec["finance"]["starting_cash"], "min_cash_buffer": spec["finance"]["min_cash_buffer"],
        "goals": spec["goals"],
    }


def _session(sid: str) -> dict:
    with _lock:
        s = _sessions.get(sid)
        if s is None:
            raise KeyError("Demo session expired. Reset the demo to start again.")
        s["touched"] = _now()
        return s


def _assumption_overrides(assumptions: dict | None) -> dict:
    """Visitor-adjustable assumptions, applied as levers on top of a scenario."""
    a = assumptions or {}
    lim = {"demand_change_pct": (-50, 50), "supplier_cost_change_pct": (-20, 50), "price_change_pct": (-20, 20),
           "staff_hours_change_pct": (-50, 50), "lead_time_change_days": (0, 14), "unexpected_expense": (0, 30000)}
    out = {}
    for k, (lo, hi) in lim.items():
        if a.get(k) not in (None, ""):
            out[k] = min(hi, max(lo, float(a[k])))
    return out


def demo_criteria(budget: float | None = None) -> dict:
    """The sample owner's limits; the visitor's spending budget replaces the default budget."""
    crit = default_criteria(demo_spec())
    if budget is not None:
        crit["max_investment"] = max(0.0, min(100_000.0, float(budget)))
    return crit


def submit_runs(sid: str, scenario_ids: list[str], assumptions: dict | None, mode: str, runs: int, horizon: int,
                overrides: dict | None = None, budget: float | None = None) -> list[dict]:
    from .engine.analysis import combine_levers
    s = _session(sid)
    scen = {x["id"]: x for x in demo_scenarios()}
    chosen = [scen[i] for i in scenario_ids if i in scen]
    if not chosen:
        raise ValueError("Choose at least one scenario.")
    if len(s["runs"]) + len(chosen) > MAX_RUNS_PER_SESSION:
        raise ValueError("This demo session has reached its run limit. Reset the demo to continue.")
    spec = demo_spec()
    crit = demo_criteria(budget)
    cfg = merge_config({"mode": mode, "runs": min(DEMO_MAX_MC_RUNS, runs), "horizon_days": min(180, horizon), "seed": 7})
    extra = _assumption_overrides(assumptions)
    created = []
    for sc in chosen:
        levers = copy.deepcopy(sc["levers"])
        for k, v in ((overrides or {}).get(sc["id"]) or {}).items():
            if k == "delivery" and isinstance(v, dict):
                levers.setdefault("delivery", {}).update({kk: vv for kk, vv in v.items() if kk in ("orders_per_day", "fee_per_order", "cost_per_order")})
            elif k in ("order_quantity_change_pct", "price_change_pct"):
                levers[k] = max(-50, min(100, float(v)))
        levers = combine_levers(levers, extra) if extra else levers
        with _lock:
            rid = s["next_run"]
            s["next_run"] += 1
            run = {"id": rid, "scenario_id": sc["id"], "scenario_name": sc["name"], "color_index": sc["color_index"],
                   "model_version_id": 1, "status": "queued", "progress": 0.0, "stage": "Waiting for a worker",
                   "config": cfg, "levers": levers, "assumptions": extra, "criteria": crit, "levers_hash": levers_hash(levers, cfg, crit),
                   "timeline": [{"status": "queued", "at": _now()}], "results": None, "error": None}
            s["runs"][rid] = run
        _pool.submit(_execute, sid, rid, spec, crit)
        created.append(_public(run))
    return created


def _set(run: dict, **kw) -> None:
    with _lock:
        if "status" in kw and kw["status"] != run["status"]:
            run["timeline"].append({"status": kw["status"], "at": _now()})
        run.update(kw)


def _execute(sid: str, rid: int, spec: dict, crit: dict) -> None:
    try:
        run = _sessions[sid]["runs"][rid]
    except KeyError:
        return
    try:
        _set(run, status="preparing", stage="Validating inputs")
        validate_spec(spec)
        _set(run, status="running", stage="Simulating")

        def prog(f, stage):
            _set(run, progress=round(f, 3), stage=stage)

        res = simulate(spec, run["levers"], run["config"], crit, prog)
        _set(run, results=res, progress=1.0, stage="Finished",
             status="completed_with_warnings" if res["warnings"] else "completed")
    except Exception as exc:
        _set(run, status="failed", error=str(exc)[:500], stage="Failed")
    DEMO_RUNS.labels(run["status"]).inc()


def _public(run: dict, with_results: bool = False) -> dict:
    out = {k: v for k, v in run.items() if k != "results"}
    if run.get("results"):
        r = run["results"]
        out["summary_headline"] = {
            "avg_monthly_operating_profit": r["summary"]["avg_monthly_operating_profit"],
            "outcome": r["outcome"],
        }
        if with_results:
            out["results"] = r
    return out


def get_runs(sid: str, ids: list[int] | None, with_results: bool) -> list[dict]:
    s = _session(sid)
    with _lock:
        runs = [r for r in s["runs"].values() if not ids or r["id"] in ids]
        return [_public(r, with_results) for r in runs]


def compare(sid: str, run_ids: list[int]) -> dict:
    s = _session(sid)
    with _lock:
        runs = [s["runs"][i] for i in run_ids if i in s["runs"] and s["runs"][i]["results"]]
    if not runs:
        raise ValueError("Run the scenarios first; there are no completed results to compare.")
    runs.sort(key=lambda r: (r["scenario_id"] != "baseline", r["color_index"]))
    cmp = compare_runs(runs)
    analysis = decision_analyst(cmp, demo_spec()["goals"] | runs[0].get("criteria", default_criteria(demo_spec())))
    return {"comparison": cmp, "analysis": analysis}


def stress(sid: str, scenario_id: str, shocks: list[str], custom: dict | None, runs: int, budget: float | None = None) -> dict:
    _session(sid)
    scen = {x["id"]: x for x in demo_scenarios()}.get(scenario_id)
    if scen is None:
        raise ValueError("Unknown scenario.")
    spec = demo_spec()
    crit = demo_criteria(budget)
    cfg = merge_config({"mode": "monte_carlo", "runs": min(300, runs), "horizon_days": 90, "seed": 11})
    res = run_stress_test(spec, scen["levers"], cfg, crit, shocks, custom)
    return {"scenario": scen["name"], "result": res, "vulnerabilities": stress_vulnerabilities(res),
            "suggested": stress_test_agent(spec, scen["kind"], scen["levers"])["output"]["suggested"]}


def sensitivity(sid: str, scenario_id: str, assumptions: dict | None, budget: float | None = None) -> dict:
    """One-at-a-time sensitivity (deterministic) for one demo world."""
    from .engine.analysis import combine_levers, run_sensitivity
    _session(sid)
    scen = {x["id"]: x for x in demo_scenarios()}.get(scenario_id)
    if scen is None:
        raise ValueError("Unknown scenario.")
    extra = _assumption_overrides(assumptions)
    levers = combine_levers(scen["levers"], extra) if extra else scen["levers"]
    res = run_sensitivity(demo_spec(), levers, {"horizon_days": 90}, demo_criteria(budget))
    return {"scenario": scen["name"], **res}


def showcase(demand_change: float = 0.0, supplier_change: float = 0.0) -> dict:
    """Small deterministic comparison for the landing page (computed, not canned)."""
    spec = demo_spec()
    crit = default_criteria(spec)
    extra = {"demand_change_pct": max(-40, min(40, demand_change)), "supplier_cost_change_pct": max(-20, min(40, supplier_change))}
    from .engine.analysis import combine_levers
    out = []
    for i, w in enumerate(world_templates()):
        res = simulate(spec, combine_levers(w["levers"], extra), {"mode": "deterministic", "horizon_days": 90}, crit)
        S = res["summary"]
        out.append({"kind": w["kind"], "name": w["name"], "color_index": i,
                    "monthly_operating_profit": S["avg_monthly_operating_profit"]["mean"],
                    "revenue": S["revenue"]["mean"], "min_cash": S["min_cash"]["mean"], "ending_cash": S["ending_cash"]["mean"],
                    "fill_rate": S["fill_rate"]["mean"], "waste_rate": S["waste_rate"]["mean"],
                    "cash_series": res["series"]["cash"]["mean"], "outcome": res["outcome"],
                    "violations": [c["label"] for c in res["constraints"] if c["violated"]]})
    return {"label": DEMO_LABEL, "store": DEMO_NAME, "horizon_days": 90, "mode": "deterministic",
            "assumptions": extra, "worlds": out}
