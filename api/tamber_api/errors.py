"""Error envelope (docs/API.md §4) and exception handlers.

Every non-2xx response body is::

    {"error": {"code", "message", "type", "param", "request_id", "details"}}

a superset of OpenAI's error object, so OpenAI SDKs parse it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response
from starlette.types import Scope

logger = logging.getLogger("tamber.errors")

_TYPE_BY_CODE = {
    "unauthorized": "authentication_error",
    "rate_limited": "rate_limit_error",
}


def error_type(status: int, code: str) -> str:
    if code in _TYPE_BY_CODE:
        return _TYPE_BY_CODE[code]
    return "server_error" if status >= 500 else "invalid_request_error"


class TamberError(Exception):
    """An error that maps directly onto the §4 envelope."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        param: str | None = None,
        details: Any = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.param = param
        self.details = details
        self.headers = dict(headers or {})


def request_id_from_scope(scope: Scope) -> str | None:
    state = scope.get("state")
    if isinstance(state, Mapping):
        rid = state.get("request_id")
        return rid if isinstance(rid, str) else None
    return None


def error_body(
    status: int,
    code: str,
    message: str,
    *,
    param: str | None = None,
    request_id: str | None = None,
    details: Any = None,
) -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "type": error_type(status, code),
            "param": param,
            "request_id": request_id,
            "details": details,
        }
    }


def error_response(
    status: int,
    code: str,
    message: str,
    *,
    param: str | None = None,
    request_id: str | None = None,
    details: Any = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    body = error_body(status, code, message, param=param, request_id=request_id, details=details)
    return JSONResponse(body, status_code=status, headers=dict(headers or {}))


def error_bytes(
    status: int, code: str, message: str, request_id: str | None, **kwargs: Any
) -> bytes:
    body = error_body(status, code, message, request_id=request_id, **kwargs)
    return json.dumps(body, separators=(",", ":")).encode()


def _clean_validation_errors(errors: Sequence[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for err in errors:
        if not isinstance(err, Mapping):
            continue
        loc = [p if isinstance(p, int | str) else str(p) for p in err.get("loc", ())]
        out.append({"loc": loc, "msg": str(err.get("msg", "")), "type": str(err.get("type", ""))})
    return out


def validation_param(details: list[dict[str, Any]]) -> str | None:
    for d in details:
        loc = [p for p in d.get("loc", []) if p not in ("body", "query", "path", "header")]
        if loc and isinstance(loc[0], str):
            return loc[0]
    return None


def invalid_request(details: list[dict[str, Any]], message: str | None = None) -> TamberError:
    if message is None:
        first = details[0] if details else None
        if first:
            where = ".".join(str(p) for p in first["loc"] if p not in ("body", "query", "path"))
            message = f"Invalid request: {where + ': ' if where else ''}{first['msg']}"
        else:
            message = "Invalid request."
    return TamberError(
        400, "invalid_request", message, param=validation_param(details), details=details
    )


def _rid(request: Request) -> str | None:
    return request_id_from_scope(request.scope)


async def _tamber_error_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, TamberError)
    if exc.status >= 500:
        logger.warning("request_id=%s error code=%s status=%s", _rid(request), exc.code, exc.status)
    return error_response(
        exc.status,
        exc.code,
        exc.message,
        param=exc.param,
        request_id=_rid(request),
        details=exc.details,
        headers=exc.headers,
    )


async def _validation_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, RequestValidationError)
    details = _clean_validation_errors(exc.errors())
    err = invalid_request(details)
    return error_response(
        400,
        err.code,
        err.message,
        param=err.param,
        request_id=_rid(request),
        details=details,
    )


async def _http_exception_handler(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)
    headers = dict(exc.headers or {})
    if exc.status_code == 404:
        return error_response(
            404,
            "not_found",
            f"No route for {request.method} {request.url.path}.",
            request_id=_rid(request),
            headers=headers,
        )
    if exc.status_code == 405:
        return error_response(
            405,
            "method_not_allowed",
            f"Method {request.method} is not allowed on {request.url.path}.",
            request_id=_rid(request),
            headers=headers,
        )
    code = "internal_error" if exc.status_code >= 500 else "invalid_request"
    return error_response(
        exc.status_code,
        code,
        str(exc.detail) if exc.detail else "Request failed.",
        request_id=_rid(request),
        headers=headers,
    )


def install_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(TamberError, _tamber_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
