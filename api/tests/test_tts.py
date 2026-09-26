"""POST /v1/tts: NDJSON grammar, word/offset invariants, audio files, resume, queueing, cancel."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import struct
import threading
from collections.abc import Callable
from typing import Any

import av
import httpx
import pytest

from tamber_api.tts.engine import FakeEngine

from .conftest import (
    FlakyEngine,
    GatedEngine,
    make_app,
    parse_ndjson,
    ready_client,
    running,
    wait_until,
)

TEXT = (
    "Hello world. This is Tamber, a “self-hosted” reader. It’s fast!\n\n"
    "Second paragraph 😀 with an emoji. And one more sentence here."
)


def _js_len(text: str) -> int:
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _js_slice(text: str, start: int, end: int) -> str:
    raw = text.encode("utf-16-le", "surrogatepass")[start * 2 : end * 2]
    return raw.decode("utf-16-le", "surrogatepass")


def parse_wav(data: bytes) -> tuple[int, int, int, int]:
    """(channels, rate, bits, samples) after validating the canonical 44-byte header."""
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    riff_size = struct.unpack_from("<I", data, 4)[0]
    assert riff_size == len(data) - 8
    assert data[12:16] == b"fmt " and struct.unpack_from("<I", data, 16)[0] == 16
    fmt_tag, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", data, 20)
    assert fmt_tag == 1 and byte_rate == rate * channels * bits // 8 and align == 2
    assert data[36:40] == b"data"
    data_size = struct.unpack_from("<I", data, 40)[0]
    assert data_size == len(data) - 44 and data_size != 0xFFFFFFFF
    return channels, rate, bits, data_size // 2


def decode_samples(data: bytes) -> int:
    container = av.open(io.BytesIO(data))
    try:
        return sum(frame.samples for frame in container.decode(audio=0))
    finally:
        container.close()


def check_stream(text: str, events: list[dict[str, Any]], start_chunk: int = 0) -> None:
    """Grammar and every invariant of docs/API.md §8.4.2 / §7.2."""
    start = events[0]
    assert start["type"] == "start"
    assert events[-1]["type"] == "done"
    assert all(e["type"] != "start" for e in events[1:])
    assert start["text_length"] == _js_len(text)
    assert start["start_chunk"] == start_chunk
    plan = start["chunks"]
    assert [c["index"] for c in plan] == list(range(start["total_chunks"]))
    chunks = [e for e in events if e["type"] == "chunk"]
    assert [c["index"] for c in chunks] == list(range(start_chunk, start["total_chunks"]))
    total = 0.0
    for c in chunks:
        span = plan[c["index"]]
        assert (c["char_start"], c["char_end"]) == (span["char_start"], span["char_end"])
        assert c["text"] == _js_slice(text, c["char_start"], c["char_end"])
        assert c["sample_rate"] == 24000
        assert c["format"] == start["format"]
        total += c["duration"]
        prev_end = 0.0
        prev_char = c["char_start"]
        assert c["words"], "fake engine always yields words"
        for w in c["words"]:
            assert w["text"] == _js_slice(text, w["char_start"], w["char_end"])
            assert c["char_start"] <= w["char_start"] < w["char_end"] <= c["char_end"]
            assert w["char_start"] >= prev_char
            assert 0 <= w["start"] <= w["end"] <= c["duration"]
            assert w["start"] >= prev_end
            assert round(w["start"], 3) == w["start"] and round(w["end"], 3) == w["end"]
            assert w["text"] == w["text"].strip() and w["text"]
            prev_end = w["end"]
            prev_char = w["char_end"]
    done = events[-1]
    assert done["chunks_sent"] == len(chunks)
    assert done["chunks_failed"] == 0
    assert done["total_duration"] == pytest.approx(total, abs=1e-6)


def test_stream_grammar_offsets_words_and_wav() -> None:
    with ready_client() as client:
        r = client.post("/v1/tts", json={"text": TEXT, "voice": "af_bella(2)+af_sky(1)"})
        assert r.status_code == 200
        assert r.headers["content-type"] == "application/x-ndjson; charset=utf-8"
        assert r.headers["cache-control"] == "no-store"
        assert r.headers["x-accel-buffering"] == "no"
        assert "content-encoding" not in r.headers
        events = parse_ndjson(r.text)
    check_stream(TEXT, events)
    start = events[0]
    assert start["request_id"] == r.headers["x-request-id"]
    assert start["voice"] == "af_bella(2)+af_sky(1)"
    assert start["lang"] == "a" and start["word_timestamps"] is True
    assert start["format"] == "wav"
    # The first chunk is the first sentence alone (balanced mode).
    assert events[1]["text"] == "Hello world."
    for c in (e for e in events if e["type"] == "chunk"):
        data = base64.b64decode(c["audio"], validate=True)
        channels, rate, bits, samples = parse_wav(data)
        assert (channels, rate, bits) == (1, 24000, 16)
        assert c["duration"] == samples / 24000
        assert decode_samples(data) == samples
    # "It’s" (curly apostrophe) and the emoji paragraph map back exactly.
    words = [w["text"] for e in events if e["type"] == "chunk" for w in e["words"]]
    assert "It’s" in words and "emoji" in words and "self-hosted" in words


def test_each_line_is_compact_json() -> None:
    with ready_client() as client:
        r = client.post("/v1/tts", json={"text": "Hi there. Bye now."})
    lines = r.text.split("\n")
    assert lines[-1] == ""
    for line in lines[:-1]:
        assert line == json.dumps(json.loads(line), separators=(",", ":"), ensure_ascii=False)


def test_mp3_chunks_decode_independently() -> None:
    with ready_client() as client:
        r = client.post("/v1/tts", json={"text": TEXT, "format": "mp3", "chunk_mode": "sentence"})
    events = parse_ndjson(r.text)
    check_stream(TEXT, events)
    chunks = [e for e in events if e["type"] == "chunk"]
    assert len(chunks) >= 4
    for c in chunks:
        data = base64.b64decode(c["audio"])
        assert not data.startswith(b"ID3")
        samples = decode_samples(data)  # each chunk on its own
        assert samples > 0
        assert abs(samples / 24000 - c["duration"]) < 0.1


def test_start_chunk_skips_earlier_chunks_and_keeps_indices() -> None:
    engine = FakeEngine()
    with ready_client(engine) as client:
        r = client.post("/v1/tts", json={"text": TEXT, "chunk_mode": "sentence", "start_chunk": 3})
        events = parse_ndjson(r.text)
        check_stream(TEXT, events, start_chunk=3)
        total = events[0]["total_chunks"]
        assert engine.calls == total - 3
        assert events[1]["index"] == 3
        bad = client.post("/v1/tts", json={"text": TEXT, "start_chunk": total + 5})
        assert bad.status_code == 400
        assert bad.json()["error"]["code"] == "invalid_request"
        assert bad.json()["error"]["param"] == "start_chunk"


def test_non_streaming_result_shape() -> None:
    with ready_client() as client:
        r = client.post("/v1/tts", json={"text": TEXT, "stream": False, "speed": 1.5})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    body = r.json()
    for key in (
        "request_id",
        "sample_rate",
        "format",
        "voice",
        "lang",
        "speed",
        "chunk_mode",
        "total_chunks",
        "start_chunk",
        "word_timestamps",
        "text_length",
        "plan",
        "chunks",
        "errors",
        "total_duration",
        "elapsed_ms",
    ):
        assert key in body
    assert body["speed"] == 1.5
    assert len(body["chunks"]) == body["total_chunks"] == len(body["plan"])
    assert body["errors"] == []
    assert all(c["type"] == "chunk" for c in body["chunks"])
    start = {**body, "type": "start", "chunks": body["plan"]}
    check_stream(TEXT, [start, *body["chunks"], {"type": "done", **_done(body)}])


def _done(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "total_duration": body["total_duration"],
        "chunks_sent": len(body["chunks"]),
        "chunks_failed": 0,
        "elapsed_ms": body["elapsed_ms"],
    }


def test_speed_shortens_audio_and_pauses() -> None:
    with ready_client() as client:
        slow = parse_ndjson(client.post("/v1/tts", json={"text": "One two three."}).text)
        fast = parse_ndjson(
            client.post("/v1/tts", json={"text": "One two three.", "speed": 2.0}).text
        )
    assert fast[1]["duration"] < slow[1]["duration"] * 0.6


def test_non_fatal_chunk_error_then_done() -> None:
    engine = FlakyEngine(("Broken",))
    text = "Fine one. Broken two. Fine three."
    with ready_client(engine) as client:
        r = client.post("/v1/tts", json={"text": text, "chunk_mode": "sentence"})
    events = parse_ndjson(r.text)
    kinds = [e["type"] for e in events]
    assert kinds == ["start", "chunk", "error", "chunk", "done"]
    err = events[2]
    assert err == {
        "type": "error",
        "code": "synthesis_failed",
        "message": "Chunk 1 could not be synthesized.",
        "index": 1,
        "fatal": False,
    }
    assert events[-1]["chunks_sent"] == 2 and events[-1]["chunks_failed"] == 1


def test_three_consecutive_failures_are_fatal() -> None:
    engine = FlakyEngine(("Bad",))
    text = "Good. Bad one. Bad two. Bad three. Good again."
    with ready_client(engine) as client:
        r = client.post("/v1/tts", json={"text": text, "chunk_mode": "sentence"})
        events = parse_ndjson(r.text)
        assert [e["type"] for e in events] == ["start", "chunk", "error", "error", "error"]
        assert events[-1]["fatal"] is True and events[-1]["index"] == 3
        assert all(e["fatal"] is False for e in events[2:4])
        # stream=false: a fatal failure is an HTTP 500.
        r2 = client.post("/v1/tts", json={"text": text, "chunk_mode": "sentence", "stream": False})
        assert r2.status_code == 500
        assert r2.json()["error"]["code"] == "synthesis_failed"
        # stream=false with a non-fatal failure lists it in `errors`.
        r3 = client.post(
            "/v1/tts",
            json={"text": "Good. Bad x. Good.", "chunk_mode": "sentence", "stream": False},
        )
        assert r3.status_code == 200 and len(r3.json()["errors"]) == 1


def test_validation_errors_before_streaming() -> None:
    with ready_client(max_text_chars=50) as client:
        cases: list[tuple[dict[str, Any], int, str, str | None]] = [
            ({"text": "x" * 51}, 413, "text_too_long", "text"),
            ({"text": "  ***  "}, 400, "empty_text", "text"),
            ({"text": ""}, 400, "invalid_request", "text"),
            ({"text": "Hi.", "voice": "af_nope"}, 400, "unknown_voice", "voice"),
            ({"text": "Hi.", "voice": "af_heart+"}, 400, "unknown_voice", "voice"),
            ({"text": "Hi.", "voice": "ef_dora"}, 400, "unknown_voice", "voice"),
            ({"text": "Hi.", "lang": "fr"}, 400, "unsupported_language", "lang"),
            ({"text": "Hi.", "lang": "klingon"}, 400, "unsupported_language", "lang"),
            ({"text": "Hi.", "format": "ogg"}, 400, "unsupported_format", "format"),
            ({"text": "Hi.", "speed": 9}, 400, "invalid_request", "speed"),
            ({"text": "Hi.", "chunk_mode": "word"}, 400, "invalid_request", "chunk_mode"),
            ({"voice": "af_heart"}, 400, "invalid_request", "text"),
        ]
        for body, status, code, param in cases:
            r = client.post("/v1/tts", json=body)
            assert r.status_code == status, (body, r.text)
            err = r.json()["error"]
            assert err["code"] == code, (body, err)
            assert err["param"] == param, (body, err)
            assert err["request_id"] == r.headers["x-request-id"]
        too_long = client.post("/v1/tts", json={"text": "😀" * 26}).json()["error"]
        assert too_long["details"] == {"max": 50, "actual": 52}


def test_lang_alias_and_british_voice() -> None:
    with ready_client() as client:
        r = client.post("/v1/tts", json={"text": "Colour me happy.", "voice": "bf_emma"})
        assert parse_ndjson(r.text)[0]["lang"] == "b"
        r = client.post(
            "/v1/tts", json={"text": "Colour me happy.", "voice": "bf_emma", "lang": "en-US"}
        )
        assert parse_ndjson(r.text)[0]["lang"] == "a"


def test_unknown_fields_are_ignored() -> None:
    with ready_client() as client:
        r = client.post("/v1/tts", json={"text": "Hi there.", "future_field": {"x": 1}})
        assert r.status_code == 200


def test_ping_while_a_chunk_is_slow() -> None:
    engine = FakeEngine(synth_delay=0.25)
    app = make_app(engine)
    app.state.service.ping_interval = 0.05
    from fastapi.testclient import TestClient

    from .conftest import wait_ready

    with TestClient(app) as client:
        wait_ready(client)
        events = parse_ndjson(client.post("/v1/tts", json={"text": "Slow chunk."}).text)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "start" and kinds[-1] == "done"
    assert "ping" in kinds
    assert {"type": "ping"} in events


async def test_model_loading_then_ready() -> None:
    class SlowLoad(FakeEngine):
        def __init__(self) -> None:
            super().__init__()
            import threading

            self.release = threading.Event()

        def load(self) -> None:
            self.release.wait(5)
            super().load()

    engine = SlowLoad()
    app = make_app(engine)
    transport = httpx.ASGITransport(app=app)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://t") as client,
    ):
        health = (await client.get("/v1/health")).json()
        assert health["status"] == "loading" and health["model_loaded"] is False
        r = await client.post("/v1/tts", json={"text": "Hi."})
        assert r.status_code == 503
        assert r.headers["retry-after"] == "5"
        assert r.json()["error"]["code"] == "model_loading"
        assert r.json()["error"]["type"] == "server_error"
        engine.release.set()
        await asyncio.wait_for(app.state.service.wait_ready(), 5)
        health = (await client.get("/v1/health")).json()
        assert health["status"] == "ok" and health["model_loaded"] is True
        assert (await client.post("/v1/tts", json={"text": "Hi."})).status_code == 200


async def test_queue_full_returns_503_and_queued_events() -> None:
    engine = GatedEngine()
    app = make_app(engine, max_concurrent_synth=1, max_queue=1)
    app.state.service.queued_interval = 0.05
    transport = httpx.ASGITransport(app=app)
    async with (
        running(app),
        httpx.AsyncClient(transport=transport, base_url="http://t", timeout=10) as client,
    ):
        first = asyncio.create_task(client.post("/v1/tts", json={"text": "First job."}))
        await wait_until(engine.entered.is_set)
        second = asyncio.create_task(client.post("/v1/tts", json={"text": "Second job."}))
        await wait_until(lambda: app.state.service.slots.waiting == 1)
        third = await client.post("/v1/tts", json={"text": "Third job."})
        assert third.status_code == 503
        assert third.json()["error"]["code"] == "server_busy"
        assert "retry-after" in third.headers
        await asyncio.sleep(0.15)
        engine.gate.set()
        r1, r2 = await asyncio.gather(first, second)
        assert r1.status_code == r2.status_code == 200
        events2 = parse_ndjson(r2.text)
        assert events2[0]["type"] == "start"
        queued = [e for e in events2 if e["type"] == "queued"]
        assert queued and all(e["position"] == 1 for e in queued)
        assert events2[-1]["type"] == "done"
        slots = app.state.service.slots
        assert slots.active == 0 and slots.waiting == 0


@pytest.mark.parametrize("spec_version", ["2.4", "2.3"])
async def test_client_disconnect_stops_synthesis(spec_version: str) -> None:
    engine = FakeEngine(synth_delay=0.03)
    app = make_app(engine)
    text = " ".join(f"Sentence number {i}." for i in range(30))
    body = json.dumps({"text": text, "chunk_mode": "sentence"}).encode()
    async with running(app):
        disconnected = asyncio.Event()
        pending = [{"type": "http.request", "body": body, "more_body": False}]
        seen_chunks = 0

        async def receive() -> dict[str, Any]:
            if pending:
                return pending.pop(0)
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            nonlocal seen_chunks
            if message["type"] == "http.response.body":
                seen_chunks += message.get("body", b"").count(b'"type":"chunk"')
                if seen_chunks >= 2:
                    disconnected.set()

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": spec_version},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/v1/tts",
            "raw_path": b"/v1/tts",
            "root_path": "",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json"), (b"host", b"t")],
            "client": ("127.0.0.1", 5000),
            "server": ("t", 80),
            "state": {},
        }
        await asyncio.wait_for(app(scope, receive, send), 10)
        assert seen_chunks >= 2
        assert engine.calls < 10, f"synthesis kept going after disconnect ({engine.calls})"
        slots = app.state.service.slots
        await wait_until(lambda: slots.active == 0 and slots.waiting == 0)


class NoTokensEngine(FakeEngine):
    """Returns audio without tokens (like a pipeline that produced no timings)."""

    def synthesize(self, text: str, voice: Any, lang: str, speed: float) -> list[Any]:
        segments = super().synthesize(text, voice, lang, speed)
        for seg in segments:
            seg.tokens = None
        return segments


class EnglishOnlyTimings(FakeEngine):
    def word_timestamps(self, lang: str) -> bool:
        return lang in ("a", "b")


def test_missing_tokens_fall_back_to_flagged_estimates() -> None:
    text = "Estimated words here. And here too."
    with ready_client(NoTokensEngine()) as client:
        events = parse_ndjson(client.post("/v1/tts", json={"text": text}).text)
    check_stream(text, events)
    chunks = [e for e in events if e["type"] == "chunk"]
    assert all(c["words_estimated"] is True for c in chunks)
    assert [w["text"] for w in chunks[0]["words"]] == ["Estimated", "words", "here"]


def test_language_without_word_timings_sends_empty_words() -> None:
    with ready_client(EnglishOnlyTimings(("a", "e")), languages="a,e") as client:
        r = client.post("/v1/tts", json={"text": "Hola amigo. Buenos días.", "voice": "ef_dora"})
        events = parse_ndjson(r.text)
        assert events[0]["word_timestamps"] is False and events[0]["lang"] == "e"
        chunks = [e for e in events if e["type"] == "chunk"]
        assert chunks and all(c["words"] == [] and "words_estimated" not in c for c in chunks)
        health = client.get("/v1/health").json()
        assert {lang["code"]: lang["word_timestamps"] for lang in health["languages"]} == {
            "a": True,
            "e": False,
        }
        dora = next(v for v in client.get("/v1/voices").json()["voices"] if v["id"] == "ef_dora")
        assert dora["word_timestamps"] is False


def test_default_voice_falls_back_when_its_language_is_disabled() -> None:
    with ready_client(languages="b") as client:
        health = client.get("/v1/health").json()
        assert health["default_voice"] == "bf_emma"
        r = client.post("/v1/tts", json={"text": "Hello there."})
        start = parse_ndjson(r.text)[0]
        assert start["voice"] == "bf_emma" and start["lang"] == "b"


def test_line_separators_are_escaped_so_every_event_is_one_line() -> None:
    # U+2028 / U+2029 / U+0085 are legal raw inside JSON strings, but many line splitters
    # (including str.splitlines, used by parse_ndjson) break lines on them.
    text = "Line separator here. Next\u0085line and words. Another paragraph here."
    with ready_client() as client:
        r = client.post("/v1/tts", json={"text": text})
    assert r.status_code == 200
    for ch in (" ", " ", "\u0085"):
        assert ch.encode() not in r.content
    events = parse_ndjson(r.text)
    check_stream(text, events)
    assert " " in events[1]["text"]


class CountingEngine(FakeEngine):
    """Calls `on_reached` (from the worker thread) once `after` chunks have been synthesized."""

    def __init__(self, after: int, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.after = after
        self.on_reached: Callable[[], object] = lambda: None
        self._fired = False

    def synthesize(self, text: str, voice: Any, lang: str, speed: float) -> list[Any]:
        segments = super().synthesize(text, voice, lang, speed)
        if self.calls >= self.after and not self._fired:
            self._fired = True
            self.on_reached()
        return segments


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/v1/tts", {"stream": False, "chunk_mode": "sentence"}),
        ("/v1/audio/speech", {"response_format": "wav", "voice": "af_heart"}),
        ("/v1/audio/speech", {"response_format": "flac", "voice": "af_heart"}),
    ],
)
async def test_disconnect_stops_whole_body_synthesis(path: str, payload: dict[str, Any]) -> None:
    """stream=false and complete-file speech formats must not keep the slot busy for a client
    that already went away."""
    engine = CountingEngine(after=2, synth_delay=0.01)
    app = make_app(engine)
    # Long enough for 20+ chunks even when /v1/audio/speech packs sentences (balanced mode).
    text = " ".join(f"This is sentence number {i} of a long article." for i in range(120))
    key = "text" if path == "/v1/tts" else "input"
    body = json.dumps({key: text, **payload}).encode()
    async with running(app):
        loop = asyncio.get_running_loop()
        disconnected = asyncio.Event()
        engine.on_reached = lambda: loop.call_soon_threadsafe(disconnected.set)
        pending = [{"type": "http.request", "body": body, "more_body": False}]

        async def receive() -> dict[str, Any]:
            if pending:
                return pending.pop(0)
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            return None

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": path,
            "raw_path": path.encode(),
            "root_path": "",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json"), (b"host", b"t")],
            "client": ("127.0.0.1", 5000),
            "server": ("t", 80),
            "state": {},
        }
        await asyncio.wait_for(app(scope, receive, send), 10)
        assert engine.calls <= 4, f"synthesis kept going after disconnect ({engine.calls})"
        slots = app.state.service.slots
        await wait_until(lambda: slots.active == 0 and slots.waiting == 0)


def test_kokoro_g2p_wrapper_serializes_calls_and_passes_attributes() -> None:
    """misaki's G2P is not thread-safe (concurrent calls return each other's words), so the
    Kokoro engine wraps every pipeline's G2P in a lock."""
    import time
    from concurrent.futures import ThreadPoolExecutor

    from tamber_api.tts.kokoro_engine import _SerializedG2P

    class RacyG2P:
        lexicon = "the-lexicon"

        def __init__(self) -> None:
            self.inside = 0
            self.max_inside = 0

        def __call__(self, text: str) -> tuple[str, list[str]]:
            self.inside += 1
            self.max_inside = max(self.max_inside, self.inside)
            time.sleep(0.005)
            self.inside -= 1
            return text.upper(), [text]

    racy = RacyG2P()
    wrapped = _SerializedG2P(racy, threading.Lock())
    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(wrapped, [f"t{i}" for i in range(40)]))
    assert racy.max_inside == 1
    assert results == [(f"T{i}", [f"t{i}"]) for i in range(40)]
    assert wrapped.lexicon == "the-lexicon"
