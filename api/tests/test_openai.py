"""OpenAI-compatible endpoints."""

from __future__ import annotations

import io

import av
import pytest
from fastapi.testclient import TestClient

from .conftest import ready_client

TEXT = "Drop-in replacement. It streams progressively, chunk by chunk."


def decoded_seconds(data: bytes) -> float:
    container = av.open(io.BytesIO(data))
    try:
        stream = container.streams.audio[0]
        samples = sum(f.samples for f in container.decode(audio=0))
        return float(samples / stream.rate)
    finally:
        container.close()


@pytest.mark.parametrize(
    ("fmt", "media_type", "ext"),
    [
        ("mp3", "audio/mpeg", "mp3"),
        ("opus", "audio/ogg", "opus"),
        ("aac", "audio/aac", "aac"),
        ("flac", "audio/flac", "flac"),
        ("wav", "audio/wav", "wav"),
    ],
)
def test_speech_formats(client: TestClient, fmt: str, media_type: str, ext: str) -> None:
    r = client.post(
        "/v1/audio/speech",
        json={"model": "tts-1", "input": TEXT, "voice": "alloy", "response_format": fmt},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == media_type
    assert r.headers["content-disposition"] == f'inline; filename="speech.{ext}"'
    if fmt in ("wav", "flac"):
        assert int(r.headers["content-length"]) == len(r.content)
    seconds = decoded_seconds(r.content)
    assert seconds > 2.0  # both chunks are in ONE continuous file


def test_speech_pcm_is_raw_s16le(client: TestClient) -> None:
    r = client.post("/v1/audio/speech", json={"input": "One two.", "response_format": "pcm"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/pcm"
    assert len(r.content) % 2 == 0 and not r.content.startswith(b"RIFF")
    wav = client.post("/v1/audio/speech", json={"input": "One two.", "response_format": "wav"})
    assert wav.content[44:] == r.content


def test_speech_defaults_to_mp3_and_ignores_extra_fields(client: TestClient) -> None:
    r = client.post(
        "/v1/audio/speech",
        json={
            "input": "Hello.",
            "voice": "af_bella(2)+af_sky(1)",
            "instructions": "Speak warmly",
            "stream_format": "audio",
            "speed": 1.25,
        },
    )
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg"


def test_speech_errors(client: TestClient) -> None:
    bad = client.post("/v1/audio/speech", json={"input": "Hi.", "response_format": "m4a"})
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "unsupported_format"
    assert bad.json()["error"]["param"] == "response_format"
    voice = client.post("/v1/audio/speech", json={"input": "Hi.", "voice": "nobody"})
    assert voice.status_code == 400 and voice.json()["error"]["code"] == "unknown_voice"
    empty = client.post("/v1/audio/speech", json={"input": "..."})
    assert empty.status_code == 400 and empty.json()["error"]["param"] == "input"


def test_openai_voice_falls_back_to_default_when_language_disabled() -> None:
    with ready_client(languages="a") as client:
        # "fable" maps to bm_fable (British), which is not enabled -> default voice.
        r = client.post("/v1/audio/speech", json={"input": "Hi.", "voice": "fable"})
        assert r.status_code == 200


def test_models(client: TestClient) -> None:
    body = client.get("/v1/models").json()
    assert body["object"] == "list"
    assert [m["id"] for m in body["data"]] == ["kokoro", "tts-1", "tts-1-hd", "gpt-4o-mini-tts"]
    assert body["data"][0] == {
        "id": "kokoro",
        "object": "model",
        "created": 1735689600,
        "owned_by": "tamber",
    }
    assert client.get("/v1/models/tts-1").json()["id"] == "tts-1"
    missing = client.get("/v1/models/whisper-1")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"


async def test_progressive_speech_never_closes_the_encoder_during_a_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A disconnect while a chunk is being encoded in a worker thread must not close the
    (native PyAV) encoder under that thread; the close waits for the write to finish."""
    import asyncio
    import time
    from typing import Any

    from tamber_api.routes import openai as openai_routes

    from .conftest import make_app, running, wait_until

    log: list[str] = []

    class SlowEncoder:
        def __init__(self, fmt: str) -> None:
            self.format = fmt

        def write(self, audio: Any) -> bytes:
            log.append("write-start")
            time.sleep(0.2)
            log.append("write-end")
            return b"x"

        def finish(self) -> bytes:
            return b""

        def close(self) -> None:
            log.append("close")

    async def connected() -> bool:
        return False

    monkeypatch.setattr(openai_routes, "ContinuousEncoder", SlowEncoder)
    app = make_app()
    async with running(app):
        service = app.state.service
        job = service.prepare(
            request_id="t",
            text="One. Two. Three.",
            voice=None,
            speed=1.0,
            fmt="mp3",
            lang=None,
            chunk_mode="sentence",
            start_chunk=0,
        )
        ticket = service.admit()
        gen = openai_routes._progressive(service, job, ticket, "mp3", connected)
        task = asyncio.ensure_future(gen.__anext__())
        await wait_until(lambda: "write-start" in log)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await wait_until(lambda: "close" in log)
        assert log == ["write-start", "write-end", "close"]
        slots = service.slots
        await wait_until(lambda: slots.active == 0 and slots.waiting == 0)
