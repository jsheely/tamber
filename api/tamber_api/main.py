"""FastAPI application factory.

uvicorn tamber_api.main:app --port 8880            # module-level app from the environment
create_app(settings=Settings(...), engine=FakeEngine())   # tests
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from tamber_api import __version__
from tamber_api.config import Settings, warn_unknown_keys
from tamber_api.errors import install_exception_handlers
from tamber_api.middleware import install_middleware
from tamber_api.ratelimit import SlidingWindowLimiter
from tamber_api.routes import extract, health, openai, static, tts, voices
from tamber_api.tts.engine import Engine, FakeEngine
from tamber_api.tts.service import TtsService

logger = logging.getLogger("tamber")

DESCRIPTION = (
    "Self-hosted Kokoro text-to-speech with word-level timestamps. "
    "docs/API.md in the repository is the normative contract; this schema is informational."
)


def configure_logging(level: str) -> None:
    numeric = getattr(logging, level.upper(), logging.INFO)
    root = logging.getLogger("tamber")
    root.setLevel(numeric)
    if not root.handlers and not logging.getLogger().handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)
        root.propagate = False


def build_engine(settings: Settings) -> Engine:
    if settings.engine == "fake":
        return FakeEngine(settings.language_codes)
    from tamber_api.tts.kokoro_engine import KokoroEngine

    return KokoroEngine(
        repo_id=settings.model_repo,
        languages=settings.language_codes,
        device=settings.device,
        default_voice=settings.default_voice,
    )


def create_app(settings: Settings | None = None, engine: Engine | None = None) -> FastAPI:
    if settings is None:
        settings = Settings()
        warn_unknown_keys()
    configure_logging(settings.log_level)
    engine = engine if engine is not None else build_engine(settings)
    service = TtsService(settings, engine)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        logger.info(
            "Tamber %s starting: engine=%s languages=%s auth=%s cors=%s web=%s",
            __version__,
            engine.name,
            ",".join(settings.language_codes),
            "on" if settings.auth_required else "off",
            "off" if settings.cors_origin_list is None else ",".join(settings.cors_origin_list),
            settings.web_path or "none",
        )
        task = asyncio.create_task(service.load(), name="tamber-engine-load")
        app.state.load_task = task
        try:
            yield
        finally:
            if not task.done():
                task.cancel()

    docs = settings.docs_enabled
    app = FastAPI(
        title="Tamber API",
        version=__version__,
        description=DESCRIPTION,
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if docs else None,
        root_path=settings.root_path,
    )
    app.state.settings = settings
    app.state.service = service
    app.state.engine = engine
    app.state.limiter = SlidingWindowLimiter(settings.rate_limit_per_minute)

    install_exception_handlers(app)
    install_middleware(app, settings)

    app.include_router(health.router)
    app.include_router(voices.router)
    app.include_router(tts.router)
    app.include_router(extract.router)
    app.include_router(openai.speech_router)
    app.include_router(openai.router)
    # Registered last so it never shadows /v1 or /docs.
    static.mount_web(app, settings.web_path)
    return app


app = create_app()
