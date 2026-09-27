"""GET /v1/voices and GET /v1/voices/{voice_spec}/preview (docs/API.md §8.2, §8.3)."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import Response

from tamber_api.errors import TamberError
from tamber_api.ratelimit import check_rate_limit
from tamber_api.routes.common import AUTH, request_id, service_of
from tamber_api.tts.audio import encode_chunk
from tamber_api.tts.voices import (
    VOICE_ID_PATTERN,
    LRUCache,
    preview_text,
    sort_voice_ids,
    voice_info,
)

router = APIRouter(dependencies=AUTH, tags=["voices"])

PREVIEW_CACHE_SIZE = 64
_MEDIA_TYPES = {"wav": "audio/wav", "mp3": "audio/mpeg"}


@dataclass(frozen=True, slots=True)
class Preview:
    data: bytes
    etag: str
    media_type: str


def preview_cache(request: Request) -> LRUCache[tuple[str, str], Preview]:
    cache: LRUCache[tuple[str, str], Preview] | None = getattr(
        request.app.state, "preview_cache", None
    )
    if cache is None:
        cache = LRUCache(PREVIEW_CACHE_SIZE)
        request.app.state.preview_cache = cache
    return cache


@router.get("/v1/voices")
async def list_voices(request: Request) -> dict[str, Any]:
    service = service_of(request)
    default = service.default_voice()
    voices = [
        voice_info(v, default, service.word_timestamps(v[:1]))
        for v in sort_voice_ids(service.available_voices())
    ]
    return {
        "default_voice": default,
        "languages": service.language_infos(),
        "voices": voices,
    }


def _preview_response(preview: Preview, request: Request) -> Response:
    headers = {"Cache-Control": "private, max-age=86400", "ETag": preview.etag}
    if_none_match = request.headers.get("if-none-match", "")
    if preview.etag in [t.strip() for t in if_none_match.split(",")] or if_none_match == "*":
        return Response(status_code=304, headers=headers)
    return Response(content=preview.data, media_type=preview.media_type, headers=headers)


@router.get("/v1/voices/{voice_spec}/preview")
async def voice_preview(
    request: Request,
    voice_spec: str,
    format: str = Query("wav", description="wav or mp3"),
) -> Response:
    """Audition a single voice or a blend spec such as `af_heart(2)+af_bella(1)`."""
    service = service_of(request)
    fmt = format.strip().lower()
    if fmt not in _MEDIA_TYPES:
        raise TamberError(
            400,
            "unsupported_format",
            "Preview format must be 'wav' or 'mp3'.",
            param="format",
        )
    spec = voice_spec.strip()
    if VOICE_ID_PATTERN.match(spec) and spec not in service.available_voices():
        raise TamberError(404, "not_found", f"Unknown voice '{spec}'.", param="voice_spec")
    resolved = service.resolve_voice(spec)  # 400 unknown_voice for a bad blend spec
    # Keyed by the normalised mix so af_heart(2)+af_sky(1) and af_heart(4)+af_sky(2) share a clip.
    key = ("+".join(f"{vid}({w:.3f})" for vid, w in resolved.components), fmt)
    cache = preview_cache(request)
    cached = cache.get(key)
    if cached is not None:
        return _preview_response(cached, request)
    check_rate_limit(request)
    service.ensure_ready()
    job = service.prepare(
        request_id=request_id(request),
        text=preview_text(resolved.ids[0]),
        voice=resolved.spec,
        speed=1.0,
        fmt=fmt,
        lang=None,
        chunk_mode="balanced",
        start_chunk=0,
    )
    ticket = service.admit()
    audio = await service.render_full(job, ticket)
    data = encode_chunk(audio, fmt)
    etag = '"' + hashlib.sha256(data).hexdigest()[:32] + '"'
    preview = Preview(data=data, etag=etag, media_type=_MEDIA_TYPES[fmt])
    cache.put(key, preview)
    return _preview_response(preview, request)
