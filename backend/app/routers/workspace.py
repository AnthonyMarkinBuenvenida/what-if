"""Workspace lifecycle and system status. There are no accounts or logins."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..agents.llm import llm
from ..auth import current_workspace, limit_creation, new_workspace, set_cookie, workspace_from_request
from ..config import settings
from ..db import get_db
from ..engine.simulation import ENGINE_VERSION
from ..models import Business, Workspace

router = APIRouter(prefix="/api", tags=["workspace"])


def workspace_out(db: Session, ws: Workspace) -> dict:
    count = db.scalar(select(func.count()).select_from(Business).where(Business.user_id == ws.id)) or 0
    return {"id": ws.id, "created_at": ws.created_at.isoformat(), "businesses": count,
            "storage": "This workspace is tied to this browser by a cookie. Clearing site data removes access to it."}


@router.post("/workspace")
def open_workspace(request: Request, response: Response, db: Session = Depends(get_db)):
    """Resume this browser's workspace, or start a new one. No sign-in involved."""
    ws = workspace_from_request(request, db)
    if ws is None:
        limit_creation(request.client.host if request.client else "unknown")
        ws = new_workspace(db)
    set_cookie(response, ws.id)  # also refreshes the expiry
    return workspace_out(db, ws)


@router.get("/workspace")
def get_workspace(ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    return workspace_out(db, ws)


class ClearIn(BaseModel):
    confirm: str


@router.post("/workspace/clear")
def clear_workspace(data: ClearIn, ws: Workspace = Depends(current_workspace), db: Session = Depends(get_db)):
    """Delete every business (and its models, runs, reports) in this workspace."""
    if data.confirm != "DELETE":
        raise HTTPException(422, 'Type DELETE to confirm.')
    for b in db.scalars(select(Business).where(Business.user_id == ws.id)).all():
        db.delete(b)
    db.commit()
    return workspace_out(db, ws)


@router.get("/system/status")
def system_status():
    """What is actually connected. Never exposes secrets or service URLs."""
    from ..integrations.prometheus import prometheus
    return {
        "engine": ENGINE_VERSION,
        "ai": {
            "mode": "connected" if llm.available else "deterministic",
            "model": settings.ai_model if llm.available else None,
            "explanation": ("Agents use the configured Claude model for wording and proposals; all numbers come from the simulation engine."
                            if llm.available else
                            "No AI model is configured. Agents use What-if's deterministic rules and templates, and say so on each output. "
                            "Set ANTHROPIC_API_KEY on the server to connect one."),
        },
        "live_data": {"configured": prometheus.configured, "name": prometheus.display_name},
        "database": "sqlite" if settings.database_url.startswith("sqlite") else "external",
        "parallel_workers": settings.max_workers,
    }
