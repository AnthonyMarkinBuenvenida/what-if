"""Optional language-model access.

The application works fully without it. When no provider is configured,
every agent runs its deterministic path and labels its output as such.

Providers (WHATIF_AI_PROVIDER):
    anthropic           Claude through the official Anthropic SDK (default)
    openai_compatible   any server implementing POST {base}/chat/completions with
                        JSON-schema response_format (OpenAI, OpenRouter, Ollama, vLLM, ...)
    none                AI off

Every response is validated against a Pydantic schema before use. Keys stay
on the server; the browser only ever sees the provider name, model and status.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import datetime, timezone
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from ..config import settings

log = logging.getLogger("startup.llm")
T = TypeVar("T", bound=BaseModel)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class LLM:
    def __init__(self) -> None:
        self._client = None
        self._lock = threading.Lock()
        self.last_error: str | None = None
        self.last_error_at: str | None = None
        self.last_success_at: str | None = None
        self.last_model: str | None = None  # the model that produced the latest answer (may be a fallback)
        self.calls = 0
        self.failures = 0

    @property
    def available(self) -> bool:
        return settings.ai_enabled

    @property
    def provider(self) -> str:
        return settings.ai_provider

    @property
    def model(self) -> str:
        return settings.ai_model

    def status(self) -> dict:
        return {
            "provider": self.provider, "configured": self.available, "model": self.model if self.available else None,
            "setup_hint": None if self.available else settings.ai_setup_hint, "timeout_seconds": settings.ai_timeout,
            "calls": self.calls, "failures": self.failures, "last_success_at": self.last_success_at,
            "last_error": self.last_error, "last_error_at": self.last_error_at,
        }

    def _get_client(self):
        if self._client is None:
            import anthropic
            self._client = anthropic.Anthropic(timeout=settings.ai_timeout, max_retries=2)
        return self._client

    def _fail(self, message: str) -> None:
        with self._lock:
            self.failures += 1
            self.last_error, self.last_error_at = message, _now()
        log.warning("LLM call failed: %s", message)

    def _ok(self) -> None:
        with self._lock:
            self.last_error = None
            self.last_success_at = _now()

    def structured(self, system: str, prompt: str, schema: type[T], effort: str = "medium", timeout: float | None = None) -> T | None:
        """Return a validated instance of `schema`, or None if unavailable/failed."""
        if not self.available:
            return None
        with self._lock:
            self.calls += 1
        if self.provider == "openai_compatible":
            return self._openai_compatible(system, prompt, schema, timeout=timeout)
        return self._anthropic(system, prompt, schema, effort, timeout=timeout)

    def _anthropic(self, system: str, prompt: str, schema: type[T], effort: str, timeout: float | None = None) -> T | None:
        import anthropic
        try:
            client = self._get_client() if timeout is None else self._get_client().with_options(timeout=timeout)
            response = client.messages.parse(
                model=self.model,
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": prompt}],
                output_format=schema,
                output_config={"effort": effort},
                # Server-side fallback if the primary model declines a request.
                extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
                extra_body={"fallbacks": "default"},
            )
        except anthropic.AuthenticationError:
            self._fail("The Anthropic API key was rejected.")
        except anthropic.RateLimitError:
            self._fail("The AI service is rate limited; deterministic analysis was used.")
        except anthropic.APITimeoutError:
            self._fail(f"The AI service did not answer within {timeout or settings.ai_timeout:g} s; deterministic analysis was used.")
        except anthropic.APIConnectionError:
            self._fail("Could not reach the AI service; deterministic analysis was used.")
        except anthropic.APIStatusError as exc:
            self._fail(f"AI service error ({exc.status_code}); deterministic analysis was used.")
        except Exception as exc:  # validation of structured output, etc.
            self._fail(f"AI response could not be used ({type(exc).__name__}).")
        else:
            if response.stop_reason == "refusal":
                self._fail("The AI model declined this request; deterministic analysis was used.")
                return None
            if response.parsed_output is None:
                self._fail("The AI response did not match the expected format.")
                return None
            self._ok()
            self.last_model = self.model
            return response.parsed_output
        return None

    def _attempts(self) -> list[tuple[str, dict, str, dict]]:
        """(url, headers, model, extra body) in the order they are tried: the main endpoint's model and
        WHATIF_AI_FALLBACK_MODELS, then the optional backup endpoint (WHATIF_AI_BACKUP_*)."""
        out = []
        main_extra = {"reasoning_effort": settings.ai_reasoning_effort} if settings.ai_reasoning_effort else {}
        key = os.getenv("WHATIF_AI_API_KEY")
        headers = {"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})}
        for m in [self.model] + [m for m in settings.ai_fallback_models if m != self.model]:
            out.append((f"{settings.ai_base_url}/chat/completions", headers, m, main_extra))
        bkey = os.getenv("WHATIF_AI_BACKUP_API_KEY", "").strip()
        if settings.ai_backup_base_url and bkey:
            bheaders = {"Content-Type": "application/json", "Authorization": f"Bearer {bkey}"}
            for m in settings.ai_backup_models:
                out.append((f"{settings.ai_backup_base_url}/chat/completions", bheaders, m, settings.ai_backup_extra))
        return out

    def _openai_compatible(self, system: str, prompt: str, schema: type[T], transport=None, timeout: float | None = None) -> T | None:
        import httpx
        body = {
            "max_tokens": settings.ai_max_tokens,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            "response_format": {"type": "json_schema", "json_schema": {"name": schema.__name__, "schema": _portable_schema(schema.model_json_schema()), "strict": False}},
        }
        # Each attempt is tried in turn until one gives a valid answer. Thinking models count their reasoning
        # against max_tokens, so each endpoint can limit it (reasoning_effort, or the backup's extra body).
        attempts = self._attempts()
        rejected: set[str] = set()  # a rejected key is rejected for every model on that endpoint
        for i, (url, headers, model, extra) in enumerate(attempts):
            last = i == len(attempts) - 1
            if url in rejected:
                continue
            try:
                with httpx.Client(timeout=timeout or settings.ai_timeout, transport=transport or self._transport) as c:
                    r = c.post(url, headers=headers, json={**body, **extra, "model": model})
            except httpx.TimeoutException:
                self._fail(f"The AI service did not answer within {timeout or settings.ai_timeout:g} s; deterministic analysis was used.")
                continue
            except httpx.HTTPError:
                self._fail("Could not reach the AI service; deterministic analysis was used.")
                continue
            if r.status_code in (401, 403):
                self._read_response(r, schema, model)
                rejected.add(url)
                continue
            if r.status_code in (402, 404, 429) or r.status_code >= 500:
                if not last:
                    self._fail(f"{model} was unavailable (HTTP {r.status_code}); trying {attempts[i + 1][2]}.")
                    continue
            out = self._read_response(r, schema, model)
            if out is not None or last:
                return out
        return None

    def _read_response(self, r, schema: type[T], model: str) -> T | None:
        if r.status_code in (401, 403):
            self._fail("The AI service rejected the API key.")
            return None
        if r.status_code == 429:
            self._fail("The AI service is rate limited; deterministic analysis was used.")
            return None
        if r.status_code >= 400:
            try:
                # Provider messages can carry account-specific links; keep the words, drop the links.
                detail = re.sub(r"(?:https?://|www\.)\S+", "[link removed]", str(r.json().get("error", {}).get("message", "")))[:240]
            except (ValueError, AttributeError):
                detail = ""
            what = "the AI account needs more credits" if r.status_code == 402 else "AI service error"
            self._fail(f"{what} (HTTP {r.status_code}{': ' + detail if detail else ''}); deterministic analysis was used.")
            return None
        try:
            choice = r.json()["choices"][0]
            if choice.get("finish_reason") == "length":
                self._fail(f"The AI answer was cut off at the answer-length limit ({settings.ai_max_tokens} tokens, WHATIF_AI_MAX_TOKENS).")
                return None
            content = choice["message"]["content"]
            if isinstance(content, list):  # some servers return content parts
                content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip())
            out = schema.model_validate(json.loads(content))
        except (KeyError, IndexError, TypeError, ValueError, ValidationError) as exc:
            self._fail(f"AI response could not be used ({type(exc).__name__}).")
            return None
        self._ok()
        self.last_model = model
        return out

    _transport = None  # tests inject an httpx.MockTransport here


llm = LLM()


def public_reason(message: str | None) -> str:
    """A short, provider-neutral reason for an AI failure, safe to show in the browser."""
    m = (message or "").lower()
    if "cut off" in m:
        return "the AI answer was longer than the configured answer-length limit"
    if "credit" in m or "http 402" in m:
        return "the AI account does not have enough credits for this request"
    if "rate limit" in m:
        return "the AI service is rate limiting requests"
    if "did not answer" in m:
        return "the AI service did not answer in time"
    if "could not reach" in m:
        return "the AI service could not be reached"
    if "rejected" in m or "key" in m:
        return "the AI service did not accept the configured credentials"
    if "declined" in m:
        return "the AI model declined the request"
    if "could not be used" in m or "expected format" in m or "invalid" in m:
        return "the AI answer was not in the expected format"
    return "the AI service returned an error"

# Keywords many providers' structured-output grammars reject or compile slowly. Values are
# still enforced, because every response is validated against the Pydantic model afterwards.
_UNPORTABLE = {"pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
               "minItems", "maxItems", "format", "default"}


def _portable_schema(node):
    if isinstance(node, dict):
        return {k: _portable_schema(v) for k, v in node.items() if k not in _UNPORTABLE}
    if isinstance(node, list):
        return [_portable_schema(v) for v in node]
    return node


_NUM_RE = re.compile(r"(?<![A-Za-z])[-−]?[$₱€£¥]?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|K\b)?")


def _variants(v: float) -> list[float]:
    out = [v, abs(v)]
    if abs(v) <= 1.5:  # rates and probabilities may be quoted as percentages
        out += [v * 100, abs(v) * 100]
    return out


def ungrounded_numbers(text: str, facts: list[float]) -> list[str]:
    """Numbers in `text` that do not match any computed fact (±1.5% or ±1).

    Small integers (0-12) and years are allowed because they are usually
    counts, step numbers or dates rather than results.
    """
    allowed: list[float] = []
    for f in facts:
        if f is None:
            continue
        allowed.extend(_variants(float(f)))
    bad = []
    for m in _NUM_RE.finditer(text):
        raw = m.group(0).strip()
        s = re.sub(r"[$₱€£¥,]", "", raw).replace("−", "-").strip()
        mult = 1.0
        if s.lower().endswith("k"):
            mult, s = 1000.0, s[:-1].strip()
        s = s.rstrip("%").strip()
        try:
            val = float(s) * mult
        except ValueError:
            continue
        if abs(val) <= 12 or (1990 <= val <= 2100 and float(val).is_integer()):
            continue
        if not any(abs(val - a) <= max(1.0, abs(a) * 0.015) for a in allowed):
            bad.append(raw)
    return bad
