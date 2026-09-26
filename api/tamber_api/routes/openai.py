"""OpenAI-compatible endpoints (docs/API.md §9): /v1/audio/speech, /v1/models, /v1/audio/voices."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from typing import Any

import numpy as np
from fastapi import APIRouter, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from tamber_api.errors import TamberError
from tamber_api.routes.common import (
    AUTH,
    AUTH_AND_LIMIT,
    ManagedStreamingResponse,
    json_body_openapi,
    read_json,
    request_id,
    service_of,
    validate_body,
)
from tamber_api.tts.audio import ContinuousEncoder, encode_complete
from tamber_api.tts.service import IsDisconnected, Job, Ticket, TtsService
from tamber_api.tts.voices import OPENAI_VOICE_MAP, sort_voice_ids

logger = logging.getLogger("tamber.openai")

speech_router = APIRouter(dependencies=AUTH_AND_LIMIT, tags=["openai"])
router = APIRouter(dependencies=AUTH, tags=["openai"])

MODEL_IDS = ("kokoro", "tts-1", "tts-1-hd", "gpt-4o-mini-tts")
MODEL_CREATED = 1735689600

#: format -> (media type, file extension, streams progressively)
SPEECH_FORMATS: dict[str, tuple[str, str, bool]] = {
    "mp3": ("audio/mpeg", "mp3", True),
    "opus": ("audio/ogg", "opus", True),
    "aac": ("audio/aac", "aac", True),
    "flac": ("audio/flac", "flac", False),
    "wav": ("audio/wav", "wav", False),
    "pcm": ("audio/pcm", "pcm", True),
}


class SpeechRequest(BaseModel):
    """OpenAI `audio/speech` body. `instructions`, `stream_format` and others are ignored."""

    model_config = ConfigDict(extra="ignore")

    model: str | None = None
    input: str = Field(min_length=1)
    voice: str | None = None
    response_format: str = "mp3"
    speed: float = Field(default=1.0, ge=0.25, le=4.0)


def map_openai_voice(spec: str | None, service: TtsService) -> str | None:
    """OpenAI voice names map to Kokoro voices; a mapped voice that isn't available falls back
    to the default voice. Kokoro ids and blend specs pass through unchanged."""
    if spec is None:
        return None
    key = spec.strip().lower()
    mapped = OPENAI_VOICE_MAP.get(key)
    if mapped is None:
        return spec
    if mapped in service.available_voices():
        return mapped
    return service.default_voice()


async def _progressive(
    service: TtsService,
    job: Job,
    ticket: Ticket,
    fmt: str,
    is_disconnected: IsDisconnected,
) -> AsyncGenerator[bytes, None]:
    encoder = ContinuousEncoder(fmt)
    chunks = service.rendered_chunks(job, ticket, is_disconnected)
    started = time.perf_counter()
    total = 0
    # The in-flight encode. A cancelled `await` does not stop the worker thread, so the encoder
    # (native PyAV state) must not be closed until that thread has finished with it.
    write: asyncio.Future[bytes] | None = None
    try:
        async for rendered in chunks:
            write = asyncio.ensure_future(asyncio.to_thread(encoder.write, rendered.audio))
            data = await asyncio.shield(write)
            total += len(data)
            if data:
                yield data
        tail = encoder.finish()
        total += len(tail)
        if tail:
            yield tail
        logger.info(
            "request_id=%s speech done format=%s chars=%d chunks=%d bytes=%d elapsed_ms=%d",
            job.request_id,
            fmt,
            job.text_length,
            len(job.plan),
            total,
            round((time.perf_counter() - started) * 1000),
        )
    except TamberError:
        # Headers are already sent; the truncated body is all we can signal.
        logger.warning("request_id=%s speech stream failed", job.request_id)
    finally:
        await chunks.aclose()
        if write is None or write.done():
            encoder.close()
        else:

            def _close_after_write(future: asyncio.Future[bytes]) -> None:
                if not future.cancelled():
                    future.exception()  # mark retrieved; the client is gone anyway
                encoder.close()

            write.add_done_callback(_close_after_write)


@speech_router.post("/v1/audio/speech", openapi_extra=json_body_openapi(SpeechRequest))
async def speech(request: Request) -> Response:
    service = service_of(request)
    body = validate_body(SpeechRequest, await read_json(request))
    fmt = body.response_format.strip().lower()
    if fmt not in SPEECH_FORMATS:
        raise TamberError(
            400,
            "unsupported_format",
            f"response_format must be one of: {', '.join(SPEECH_FORMATS)}.",
            param="response_format",
        )
    media_type, ext, progressive = SPEECH_FORMATS[fmt]
    service.ensure_ready()
    rid = request_id(request)
    job = service.prepare(
        request_id=rid,
        text=body.input,
        voice=map_openai_voice(body.voice, service),
        speed=body.speed,
        fmt=fmt,
        lang=None,
        chunk_mode="balanced",
        start_chunk=0,
        text_param="input",
    )
    ticket = service.admit()
    logger.info(
        "request_id=%s speech start chars=%d chunks=%d voice=%s format=%s speed=%s",
        rid,
        job.text_length,
        len(job.plan),
        job.voice.spec,
        fmt,
        body.speed,
    )
    headers = {
        "Content-Disposition": f'inline; filename="speech.{ext}"',
        "Cache-Control": "no-store",
    }
    if progressive:
        headers["X-Accel-Buffering"] = "no"
        return ManagedStreamingResponse(
            _progressive(service, job, ticket, fmt, request.is_disconnected),
            on_close=lambda: service.release_unstarted(ticket),
            media_type=media_type,
            headers=headers,
        )
    audio = await service.render_full(job, ticket, request.is_disconnected)
    data = await asyncio.to_thread(encode_complete, audio.astype(np.float32, copy=False), fmt)
    return Response(content=data, media_type=media_type, headers=headers)


def _model(model_id: str) -> dict[str, Any]:
    return {"id": model_id, "object": "model", "created": MODEL_CREATED, "owned_by": "tamber"}


@router.get("/v1/models")
async def list_models() -> dict[str, Any]:
    return {"object": "list", "data": [_model(m) for m in MODEL_IDS]}


@router.get("/v1/models/{model_id}")
async def get_model(model_id: str) -> dict[str, Any]:
    if model_id not in MODEL_IDS:
        raise TamberError(404, "not_found", f"Unknown model '{model_id}'.", param="model")
    return _model(model_id)


@router.get("/v1/audio/voices")
async def audio_voices(request: Request) -> dict[str, Any]:
    service = service_of(request)
    ids = sort_voice_ids(service.available_voices())
    return {
        "voices": [{"id": v, "name": v} for v in ids],
        "default_voice": service.default_voice(),
    }
