"""Public, unauthenticated endpoints: landing showcase and the live demo.

They only ever use the built-in fictional sample store and in-memory sessions.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import demo

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/showcase")
def showcase(demand: float = 0.0, supplier: float = 0.0):
    return demo.showcase(demand, supplier)


@router.post("/demo/session")
def demo_session():
    return demo.new_session()


class DemoRunIn(BaseModel):
    session_id: str = Field(max_length=64)
    scenario_ids: list[str] = Field(min_length=1, max_length=5)
    assumptions: dict = Field(default_factory=dict)
    overrides: dict = Field(default_factory=dict)
    mode: str = Field("monte_carlo", pattern="^(monte_carlo|deterministic)$")
    runs: int = Field(300, ge=20, le=500)
    horizon_days: int = Field(90, ge=30, le=180)
    budget: float | None = Field(None, ge=0, le=100_000)


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(410, str(exc.args[0]) if exc.args else "Demo session expired.") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/demo/runs")
def demo_runs(data: DemoRunIn):
    return _guard(demo.submit_runs, data.session_id, data.scenario_ids, data.assumptions, data.mode, data.runs,
                  data.horizon_days, data.overrides, data.budget)


@router.get("/demo/runs")
def demo_list(session_id: str, ids: str | None = None, results: bool = False):
    id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()] if ids else None
    return _guard(demo.get_runs, session_id, id_list, results)


class DemoCompareIn(BaseModel):
    session_id: str
    run_ids: list[int] = Field(min_length=1, max_length=8)


@router.post("/demo/compare")
def demo_compare(data: DemoCompareIn):
    return _guard(demo.compare, data.session_id, data.run_ids)


class DemoStressIn(BaseModel):
    session_id: str
    scenario_id: str
    shocks: list[str] = Field(default_factory=list)
    custom: dict = Field(default_factory=dict)
    runs: int = Field(200, ge=20, le=300)
    budget: float | None = Field(None, ge=0, le=100_000)


@router.post("/demo/stress")
def demo_stress(data: DemoStressIn):
    return _guard(demo.stress, data.session_id, data.scenario_id, data.shocks, data.custom, data.runs, data.budget)


class DemoSensitivityIn(BaseModel):
    session_id: str
    scenario_id: str
    assumptions: dict = Field(default_factory=dict)
    budget: float | None = Field(None, ge=0, le=100_000)


@router.post("/demo/sensitivity")
def demo_sensitivity(data: DemoSensitivityIn):
    return _guard(demo.sensitivity, data.session_id, data.scenario_id, data.assumptions, data.budget)
