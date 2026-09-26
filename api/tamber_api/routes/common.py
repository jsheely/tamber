"""Helpers shared by the route modules."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any, TypeVar

from fastapi import Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ValidationError
from starlette.types import Receive, Scope, Send

from tamber_api.auth import require_auth
from tamber_api.config import Settings
from tamber_api.errors import TamberError, invalid_request, request_id_from_scope
from tamber_api.ratelimit import rate_limit
from tamber_api.tts.service import TtsService

logger = logging.getLogger("tamber.http")

M = TypeVar("M", bound=BaseModel)

AUTH = [Depends(require_auth)]
AUTH_AND_LIMIT = [Depends(require_auth), Depends(rate_limit)]

_JSON_TYPES = ("application/json", "text/plain", "")


def settings_of(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def service_of(request: Request) -> TtsService:
    service: TtsService = request.app.state.service
    return service


def request_id(request: Request) -> str:
    return request_id_from_scope(request.scope) or ""


def is_json_content_type(request: Request) -> bool:
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    return ctype in _JSON_TYPES or ctype.endswith("+json")


async def read_json(request: Request) -> Any:
    if not is_json_content_type(request):
        raise TamberError(
            415,
            "unsupported_media_type",
            "Send the request body as JSON with 'Content-Type: application/json'.",
        )
    raw = await request.body()
    if not raw.strip():
        raise invalid_request(
            [{"loc": ["body"], "msg": "Request body is required", "type": "missing"}],
            "The request body is empty; send a JSON object.",
        )
    try:
        return json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise invalid_request(
            [{"loc": ["body"], "msg": f"Invalid JSON: {exc}", "type": "json_invalid"}],
            "The request body is not valid JSON.",
        ) from exc


def validate_body(model: type[M], data: Any) -> M:
    """Validate a parsed JSON body; unknown fields are ignored (and logged at debug)."""
    if not isinstance(data, dict):
        raise invalid_request(
            [{"loc": ["body"], "msg": "Expected a JSON object", "type": "model_type"}],
            "The request body must be a JSON object.",
        )
    unknown = set(data) - set(model.model_fields)
    if unknown:
        logger.debug("Ignoring unknown request fields: %s", ", ".join(sorted(unknown)))
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        details = [
            {
                "loc": ["body", *[p for p in err["loc"]]],
                "msg": err["msg"],
                "type": err["type"],
            }
            for err in exc.errors()
        ]
        raise invalid_request(details) from exc


def json_body_openapi(model: type[BaseModel]) -> dict[str, Any]:
    """`openapi_extra` documenting a manually parsed JSON body."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }


class ManagedStreamingResponse(StreamingResponse):
    """A StreamingResponse that always closes its generator and runs `on_close` afterwards.

    Starlette abandons the body iterator when the client disconnects mid-send, and never starts it
    when the very first send fails. Closing it explicitly runs the generator's `finally` (which
    frees the synthesis slot); `on_close` covers the never-started case.
    """

    def __init__(
        self,
        content: AsyncIterator[bytes],
        *,
        on_close: Callable[[], None],
        media_type: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(content, media_type=media_type, headers=headers)
        self._generator = content
        self._on_close = on_close

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            aclose = getattr(self._generator, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:  # pragma: no cover - best effort
                    logger.debug("error closing stream generator", exc_info=True)
            self._on_close()
