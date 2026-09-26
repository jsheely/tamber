"""ASGI middleware: request ids, version header, CORS, body-size limits and a last-resort 500.

Order, outermost first::

    RequestContext -> CORS -> BodyLimit -> HeadAsGet -> CatchAll -> (FastAPI exceptions) -> routes

RequestContext is outermost so that every response (CORS preflights and 500s included) carries
X-Request-ID and X-Tamber-Version. CatchAll turns unhandled exceptions into the §4 envelope inside
CORS, so browsers can read them. There is deliberately NO compression middleware: a compressor
would hold NDJSON lines in its buffer (docs/API.md §1).
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable, MutableMapping
from typing import Any

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from tamber_api import __version__
from tamber_api.config import Settings
from tamber_api.errors import TamberError, error_bytes, request_id_from_scope

logger = logging.getLogger("tamber.http")

_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

CORS_ALLOW_METHODS = ["GET", "HEAD", "POST", "OPTIONS"]
CORS_ALLOW_HEADERS = ["Authorization", "Content-Type", "Accept", "X-API-Key", "X-Request-ID"]
CORS_EXPOSE_HEADERS = [
    "X-Request-ID",
    "X-Tamber-Version",
    "Retry-After",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
]


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", ()):
        if key.lower() == name:
            try:
                return bytes(value).decode("latin-1")
            except Exception:
                return None
    return None


class RequestContextMiddleware:
    """Assigns the request id and adds X-Request-ID / X-Tamber-Version (+ rate-limit headers)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = _header(scope, b"x-request-id")
        rid = incoming if incoming and _REQUEST_ID_RE.match(incoming) else uuid.uuid4().hex
        state: MutableMapping[str, Any] = scope.setdefault("state", {})
        state["request_id"] = rid

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() not in (b"x-request-id", b"x-tamber-version")
                ]
                headers.append((b"x-request-id", rid.encode()))
                headers.append((b"x-tamber-version", __version__.encode()))
                extra = state.get("response_headers")
                if isinstance(extra, dict):
                    present = {k.lower() for k, _ in headers}
                    for name, value in extra.items():
                        key = name.lower().encode("latin-1")
                        if key not in present:
                            headers.append((key, str(value).encode("latin-1")))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_wrapper)


class CatchAllMiddleware:
    """Converts unhandled exceptions into a 500 `internal_error` envelope (if not yet started)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_wrapper(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            rid = request_id_from_scope(scope)
            logger.exception("request_id=%s unhandled error", rid)
            if started:
                raise
            body = error_bytes(
                500,
                "internal_error",
                "Internal server error. The details are in the server log under this request id.",
                rid,
            )
            await send(
                {
                    "type": "http.response.start",
                    "status": 500,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})


class HeadAsGetMiddleware:
    """Serve HEAD wherever GET is served (docs/API.md §1): route as GET, drop the body."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "HEAD":
            await self.app(scope, receive, send)
            return

        async def send_without_body(message: Message) -> None:
            if message["type"] == "http.response.body":
                message = {**message, "body": b""}
            await send(message)

        await self.app({**scope, "method": "GET"}, receive, send_without_body)


class BodyTooLarge(TamberError):
    pass


class BodyLimitMiddleware:
    """Rejects request bodies over a per-route limit with 413 (before or while reading them)."""

    def __init__(
        self,
        app: ASGIApp,
        limit_for: Callable[[str, str], tuple[int, str, dict[str, Any] | None] | None],
    ) -> None:
        self.app = app
        self.limit_for = limit_for

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        rule = self.limit_for(scope.get("method", "GET"), scope.get("path", ""))
        if rule is None:
            await self.app(scope, receive, send)
            return
        limit, code, details = rule
        message = (
            "The request body is too large."
            if code == "file_too_large"
            else "The text is longer than this server accepts."
        )
        declared = _header(scope, b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            body = error_bytes(413, code, message, request_id_from_scope(scope), details=details)
            await send(
                {
                    "type": "http.response.start",
                    "status": 413,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                        (b"connection", b"close"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message_in = await receive()
            if message_in["type"] == "http.request":
                received += len(message_in.get("body", b""))
                if received > limit:
                    raise BodyTooLarge(413, code, message, details=details)
            return message_in

        await self.app(scope, limited_receive, send)


def install_middleware(app: FastAPI, settings: Settings) -> None:
    """Add middleware innermost first (Starlette puts the last-added outermost)."""
    upload_limit = settings.max_upload_bytes
    # JSON escaping can inflate text up to 6x (\uXXXX); allow generous slack for the envelope.
    text_body_limit = settings.max_text_chars * 6 + 64 * 1024
    text_details = {"max": settings.max_text_chars, "actual": None}

    def limit_for(method: str, path: str) -> tuple[int, str, dict[str, Any] | None] | None:
        if method != "POST":
            return None
        if path.endswith("/v1/extract"):
            return upload_limit + 1024 * 1024, "file_too_large", {"max": upload_limit}
        if path.endswith("/v1/tts") or path.endswith("/v1/audio/speech"):
            return text_body_limit, "text_too_long", text_details
        return None

    app.add_middleware(CatchAllMiddleware)
    app.add_middleware(HeadAsGetMiddleware)
    app.add_middleware(BodyLimitMiddleware, limit_for=limit_for)
    origins = settings.cors_origin_list
    if origins is not None:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=CORS_ALLOW_METHODS,
            allow_headers=CORS_ALLOW_HEADERS,
            expose_headers=CORS_EXPOSE_HEADERS,
            max_age=600,
        )
    app.add_middleware(RequestContextMiddleware)
