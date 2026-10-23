"""Shared handling for apilayer APIs (Weatherstack, Marketstack): API key and error format.

Both need a personal key, sent as the `access_key` query parameter. What-if reads it from
backend/.env and never stores or shows it: base.redact removes it from every recorded URL.

Free plans (checked 2026-10-23 on weatherstack.com/product and marketstack.com/product):
100 requests per month, HTTPS included, non-commercial use only. Responses are cached and
retrieval only happens when the user refreshes, so a month's allowance goes a long way.

Error bodies seen live (2026-10-23, HTTP 401 with an invalid key):
    Weatherstack  {"success": false, "error": {"code": 101, "type": "invalid_access_key", "info": "..."}}
    Marketstack   {"error": {"code": "invalid_access_key", "message": "..."}}
Weatherstack may also report errors inside an HTTP 200 body, so both forms are checked.
"""
from __future__ import annotations

import os

import httpx

from .base import Connector, Fetched, SourceError

# Weatherstack numeric codes -> the error types Marketstack uses as codes.
NUMERIC = {101: "invalid_access_key", 102: "inactive_user", 104: "usage_limit_reached", 105: "function_access_restricted",
           601: "missing_query", 615: "request_failed"}


class ApiLayer(Connector):
    key_env = ""

    def key(self) -> str:
        return os.getenv(self.key_env, "").strip()

    def configured(self) -> bool:
        return bool(self.key())

    def call(self, path: str, params: dict) -> Fetched:
        if not self.configured():
            raise self.fail("not_configured", f"{self.info.name} needs an API key: add {self.key_env} to backend/.env and restart What-if.")
        full = {**params, "access_key": self.key()}
        f = self.get(path, full)
        err = self._explain(f.data, f.url)
        if err:
            with self._lock:  # an error inside HTTP 200 must not be served from cache later
                self._cache.pop(self._url(path, full), None)
            self._record_error(err)
            raise err
        return f

    def http_error(self, r: httpx.Response, url: str) -> SourceError | None:
        try:
            body = r.json()
        except ValueError:
            return None
        return self._explain(body, url, r.status_code)

    def _explain(self, body, url: str, status: int | None = None) -> SourceError | None:
        if not isinstance(body, dict) or not (body.get("success") is False or isinstance(body.get("error"), dict)):
            return None
        e = body.get("error") or {}
        code = e.get("type") or (NUMERIC.get(e.get("code")) if isinstance(e.get("code"), int) else e.get("code")) or "unknown"
        info = (e.get("info") or e.get("message") or "").split(" [Technical Support")[0].strip()
        name = self.info.name
        if code in ("invalid_access_key", "missing_access_key", "inactive_user"):
            return SourceError(self.info.id, "auth", f"{name} rejected the API key in {self.key_env} ({code}). Check the key on your {name} dashboard.", url, status)
        if code == "usage_limit_reached":
            return SourceError(self.info.id, "rate_limited", f"Your {name} monthly request allowance is used up (the free plan has 100 per month). It resets with your billing period.", url, status)
        if code == "function_access_restricted":
            return SourceError(self.info.id, "plan_restricted", f"Your {name} plan does not include this request. {info}".strip(), url, status)
        if code in ("request_failed", "no_valid_symbols_provided", "missing_query"):
            return SourceError(self.info.id, "not_found", f"{name} found nothing for this request ({code}). {info}".strip(), url, status)
        return SourceError(self.info.id, "http", f"{name} error {code}: {info or 'no details given'}.", url, status)
