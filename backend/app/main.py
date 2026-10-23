from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .config import settings
from .db import init_db
from .jobs import recover_interrupted_runs
from .telemetry import HTTP_LATENCY, HTTP_REQUESTS, exposition
from .routers import businesses, insights, live, public, research, simulations, whatif, workspace

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    n = recover_interrupted_runs()
    if n:
        logging.getLogger("startup").info("Marked %d interrupted run(s) as failed.", n)
    yield


app = FastAPI(title="What-if API", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def require_client_header(request: Request, call_next):
    """CSRF guard: state-changing API calls must carry a custom header, which
    browsers will not attach to cross-site form posts."""
    if (request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/")
            and request.headers.get("x-startup-client") != "web"):
        return JSONResponse({"detail": "Missing X-StartUp-Client header."}, status_code=403)
    t0 = time.perf_counter()
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        route = getattr(request.scope.get("route"), "path", "unmatched")
        HTTP_REQUESTS.labels(request.method, route, str(response.status_code)).inc()
        HTTP_LATENCY.labels(route).observe(time.perf_counter() - t0)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    return response


for r in (workspace.router, businesses.router, simulations.router, insights.router, public.router, live.router, research.router,
          whatif.router):
    app.include_router(r)


@app.get("/metrics", include_in_schema=False)
def metrics():
    """What-if's own operational telemetry in the Prometheus text format."""
    if os.getenv("STARTUP_METRICS_ENABLED", "1") == "0":
        return JSONResponse({"detail": "Metrics are disabled."}, status_code=404)
    body, ctype = exposition()
    return Response(body, media_type=ctype)


@app.get("/api/health")
def health():
    return {"ok": True}


# Serve the built frontend when it exists (production / single-process mode).
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/") or path == "metrics":
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = FRONTEND_DIST / path
        if path and candidate.is_file() and FRONTEND_DIST in candidate.resolve().parents:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
