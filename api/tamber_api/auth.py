"""Optional API-key auth (docs/API.md §2). Keys are compared in constant time and never logged."""

from __future__ import annotations

import hashlib
import hmac

from fastapi import Request

from tamber_api.config import Settings
from tamber_api.errors import TamberError

_CHALLENGE = {"WWW-Authenticate": 'Bearer realm="tamber"'}


def presented_key(request: Request) -> str | None:
    """The key from `Authorization: Bearer <key>` or `X-API-Key: <key>`, if any."""
    auth = request.headers.get("authorization")
    if auth:
        scheme, _, value = auth.strip().partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    header_key = request.headers.get("x-api-key")
    if header_key and header_key.strip():
        return header_key.strip()
    return None


def key_matches(candidate: str, keys: tuple[str, ...]) -> bool:
    """Constant-time comparison against every configured key (no early exit)."""
    cand = candidate.encode("utf-8")
    matched = False
    for key in keys:
        matched |= hmac.compare_digest(cand, key.encode("utf-8"))
    return matched


def client_identity(key: str) -> str:
    """Non-reversible identifier for a key (rate-limit bucket); the key itself is never stored."""
    return "key:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


async def require_auth(request: Request) -> None:
    """Dependency for every /v1 route except GET|HEAD /v1/health."""
    settings: Settings = request.app.state.settings
    if not settings.auth_required:
        return
    key = presented_key(request)
    if key is None or not key_matches(key, settings.api_keys):
        raise TamberError(
            401,
            "unauthorized",
            "A valid API key is required. Send it as 'Authorization: Bearer <key>'.",
            headers=_CHALLENGE,
        )
    request.state.client_identity = client_identity(key)
