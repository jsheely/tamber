"""The built web UI (docs/API.md §10), registered after every API route.

* existing files are served as is; other GET/HEAD requests accepting text/html get index.html;
* `/assets/*` (Vite's hashed output) is immutable for a year; index.html, the service worker and
  the manifest are `no-cache`; everything else is cached for an hour;
* unknown `/v1/*` paths are always a JSON 404, never the SPA;
* without a web build, `/` returns a small JSON banner.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.convertors import Convertor, register_url_convertor

from tamber_api.errors import TamberError

IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"
DEFAULT_CACHE = "public, max-age=3600"

_NO_CACHE_NAMES = {"index.html", "sw.js", "registerSW.js", "manifest.webmanifest"}
_WORKBOX_RE = re.compile(r"^workbox-[\w.-]+\.js$")

#: Explicit types: the OS registry (notably on Windows) can map .js to text/plain.
MEDIA_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
}

BANNER = {"name": "Tamber", "api": "/v1", "docs": "/docs"}


class WebPathConvertor(Convertor[str]):
    """Like Starlette's `path`, but never matches `v1` or `v1/...`.

    The SPA route must not even *match* API paths: otherwise a wrong method on a real API route
    (e.g. GET /v1/tts) would be a full match here instead of the router's 405.
    """

    regex = r"(?!v1(?:/|$)).*"

    def convert(self, value: str) -> str:
        return value

    def to_string(self, value: str) -> str:
        return value


register_url_convertor("webpath", WebPathConvertor())


def cache_control(rel_path: str) -> str:
    name = rel_path.rsplit("/", 1)[-1]
    if rel_path.startswith("assets/"):
        return IMMUTABLE
    if name in _NO_CACHE_NAMES or _WORKBOX_RE.match(name):
        return NO_CACHE
    return DEFAULT_CACHE


def media_type_for(path: Path) -> str | None:
    return MEDIA_TYPES.get(path.suffix.lower())


def _not_found(request: Request) -> TamberError:
    return TamberError(404, "not_found", f"No route for {request.method} {request.url.path}.")


def _resolve(root: Path, rel: str) -> Path | None:
    """The file under `root` for `rel`, refusing anything that escapes the root."""
    if not rel or "\x00" in rel:
        return None
    try:
        candidate = (root / rel).resolve()
    except (OSError, ValueError):
        return None
    if candidate != root and root not in candidate.parents:
        return None
    return candidate if candidate.is_file() else None


def build_static_router(web_root: Path | None) -> APIRouter:
    router = APIRouter(include_in_schema=False)

    if web_root is None:

        @router.get("/")
        async def banner() -> JSONResponse:
            return JSONResponse(BANNER)

        return router

    index = web_root / "index.html"

    def file_response(path: Path, rel: str) -> FileResponse:
        return FileResponse(
            path,
            media_type=media_type_for(path),
            headers={"Cache-Control": cache_control(rel)},
        )

    @router.get("/{full_path:webpath}")
    async def web(request: Request, full_path: str) -> Response:
        rel = full_path.lstrip("/")
        found = _resolve(web_root, rel)
        if found is not None:
            return file_response(found, found.relative_to(web_root).as_posix())
        accept = request.headers.get("accept", "")
        if "text/html" in accept or (rel == "" and not accept):
            return file_response(index, "index.html")
        raise _not_found(request)

    return router


def mount_web(app: FastAPI, web_root: Path | None) -> None:
    app.include_router(build_static_router(web_root))
