import os
import tempfile

# Isolated database and deterministic agents for every test session.
_tmp = tempfile.mkdtemp(prefix="startup-test-")
# TEST_DATABASE_URL runs the suite against another database (e.g. a throwaway Postgres); SQLite by default.
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{_tmp}/test.db"
os.environ["STARTUP_AI_DISABLED"] = "1"
os.environ["STARTUP_SECRET_KEY"] = "test-secret"


def pytest_report_header(config):
    from app.db import engine
    return f"database: {engine.url.get_backend_name()} ({engine.url.host or engine.url.database})"


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_workspace_limit():
    """Tests open many workspaces from one address; the per-address creation limit (30/hour) applies per test."""
    from app import auth
    auth._created.clear()
    yield
