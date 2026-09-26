"""POST /v1/tts: synthesis with word timings, NDJSON stream or one JSON body (docs/API.md §8.4)."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from tamber_api.errors import TamberError
from tamber_api.routes.common import (
    AUTH_AND_LIMIT,
    ManagedStreamingResponse,
    json_body_openapi,
    read_json,
    request_id,
    service_of,
    settings_of,
    validate_body,
)

logger = logging.getLogger("tamber.tts")

router = APIRouter(dependencies=AUTH_AND_LIMIT, tags=["tts"])

TTS_FORMATS = ("wav", "mp3")


class TtsRequest(BaseModel):
    """Body of POST /v1/tts. Unknown fields are ignored."""

    model_config = ConfigDict(extra="ignore")

    text: str = Field(min_length=1, description="1..max_text_chars UTF-16 code units.")
    voice: str | None = Field(default=None, description="Voice id or blend spec.")
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    format: str | None = Field(default=None, description="wav (default) or mp3.")
    lang: str | None = Field(default=None, description="Lang code or alias; default from voice.")
    stream: bool = True
    chunk_mode: Literal["balanced", "sentence"] = "balanced"
    start_chunk: int = Field(default=0, ge=0)


@router.post("/v1/tts", openapi_extra=json_body_openapi(TtsRequest))
async def tts(request: Request) -> Response:
    settings = settings_of(request)
    service = service_of(request)
    body = validate_body(TtsRequest, await read_json(request))
    fmt = (body.format or settings.default_format).strip().lower()
    if fmt not in TTS_FORMATS:
        raise TamberError(
            400,
            "unsupported_format",
            f"format must be one of: {', '.join(TTS_FORMATS)}.",
            param="format",
        )
    service.ensure_ready()
    rid = request_id(request)
    job = service.prepare(
        request_id=rid,
        text=body.text,
        voice=body.voice,
        speed=body.speed,
        fmt=fmt,
        lang=body.lang,
        chunk_mode=body.chunk_mode,
        start_chunk=body.start_chunk,
    )
    ticket = service.admit()
    logger.info(
        "request_id=%s tts start chars=%d chunks=%d start_chunk=%d voice=%s lang=%s format=%s "
        "speed=%s stream=%s",
        rid,
        job.text_length,
        len(job.plan),
        job.start_chunk,
        job.voice.spec,
        job.lang,
        fmt,
        body.speed,
        body.stream,
    )
    if not body.stream:
        try:
            result = await service.collect(job, ticket, request.is_disconnected)
        finally:
            # Once the job has started, `events()` frees the slot itself, and only after any
            # in-flight worker thread has finished; releasing here could free it too early.
            service.release_unstarted(ticket)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    return ManagedStreamingResponse(
        service.stream(job, ticket, request.is_disconnected),
        on_close=lambda: service.release_unstarted(ticket),
        media_type="application/x-ndjson; charset=utf-8",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
            "X-Request-ID": rid,
        },
    )
