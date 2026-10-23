"""Anonymous, per-browser workspaces (no accounts, no login).

The first time a browser opens the workspace, the frontend calls
POST /api/workspace. The server creates a workspace and sets a signed,
httpOnly cookie that identifies it. Every business, model, run and report
belongs to one workspace, and every query is scoped to the workspace in the
cookie, so visitors cannot see or change each other's data.

There is nothing to sign up for and no password. Clearing the browser's
cookies loses access to that workspace's data (see README).
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import Workspace

COOKIE = "startup_workspace"
WORKSPACE_DAYS = 400
_created: dict[str, deque] = defaultdict(deque)


def _sign(payload: str) -> str:
    return hmac.new(settings.secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()


def make_token(workspace_id: int) -> str:
    exp = int(time.time()) + WORKSPACE_DAYS * 86400
    payload = f"{workspace_id}.{exp}"
    return f"{payload}.{_sign(payload)}"


def read_token(token: str) -> int | None:
    try:
        wid, exp, sig = token.split(".")
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(f"{wid}.{exp}")) or int(exp) < time.time():
        return None
    return int(wid)


def set_cookie(response: Response, workspace_id: int) -> None:
    response.set_cookie(COOKIE, make_token(workspace_id), max_age=WORKSPACE_DAYS * 86400, httponly=True,
                        samesite="lax", secure=settings.cookie_secure, path="/")


def limit_creation(key: str, limit: int = 30, window: int = 3600) -> None:
    """Throttle workspace creation per client address."""
    now = time.time()
    q = _created[key]
    while q and q[0] < now - window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "Too many new workspaces from this address. Try again later.")
    q.append(now)


def new_workspace(db: Session) -> Workspace:
    # Legacy columns from the account era stay in the table; anonymous
    # workspaces get an unusable placeholder in them.
    ws = Workspace(email=f"ws-{secrets.token_hex(8)}@workspace.local", name="Workspace", password_hash="!")
    db.add(ws)
    db.commit()
    return ws


def workspace_from_request(request: Request, db: Session) -> Workspace | None:
    token = request.cookies.get(COOKIE)
    wid = read_token(token) if token else None
    return db.get(Workspace, wid) if wid else None


def current_workspace(request: Request, db: Session = Depends(get_db)) -> Workspace:
    ws = workspace_from_request(request, db)
    if ws is None:
        raise HTTPException(401, "No workspace is open in this browser yet. Open the workspace to start one.")
    return ws
