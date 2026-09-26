"""Shared fixtures: a fake-engine app, a ready TestClient, and ASGI helpers."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tamber_api.config import Settings
from tamber_api.main import create_app
from tamber_api.tts.engine import FakeEngine, Segment
from tamber_api.tts.voices import ResolvedVoice

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = REPO_ROOT / "packages" / "client" / "fixtures" / "chunking.json"

#: Defaults every test app starts from (independent of the developer's environment/.env).
BASE_SETTINGS: dict[str, Any] = {
    "engine": "fake",
    "api_key": "",
    "cors_origins": "*",
    "languages": "a,b",
    "default_voice": "af_heart",
    "default_format": "wav",
    "warmup": True,
    "web_dir": "",
    "rate_limit_per_minute": 0,
    "max_concurrent_synth": 1,
    "max_queue": 16,
    "chunk_target_chars": 280,
    "chunk_max_chars": 400,
    "max_text_chars": 100_000,
    "max_upload_mb": 25,
    "max_extract_chars": 500_000,
    "max_blend_voices": 4,
    "extract_allow_private": False,
    "docs_enabled": True,
    "root_path": "",
}


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("TAMBER_TEST_MODEL") == "1":
        return
    skip = pytest.mark.skip(reason="needs the real Kokoro model (set TAMBER_TEST_MODEL=1)")
    for item in items:
        if "model" in item.keywords:
            item.add_marker(skip)


def make_settings(**overrides: Any) -> Settings:
    values = {**BASE_SETTINGS, **overrides}
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


def make_app(engine: FakeEngine | None = None, **overrides: Any) -> FastAPI:
    settings = make_settings(**overrides)
    return create_app(settings=settings, engine=engine or FakeEngine(settings.language_codes))


def wait_ready(client: TestClient, timeout: float = 5.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        health: dict[str, Any] = client.get("/v1/health").json()
        if health["status"] != "loading" or time.monotonic() > deadline:
            return health
        time.sleep(0.01)


@contextmanager
def ready_client(
    engine: FakeEngine | None = None, *, headers: dict[str, str] | None = None, **overrides: Any
) -> Iterator[TestClient]:
    app = make_app(engine, **overrides)
    with TestClient(app, headers=headers or {}) as client:
        wait_ready(client)
        yield client


@pytest.fixture
def client() -> Iterator[TestClient]:
    with ready_client() as c:
        yield c


@asynccontextmanager
async def running(app: FastAPI) -> AsyncIterator[FastAPI]:
    """Run the app's lifespan in the current loop and wait for the engine."""
    async with app.router.lifespan_context(app):
        await asyncio.wait_for(app.state.service.wait_ready(), 5)
        yield app


def parse_ndjson(body: str) -> list[dict[str, Any]]:
    assert body.endswith("\n"), "every NDJSON line ends with a newline"
    return [json.loads(line) for line in body.splitlines()]


class GatedEngine(FakeEngine):
    """A fake engine that blocks inside synthesize() until `gate` is set."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.gate = threading.Event()
        self.entered = threading.Event()

    def synthesize(self, text: str, voice: ResolvedVoice, lang: str, speed: float) -> list[Segment]:
        self.entered.set()
        self.gate.wait(10)
        return super().synthesize(text, voice, lang, speed)


class FlakyEngine(FakeEngine):
    """Fails for chunks whose text contains any of `fail_words`."""

    def __init__(self, fail_words: tuple[str, ...], *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.fail_words = fail_words

    def synthesize(self, text: str, voice: ResolvedVoice, lang: str, speed: float) -> list[Segment]:
        segments = super().synthesize(text, voice, lang, speed)
        if any(w in text for w in self.fail_words):
            raise RuntimeError("synthetic failure")
        return segments


async def wait_until(predicate: Any, limit_s: float = 5.0) -> None:
    deadline = time.monotonic() + limit_s
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached in time")
        await asyncio.sleep(0.01)
