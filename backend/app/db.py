"""Database engine, sessions, additive migrations and health.

Storage is chosen by DATABASE_URL:
    unset                      SQLite file in STARTUP_DATA_DIR (default backend/data/startup.db): durable on a normal disk
    postgres:// / postgresql://  hosted Postgres (Neon on Vercel): durable across instances and restarts

Startup never drops, truncates or resets anything. Tables that do not exist are created and missing
columns are added (ADD COLUMN only); existing rows are left as they are.
"""
from __future__ import annotations

import logging
import os
from collections.abc import Iterator

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DATA_DIR, settings

log = logging.getLogger("startup.db")


class Base(DeclarativeBase):
    pass


def normalize_url(url: str) -> str:
    """postgres:// and plain postgresql:// (as hosting providers hand them out) use the psycopg 3 driver."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]
    return url


def _make_engine(url: str):
    url = normalize_url(url)
    kwargs: dict = {"future": True}
    if url.startswith("sqlite"):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    elif url.startswith("postgresql"):
        # Serverless-friendly: small pool, check connections before use, recycle before the provider closes them.
        # prepare_threshold=None keeps psycopg compatible with transaction-pooling endpoints (Neon's pooler, PgBouncer).
        kwargs.update(pool_pre_ping=True, pool_size=2, max_overflow=3, pool_recycle=300,
                      connect_args={"prepare_threshold": None, "connect_timeout": 10})
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - driver hook
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()
    return engine


engine = _make_engine(settings.database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _add_missing_columns(eng=None) -> list[str]:
    """ADD COLUMN for model columns the existing tables do not have yet. Never drops or alters data."""
    eng = eng or engine
    added = []
    insp = inspect(eng)
    existing_tables = set(insp.get_table_names())
    with eng.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            have = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in have:
                    continue
                ddl_type = col.type.compile(dialect=eng.dialect)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{col.name}" {ddl_type}'))
                added.append(f"{table.name}.{col.name}")
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue  # create_all makes new tables with their indexes
            for idx in table.indexes:
                cols = ", ".join(f'"{c.name}"' for c in idx.columns)
                unique = "UNIQUE " if idx.unique else ""
                conn.execute(text(f'CREATE {unique}INDEX IF NOT EXISTS "{idx.name}" ON "{table.name}" ({cols})'))
    return added


def init_db() -> None:
    from . import models  # noqa: F401  (register tables)

    Base.metadata.create_all(engine)
    added = _add_missing_columns()
    if added:
        log.info("Database migrated (columns added, no data changed): %s", ", ".join(added))


def storage_info() -> dict:
    """Which database is in use and whether it survives restarts and redeploys."""
    url = engine.url
    kind = url.get_backend_name()
    if kind == "sqlite":
        path = url.database or ""
        ephemeral = os.getenv("VERCEL") == "1" or path.replace("\\", "/").startswith("/tmp")
        return {"kind": "sqlite", "durable": not ephemeral, "location": "temporary server storage (/tmp)" if ephemeral else "local SQLite file",
                "note": ("Data in /tmp is lost when the server instance stops. Set DATABASE_URL to a hosted Postgres database."
                         if ephemeral else "Back up the file with `python -m scripts.backup_db`.")}
    # The server address is not shown: it is not needed to judge durability and need not be public.
    return {"kind": kind, "durable": True, "location": "hosted PostgreSQL" if kind == "postgresql" else f"hosted {kind}", "note": "Hosted database; data survives restarts and redeploys."}


def db_health() -> dict:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"ok": True, **storage_info()}
    except Exception as exc:  # pragma: no cover - depends on the server
        log.warning("Database health check failed: %s", type(exc).__name__)
        return {"ok": False, **storage_info(), "error": "The database could not be reached."}


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
