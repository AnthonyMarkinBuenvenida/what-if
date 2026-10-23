import os
import tempfile

# Isolated database and deterministic agents for every test session.
_tmp = tempfile.mkdtemp(prefix="startup-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["STARTUP_AI_DISABLED"] = "1"
os.environ["STARTUP_SECRET_KEY"] = "test-secret"
