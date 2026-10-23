"""Runtime configuration, read from environment variables.

Nothing secret is ever sent to the frontend. See README.md for the full list.
"""
from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
# STARTUP_DATA_DIR moves the database and generated files (hosts such as Vercel only allow writing to /tmp).
DATA_DIR = Path(os.getenv("STARTUP_DATA_DIR") or BACKEND_DIR / "data")


def _load_dotenv() -> None:
    """Minimal .env loader so local setup needs no extra dependency."""
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


def _secret_key() -> str:
    configured = os.getenv("STARTUP_SECRET_KEY")
    if configured:
        return configured
    # Persist a generated key so sessions survive restarts in local development.
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key_file = DATA_DIR / ".secret_key"
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip()
    key = secrets.token_urlsafe(48)
    key_file.write_text(key, encoding="utf-8")
    return key


@dataclass(frozen=True)
class Settings:
    database_url: str = field(
        default_factory=lambda: os.getenv(
            "DATABASE_URL", f"sqlite:///{(DATA_DIR / 'startup.db').as_posix()}"
        )
    )
    secret_key: str = field(default_factory=_secret_key)
    cookie_secure: bool = os.getenv("STARTUP_COOKIE_SECURE", "0") == "1"
    max_workers: int = int(os.getenv("STARTUP_SIM_WORKERS", str(max(2, min(4, (os.cpu_count() or 2) // 2)))))
    max_upload_bytes: int = int(os.getenv("STARTUP_MAX_UPLOAD_BYTES", str(5 * 1024 * 1024)))
    # AI: enabled only when the selected provider has credentials and AI is not explicitly disabled.
    # WHATIF_AI_PROVIDER = anthropic (default) | openai_compatible | none
    ai_disabled: bool = os.getenv("STARTUP_AI_DISABLED", "0") == "1"
    ai_provider: str = os.getenv("WHATIF_AI_PROVIDER", "anthropic").strip().lower()
    ai_model: str = os.getenv("WHATIF_AI_MODEL") or os.getenv("STARTUP_AI_MODEL", "claude-opus-5-5")
    ai_timeout: float = float(os.getenv("WHATIF_AI_TIMEOUT_SECONDS", "60"))
    # Output cap for OpenAI-compatible providers. Without it, OpenRouter reserves credit for the
    # model's full maximum output and refuses requests on small balances (HTTP 402).
    ai_max_tokens: int = int(os.getenv("WHATIF_AI_MAX_TOKENS", "4000"))
    # Optional "low" | "medium" | "high" for thinking models on OpenAI-compatible endpoints (e.g. Gemini).
    ai_reasoning_effort: str = os.getenv("WHATIF_AI_REASONING_EFFORT", "").strip().lower()
    # Comma-separated models tried in order when the main model is overloaded (HTTP 429/5xx) or times out.
    ai_fallback_models: tuple[str, ...] = tuple(m.strip() for m in os.getenv("WHATIF_AI_FALLBACK_MODELS", "").split(",") if m.strip())
    # Optional second OpenAI-compatible endpoint, tried after the main one (e.g. OpenRouter free models behind Gemini).
    # Its key is WHATIF_AI_BACKUP_API_KEY; WHATIF_AI_BACKUP_EXTRA is JSON merged into each request body.
    ai_backup_base_url: str = os.getenv("WHATIF_AI_BACKUP_BASE_URL", "").rstrip("/")
    ai_backup_models: tuple[str, ...] = tuple(m.strip() for m in os.getenv("WHATIF_AI_BACKUP_MODELS", "").split(",") if m.strip())
    ai_backup_extra: dict = field(default_factory=lambda: json.loads(os.getenv("WHATIF_AI_BACKUP_EXTRA") or "{}"))
    # OpenAI-compatible endpoints (OpenAI, OpenRouter, Ollama, vLLM, ...): base URL ending in /v1
    ai_base_url: str = os.getenv("WHATIF_AI_BASE_URL", "").rstrip("/")
    cors_origins: tuple[str, ...] = tuple(
        o.strip() for o in os.getenv("STARTUP_CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()
    )

    @property
    def ai_enabled(self) -> bool:
        if self.ai_disabled or self.ai_provider == "none":
            return False
        if self.ai_provider == "openai_compatible":
            # Hosted endpoints (OpenRouter, OpenAI) need a key; local servers (Ollama, vLLM) usually don't.
            local = any(h in self.ai_base_url for h in ("://localhost", "://127.0.0.1", "://0.0.0.0"))
            return bool(self.ai_base_url and os.getenv("WHATIF_AI_MODEL") and (local or os.getenv("WHATIF_AI_API_KEY", "").strip()))
        return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))

    @property
    def ai_setup_hint(self) -> str:
        if self.ai_disabled or self.ai_provider == "none":
            return "AI is turned off (STARTUP_AI_DISABLED=1 or WHATIF_AI_PROVIDER=none)."
        if self.ai_provider == "openai_compatible":
            return "Set WHATIF_AI_BASE_URL (ending in /v1), WHATIF_AI_MODEL and, if required, WHATIF_AI_API_KEY in backend/.env."
        if self.ai_provider != "anthropic":
            return f"Unknown WHATIF_AI_PROVIDER '{self.ai_provider}'. Use anthropic, openai_compatible or none."
        return "Set ANTHROPIC_API_KEY in backend/.env (see backend/.env.example), then restart the backend."


settings = Settings()
