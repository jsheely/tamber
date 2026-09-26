"""In-process sliding-window rate limiter (docs/API.md §5).

The key is the presented API key (hashed) when auth is on, otherwise the client IP. uvicorn's
`--proxy-headers --forwarded-allow-ips` already rewrites the client address from X-Forwarded-For
only when the direct peer is trusted, so `request.client.host` is the right IP here.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque

from fastapi import Request

from tamber_api.config import Settings
from tamber_api.errors import TamberError

WINDOW_SECONDS = 60.0


class SlidingWindowLimiter:
    def __init__(self, limit_per_minute: int, window: float = WINDOW_SECONDS) -> None:
        self.limit = limit_per_minute
        self.window = window
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()
        self._last_sweep = time.monotonic()

    def _sweep(self, now: float) -> None:
        if now - self._last_sweep < self.window:
            return
        self._last_sweep = now
        cutoff = now - self.window
        for key in [k for k, q in self._hits.items() if not q or q[-1] <= cutoff]:
            del self._hits[key]

    def hit(self, key: str) -> tuple[bool, int, float]:
        """Record a request. Returns (allowed, remaining, retry_after_seconds)."""
        now = time.monotonic()
        with self._lock:
            self._sweep(now)
            q = self._hits.setdefault(key, deque())
            cutoff = now - self.window
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.limit:
                retry = q[0] + self.window - now
                return False, 0, max(retry, 0.0)
            q.append(now)
            return True, self.limit - len(q), 0.0


def client_key(request: Request) -> str:
    identity = getattr(request.state, "client_identity", None)
    if isinstance(identity, str):
        return identity
    host = request.client.host if request.client else "unknown"
    return "ip:" + host


def _set_headers(request: Request, headers: dict[str, str]) -> None:
    existing = getattr(request.state, "response_headers", None)
    if isinstance(existing, dict):
        existing.update(headers)
    else:
        request.state.response_headers = dict(headers)


def check_rate_limit(request: Request) -> None:
    """Count this request; raise 429 when over the limit. No-op when the limit is 0."""
    settings: Settings = request.app.state.settings
    limiter: SlidingWindowLimiter = request.app.state.limiter
    if settings.rate_limit_per_minute <= 0:
        return
    allowed, remaining, retry_after = limiter.hit(client_key(request))
    headers = {
        "X-RateLimit-Limit": str(settings.rate_limit_per_minute),
        "X-RateLimit-Remaining": str(remaining),
    }
    _set_headers(request, headers)
    if not allowed:
        retry = str(max(1, math.ceil(retry_after)))
        raise TamberError(
            429,
            "rate_limited",
            f"Too many requests. Try again in {retry} s.",
            headers={**headers, "Retry-After": retry},
        )


async def rate_limit(request: Request) -> None:
    """Dependency form of `check_rate_limit` (runs after `require_auth`)."""
    check_rate_limit(request)
