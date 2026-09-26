"""GET /v1/health (docs/API.md §8.1). No auth; never touches the model."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from tamber_api import API_VERSION, SAMPLE_RATE, __version__
from tamber_api.routes.common import service_of, settings_of

router = APIRouter()

SPEED_MIN = 0.25
SPEED_MAX = 4.0


@router.get("/v1/health", tags=["health"])
async def health(request: Request) -> dict[str, Any]:
    settings = settings_of(request)
    service = service_of(request)
    engine = service.engine
    return {
        "status": service.health_status,
        "version": __version__,
        "api_version": API_VERSION,
        "engine": engine.name,
        "model": engine.model,
        "device": engine.device,
        "model_loaded": service.model_loaded,
        "auth_required": settings.auth_required,
        "sample_rate": SAMPLE_RATE,
        "formats": ["wav", "mp3"],
        "default_voice": service.default_voice(),
        "default_format": settings.default_format,
        "languages": service.language_infos(),
        "limits": {
            "max_text_chars": settings.max_text_chars,
            "max_upload_bytes": settings.max_upload_bytes,
            "max_extract_chars": settings.max_extract_chars,
            "chunk_target_chars": settings.chunk_target,
            "chunk_max_chars": settings.chunk_max,
            "rate_limit_per_minute": settings.rate_limit_per_minute,
            "speed_min": SPEED_MIN,
            "speed_max": SPEED_MAX,
            "max_blend_voices": settings.max_blend_voices,
        },
        "features": {
            "extract_url": True,
            "extract_file": True,
            "extract_html": True,
            "openai_compat": True,
            "voice_blending": True,
            "voice_preview": True,
        },
    }
