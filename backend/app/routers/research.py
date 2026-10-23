"""Public market data: Open Prices, Open Food Facts, World Bank, GDELT and Frankfurter.

Every response carries source URLs and retrieval times. When a source fails,
the response says so ({"ok": false, "error": ...}); nothing is substituted.
Endpoints require a workspace so What-if is not an open proxy for these APIs.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import current_workspace
from ..db import get_db
from ..models import ResearchBrief, Scenario, Workspace
from ..research import BRIEF_INDICATORS, COUNTRIES, build_brief, default_news_query
from ..services import active_version, audit, owned, owned_business, scenario_out
from ..sources import CONNECTORS, frankfurter, gdelt, open_food_facts, open_prices, world_bank
from ..sources.base import SourceError
from ..sources.frankfurter import convert
from ..sources.world_bank import INDICATORS

router = APIRouter(prefix="/api", tags=["research"])
CC = re.compile(r"^[A-Za-z]{2}$")


def _cc(country: str) -> str:
    if not CC.match(country or ""):
        raise HTTPException(422, "Use a two-letter country code, such as PH.")
    return country.upper()


def _failed(exc: SourceError) -> dict:
    return {"ok": False, "error": exc.as_dict()}


@router.get("/research/sources")
def sources(_ws: Workspace = Depends(current_workspace)):
    """Connector configuration and health from this server's requests so far. Makes no external calls."""
    return {"sources": [c.describe() for c in CONNECTORS.values()],
            "countries": [{"code": k, **v} for k, v in COUNTRIES.items()],
            "indicators": [{"code": k, **v} for k, v in INDICATORS.items()]}


@router.get("/research/prices")
def country_prices(country: str = "PH", limit: int = Query(500, ge=1, le=1000), _ws: Workspace = Depends(current_workspace)):
    try:
        return {"ok": True, **open_prices.country_observations(_cc(country), limit)}
    except SourceError as exc:
        return _failed(exc)


@router.get("/research/prices/product/{code}")
def product_prices(code: str, country: str | None = None, _ws: Workspace = Depends(current_workspace)):
    if not re.fullmatch(r"\d{8,14}", code):
        raise HTTPException(422, "A barcode is 8 to 14 digits.")
    try:
        res = open_prices.product_observations(code, _cc(country) if country else None)
    except SourceError as exc:
        return _failed(exc)
    return {"ok": True, **res}


@router.get("/research/product/{code}")
def product(code: str, _ws: Workspace = Depends(current_workspace)):
    try:
        return {"ok": True, **open_food_facts.product(code)}
    except SourceError as exc:
        return _failed(exc)


@router.get("/research/economy")
def economy(country: str = "PH", indicators: str | None = None, _ws: Workspace = Depends(current_workspace)):
    cc = _cc(country)
    codes = [c for c in (indicators or ",".join(BRIEF_INDICATORS)).split(",") if c in INDICATORS][:9]
    rows, errors = [], []
    for code in codes:
        try:
            rows.append(world_bank.indicator(cc, code, 10))
        except SourceError as exc:
            errors.append({"indicator": code, **exc.as_dict()})
    return {"ok": bool(rows), "country": cc, "indicators": rows, "errors": errors}


@router.get("/research/news")
def news(q: str = Query(..., min_length=2, max_length=200), country: str | None = None, timespan: str = "1month",
         _ws: Workspace = Depends(current_workspace)):
    name = COUNTRIES.get(_cc(country), {}).get("name") if country else None
    try:
        return {"ok": True, **gdelt.articles(q, name, timespan, 25)}
    except SourceError as exc:
        return _failed(exc)


@router.get("/research/fx")
def fx(base: str = "USD", quote: str = "PHP", amount: float | None = None, days: int = Query(90, ge=0, le=1825),
       provider: str = "auto", _ws: Workspace = Depends(current_workspace)):
    from datetime import date, timedelta
    try:
        rate = frankfurter.rate(base, quote, provider=provider if provider != "blended" else None)
        series = frankfurter.series(base, quote, (date.today() - timedelta(days=days)).isoformat(), None,
                                    provider=provider if provider != "blended" else None) if days else None
    except SourceError as exc:
        return _failed(exc)
    return {"ok": True, "rate": rate, "series": series, "conversion": convert(amount, rate) if amount is not None else None}


# ---------------------------------------------------------------- briefs

class BriefIn(BaseModel):
    country: str = Field("PH", min_length=2, max_length=2)
    business_currency: str | None = Field(None, min_length=3, max_length=3)
    supplier_currency: str | None = Field(None, min_length=3, max_length=3)
    imported_share_pct: float | None = Field(None, gt=0, le=100)
    news_query: str | None = Field(None, max_length=200)


def _brief_out(r: ResearchBrief, full: bool = True) -> dict:
    out = {"id": r.id, "business_id": r.business_id, "country": r.country, "params": r.params, "created_at": r.created_at.isoformat()}
    if full:
        out["content"] = r.content
    else:
        c = r.content or {}
        out["sources"] = c.get("sources", [])
        out["proposal_count"] = len(c.get("proposals", []))
    return out


@router.get("/businesses/{business_id}/research/defaults")
def brief_defaults(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    v = active_version(db, b)
    return {"news_query": default_news_query(b.business_type), "business_currency": (v.spec.get("business") or {}).get("currency", "USD")}


@router.post("/businesses/{business_id}/research/briefs")
def create_brief(business_id: int, data: BriefIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    v = active_version(db, b)
    cc = _cc(data.country)
    for ccy in (data.supplier_currency, data.business_currency):
        if ccy and not re.fullmatch(r"[A-Za-z]{3}", ccy):
            raise HTTPException(422, "Use a three-letter currency code, such as USD.")
    content = build_brief(v.spec, b.business_type, cc, data.supplier_currency, data.imported_share_pct, data.news_query,
                          data.business_currency)
    content["model_version_id"] = v.id
    r = ResearchBrief(business_id=b.id, country=cc, params=data.model_dump(), content=content)
    db.add(r)
    db.flush()
    ok = [s["source"] for s in content["sources"] if s["status"] == "ok"]
    audit(db, b.id, "user", "research.brief_created", f"Research brief #{r.id} for {content['country_name']} ({len(ok)} of {len(content['sources'])} sources answered).",
          {"brief_id": r.id, "sources": content["sources"]}, ws.id)
    db.commit()
    return _brief_out(r)


@router.get("/businesses/{business_id}/research/briefs")
def list_briefs(business_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    b = owned_business(db, ws, business_id)
    return [_brief_out(r, False) for r in db.scalars(select(ResearchBrief).where(ResearchBrief.business_id == b.id).order_by(ResearchBrief.id.desc()))]


@router.get("/research/briefs/{brief_id}")
def get_brief(brief_id: int, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    return _brief_out(owned(db, ws, ResearchBrief, brief_id))


class ApplyIn(BaseModel):
    proposal_ids: list[str] = Field(min_length=1, max_length=6)


@router.post("/research/briefs/{brief_id}/apply")
def apply_proposals(brief_id: int, data: ApplyIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Create scenarios from proposals the user picked. Values are used exactly as shown in the brief."""
    r = owned(db, ws, ResearchBrief, brief_id)
    content = dict(r.content)
    by_id = {p["id"]: p for p in content.get("proposals", [])}
    unknown = [p for p in data.proposal_ids if p not in by_id]
    if unknown:
        raise HTTPException(422, f"Unknown proposal: {', '.join(unknown)}.")
    applied = dict(content.get("applied") or {})
    count = db.scalar(select(func.count()).select_from(Scenario).where(Scenario.business_id == r.business_id)) or 0
    created = []
    for pid in data.proposal_ids:
        if pid in applied:
            continue
        p = by_id[pid]
        s = Scenario(business_id=r.business_id, name=p["name"][:120], kind=p["kind"],
                     description=f"{p['method']} From research brief #{r.id} ({r.created_at.date().isoformat()}).",
                     decision="Test the business against conditions taken from public data",
                     color_index=(count + len(created)) % 8, is_baseline=False, levers=dict(p["levers"]),
                     assumptions=list(p["assumptions"]), config={"mode": "monte_carlo", "runs": 400, "horizon_days": 90},
                     success_criteria={}, origin=f"research:{p['source']}")
        db.add(s)
        db.flush()
        applied[pid] = s.id
        created.append(s)
    content["applied"] = applied
    r.content = content
    if created:
        audit(db, r.business_id, "user", "research.scenarios_created",
              f"Created {len(created)} scenario(s) from research brief #{r.id}: {', '.join(s.name for s in created)}.",
              {"brief_id": r.id, "scenario_ids": [s.id for s in created]}, ws.id)
    db.commit()
    return {"created": [scenario_out(db, s) for s in created], "applied": applied}
