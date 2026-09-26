"""Synthesis service: validation/planning, the job queue, the per-chunk pipeline and NDJSON events.

docs/API.md §8.4. A request is fully validated and planned (`prepare`) and admitted to the queue
(`admit`) before any response byte is sent. The stream then emits `start`, waits for a synthesis
slot (emitting `queued`), and for each chunk synthesizes in a worker thread, shapes and encodes the
audio, maps word timings to offsets, and emits one `chunk` line.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import time
from collections import deque
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np

from tamber_api import SAMPLE_RATE
from tamber_api.config import Settings
from tamber_api.errors import TamberError
from tamber_api.tts.audio import (
    AudioArray,
    concat_segments,
    encode_chunk,
    shape_chunk_audio,
    trailing_pause_seconds,
)
from tamber_api.tts.chunking import ChunkSpan, plan_chunks
from tamber_api.tts.engine import Engine
from tamber_api.tts.offsets import Utf16Index, spoken_form
from tamber_api.tts.voices import (
    LANGUAGE_BY_CODE,
    ResolvedVoice,
    VoiceSpecError,
    resolve_lang,
    resolve_voice,
    sort_voice_ids,
)
from tamber_api.tts.words import TimedToken, WordTiming, estimate_tokens, map_tokens

logger = logging.getLogger("tamber.tts")

Status = Literal["loading", "ok", "degraded", "failed"]

#: Consecutive chunk failures after which a stream gives up with a fatal error.
MAX_CONSECUTIVE_FAILURES = 3
QUEUED_INTERVAL_S = 2.0
PING_INTERVAL_S = 15.0

IsDisconnected = Callable[[], Awaitable[bool]]

#: Characters that JSON allows raw inside strings but that many line splitters (Python's
#: `str.splitlines`, some NDJSON readers) treat as line breaks. They can only occur inside JSON
#: strings, so escaping them keeps the output valid JSON and every event on exactly one line.
_LINE_BREAK_ESCAPES = {0x85: "\\u0085", 0x2028: "\\u2028", 0x2029: "\\u2029"}


def ndjson_line(obj: dict[str, Any]) -> bytes:
    line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    return (line.translate(_LINE_BREAK_ESCAPES) + "\n").encode("utf-8")


@dataclass(slots=True)
class Job:
    request_id: str
    text: str
    index: Utf16Index
    plan: list[ChunkSpan]
    voice: ResolvedVoice
    lang: str
    speed: float
    format: str
    chunk_mode: str
    start_chunk: int
    word_timestamps: bool
    text_length: int
    started_at: float = field(default_factory=time.perf_counter)

    def start_event(self) -> dict[str, Any]:
        return {
            "type": "start",
            "request_id": self.request_id,
            "sample_rate": SAMPLE_RATE,
            "format": self.format,
            "voice": self.voice.spec,
            "lang": self.lang,
            "speed": self.speed,
            "chunk_mode": self.chunk_mode,
            "total_chunks": len(self.plan),
            "start_chunk": self.start_chunk,
            "word_timestamps": self.word_timestamps,
            "text_length": self.text_length,
            "chunks": [c.as_dict() for c in self.plan],
        }


@dataclass(slots=True)
class RenderedChunk:
    """A synthesized, shaped chunk (before encoding)."""

    chunk: ChunkSpan
    audio: AudioArray
    words: list[WordTiming]
    words_estimated: bool

    @property
    def duration(self) -> float:
        return round(int(self.audio.shape[0]) / SAMPLE_RATE, 3)


class Ticket:
    """A reserved place in the synthesis queue."""

    __slots__ = ("active", "released", "started")

    def __init__(self) -> None:
        self.active = False
        self.released = False
        #: Set once a consumer started running the job (it then owns the release).
        self.started = False


class SlotManager:
    """At most `slots` jobs synthesize at once; at most `max_queue` wait (FIFO)."""

    def __init__(self, slots: int, max_queue: int) -> None:
        self.slots = slots
        self.max_queue = max_queue
        self._sem = asyncio.Semaphore(slots)
        self._waiting: deque[Ticket] = deque()
        self.active = 0

    @property
    def waiting(self) -> int:
        return len(self._waiting)

    def admit(self) -> Ticket:
        """Reserve a place before the response starts; 503 server_busy when the queue is full."""
        if self.active + len(self._waiting) >= self.slots + self.max_queue:
            raise TamberError(
                503,
                "server_busy",
                "The synthesis queue is full. Try again shortly.",
                headers={"Retry-After": "5"},
            )
        ticket = Ticket()
        self._waiting.append(ticket)
        return ticket

    def position(self, ticket: Ticket) -> int:
        try:
            return self._waiting.index(ticket) + 1
        except ValueError:
            return 0

    def slot_free(self) -> bool:
        return not self._sem.locked()

    async def acquire(self, ticket: Ticket) -> None:
        try:
            await self._sem.acquire()
        except BaseException:
            self._drop(ticket)
            raise
        self._drop(ticket)
        ticket.active = True
        self.active += 1

    def _drop(self, ticket: Ticket) -> None:
        with contextlib.suppress(ValueError):
            self._waiting.remove(ticket)

    def release(self, ticket: Ticket) -> None:
        if ticket.released:
            return
        ticket.released = True
        if ticket.active:
            ticket.active = False
            self.active -= 1
            self._sem.release()
        else:
            self._drop(ticket)


class TtsService:
    def __init__(self, settings: Settings, engine: Engine) -> None:
        self.settings = settings
        self.engine = engine
        self.slots = SlotManager(settings.max_concurrent_synth, settings.max_queue)
        self.status: Status = "loading"
        self.model_loaded = False
        self.load_error: str | None = None
        self.ping_interval = PING_INTERVAL_S
        self.queued_interval = QUEUED_INTERVAL_S
        self._ready = asyncio.Event()

    # --- lifecycle -------------------------------------------------------------------------

    async def load(self) -> None:
        """Load the engine, then warm up. Runs as a background task from the lifespan."""
        started = time.perf_counter()
        try:
            await asyncio.to_thread(self.engine.load)
            self.model_loaded = True
        except Exception as exc:
            logger.exception("Engine %s failed to load", self.engine.name)
            self.status = "failed"
            self.load_error = type(exc).__name__
            self._ready.set()
            return
        if self.settings.warmup:
            try:
                await asyncio.to_thread(self.engine.warmup)
            except Exception:
                logger.exception("Warm-up failed; the server stays up in degraded mode")
                self.status = "degraded"
                self._ready.set()
                return
        self.status = "ok"
        logger.info(
            "Engine %s ready (model=%s device=%s) in %.1fs",
            self.engine.name,
            self.engine.model,
            self.engine.device,
            time.perf_counter() - started,
        )
        self._ready.set()

    async def wait_ready(self) -> None:
        await self._ready.wait()

    @property
    def health_status(self) -> str:
        return "degraded" if self.status == "failed" else self.status

    # --- capabilities ----------------------------------------------------------------------

    def languages(self) -> list[str]:
        enabled = self.settings.language_codes
        if self.model_loaded:
            loaded = set(self.engine.loaded_languages())
            return [c for c in enabled if c in loaded]
        return list(enabled)

    def word_timestamps(self, lang: str) -> bool:
        return self.engine.word_timestamps(lang)

    def language_infos(self) -> list[dict[str, Any]]:
        out = []
        for code in self.languages():
            lang = LANGUAGE_BY_CODE[code]
            out.append(
                {
                    "code": lang.code,
                    "tag": lang.tag,
                    "name": lang.name,
                    "word_timestamps": self.word_timestamps(code),
                }
            )
        return out

    def available_voices(self) -> frozenset[str]:
        enabled = set(self.languages())
        return frozenset(v for v in self.engine.available_voice_ids() if v[:1] in enabled)

    def default_voice(self) -> str:
        """TAMBER_DEFAULT_VOICE, or the best voice of the first enabled language when the
        configured one isn't available (e.g. its language is disabled)."""
        configured = self.settings.default_voice
        available = self.available_voices()
        if configured in available or not available:
            return configured
        for code in self.languages():
            candidates = sort_voice_ids(v for v in available if v[:1] == code)
            if candidates:
                return candidates[0]
        return configured

    # --- validation ------------------------------------------------------------------------

    def ensure_ready(self) -> None:
        if self.status == "loading":
            raise TamberError(
                503,
                "model_loading",
                "The TTS model is still loading. Try again in a few seconds.",
                headers={"Retry-After": "5"},
            )
        if self.status == "failed":
            raise TamberError(
                500,
                "internal_error",
                "The TTS engine failed to load. The details are in the server log.",
            )

    def check_text_length(self, text: str, param: str) -> int:
        length = len(text.encode("utf-16-le", "surrogatepass")) // 2
        if length > self.settings.max_text_chars:
            raise TamberError(
                413,
                "text_too_long",
                f"The text is {length} characters long; this server accepts at most "
                f"{self.settings.max_text_chars}.",
                param=param,
                details={"max": self.settings.max_text_chars, "actual": length},
            )
        return length

    def resolve_voice(self, spec: str) -> ResolvedVoice:
        try:
            return resolve_voice(spec, self.settings.max_blend_voices, self.available_voices())
        except VoiceSpecError as exc:
            raise TamberError(400, "unknown_voice", str(exc), param="voice") from exc

    def resolve_language(self, lang: str | None, voice: ResolvedVoice) -> str:
        enabled = self.languages()
        if lang is not None and lang.strip():
            code = resolve_lang(lang)
            if code is None or code not in enabled:
                raise TamberError(
                    400,
                    "unsupported_language",
                    f"Language '{lang}' is not enabled on this server "
                    f"(enabled: {', '.join(enabled)}).",
                    param="lang",
                )
            return code
        if voice.lang not in enabled:
            raise TamberError(
                400,
                "unsupported_language",
                f"The voice's language '{voice.lang}' is not enabled on this server.",
                param="voice",
            )
        return voice.lang

    def prepare(
        self,
        *,
        request_id: str,
        text: str,
        voice: str | None,
        speed: float,
        fmt: str,
        lang: str | None,
        chunk_mode: str,
        start_chunk: int,
        text_param: str = "text",
    ) -> Job:
        """Validate everything and build the chunk plan. Raises TamberError."""
        length = self.check_text_length(text, text_param)
        resolved = self.resolve_voice(voice if voice is not None else self.default_voice())
        code = self.resolve_language(lang, resolved)
        plan = plan_chunks(text, chunk_mode, self.settings.chunk_target, self.settings.chunk_max)
        if not plan:
            raise TamberError(
                400,
                "empty_text",
                "The text has nothing to speak (no letters or digits).",
                param=text_param,
            )
        if not 0 <= start_chunk < len(plan):
            raise TamberError(
                400,
                "invalid_request",
                f"start_chunk must be between 0 and {len(plan) - 1} for this text.",
                param="start_chunk",
                details=[
                    {
                        "loc": ["body", "start_chunk"],
                        "msg": f"must be < total_chunks ({len(plan)})",
                        "type": "value_error",
                    }
                ],
            )
        return Job(
            request_id=request_id,
            text=text,
            index=Utf16Index(text),
            plan=plan,
            voice=resolved,
            lang=code,
            speed=speed,
            format=fmt,
            chunk_mode=chunk_mode,
            start_chunk=start_chunk,
            word_timestamps=self.word_timestamps(code),
            text_length=length,
        )

    def admit(self) -> Ticket:
        return self.slots.admit()

    # --- per-chunk pipeline (blocking; runs in a worker thread) -------------------------

    def render_chunk(self, job: Job, chunk: ChunkSpan) -> RenderedChunk:
        cp_start = job.index.to_cp(chunk.char_start)
        cp_end = job.index.to_cp(chunk.char_end)
        spoken = spoken_form(job.text, cp_start, cp_end)
        segments = self.engine.synthesize(spoken.text, job.voice, job.lang, job.speed)
        if not segments:
            raise RuntimeError("engine returned no audio")
        audio, offsets = concat_segments([s.audio for s in segments])
        pause = trailing_pause_seconds(spoken.text, chunk.paragraph_end, job.speed)
        shaped = shape_chunk_audio(audio, pause)
        duration = round(shaped.samples / SAMPLE_RATE, 3)
        words: list[WordTiming] = []
        estimated = False
        if job.word_timestamps:
            any_tokens = any(s.tokens for s in segments)
            tokens: list[TimedToken] = []
            if any_tokens:
                for seg, offset in zip(segments, offsets, strict=True):
                    for tok in seg.tokens or ():
                        tokens.append(
                            TimedToken(
                                tok.text,
                                tok.start + offset - shaped.lead_trim,
                                tok.end + offset - shaped.lead_trim,
                            )
                        )
            else:
                tokens = estimate_tokens(spoken.text, shaped.speech_start, shaped.speech_end)
                estimated = bool(tokens)
            words = map_tokens(tokens, spoken, job.index, duration)
        return RenderedChunk(
            chunk=chunk, audio=shaped.audio, words=words, words_estimated=estimated
        )

    def chunk_event(self, job: Job, rendered: RenderedChunk) -> dict[str, Any]:
        chunk = rendered.chunk
        data = encode_chunk(rendered.audio, job.format)
        event: dict[str, Any] = {
            "type": "chunk",
            "index": chunk.index,
            "text": job.index.slice_utf16(chunk.char_start, chunk.char_end),
            "char_start": chunk.char_start,
            "char_end": chunk.char_end,
            "audio": base64.b64encode(data).decode("ascii"),
            "format": job.format,
            "sample_rate": SAMPLE_RATE,
            "duration": rendered.duration,
            "words": [w.as_dict() for w in rendered.words],
        }
        if rendered.words_estimated:
            event["words_estimated"] = True
        return event

    def build_chunk_event(self, job: Job, chunk: ChunkSpan) -> dict[str, Any]:
        return self.chunk_event(job, self.render_chunk(job, chunk))

    # --- streaming ---------------------------------------------------------------------------

    async def _wait_for_slot(
        self, ticket: Ticket, is_disconnected: IsDisconnected | None
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Acquire a slot, yielding `queued` events (at most every 2 s) while waiting."""
        if self.slots.slot_free() and self.slots.position(ticket) == 1:
            await self.slots.acquire(ticket)
            return
        acquire = asyncio.ensure_future(self.slots.acquire(ticket))
        try:
            while not acquire.done():
                yield {"type": "queued", "position": max(1, self.slots.position(ticket))}
                done, _ = await asyncio.wait({acquire}, timeout=self.queued_interval)
                if not done and is_disconnected is not None and await is_disconnected():
                    return
            acquire.result()
        finally:
            if not acquire.done():
                acquire.cancel()
                try:
                    await acquire
                except asyncio.CancelledError:
                    pass
                except Exception:
                    logger.exception("slot acquisition failed")
            if acquire.done() and not acquire.cancelled() and acquire.exception() is None:
                ticket.active = True

    async def events(
        self,
        job: Job,
        ticket: Ticket,
        is_disconnected: IsDisconnected | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """The NDJSON event sequence for one job (start ... done|fatal error)."""
        sent = failed = consecutive = 0
        total_duration = 0.0
        pending: asyncio.Future[dict[str, Any]] | None = None
        cancelled = False
        ticket.started = True
        try:
            yield job.start_event()
            waiter = self._wait_for_slot(ticket, is_disconnected)
            try:
                async for queued in waiter:
                    yield queued
            finally:
                await waiter.aclose()
            if not ticket.active:
                cancelled = True
                return
            last_output = time.monotonic()
            for chunk in job.plan[job.start_chunk :]:
                if is_disconnected is not None and await is_disconnected():
                    cancelled = True
                    return
                pending = asyncio.ensure_future(
                    asyncio.to_thread(self.build_chunk_event, job, chunk)
                )
                while True:
                    remaining = self.ping_interval - (time.monotonic() - last_output)
                    done, _ = await asyncio.wait({pending}, timeout=max(0.0, remaining))
                    if done:
                        break
                    yield {"type": "ping"}
                    last_output = time.monotonic()
                future, pending = pending, None
                try:
                    event = future.result()
                except Exception as exc:
                    failed += 1
                    consecutive += 1
                    logger.warning(
                        "request_id=%s chunk=%d synthesis failed: %s",
                        job.request_id,
                        chunk.index,
                        type(exc).__name__,
                        exc_info=logger.isEnabledFor(logging.DEBUG),
                    )
                    if consecutive >= MAX_CONSECUTIVE_FAILURES:
                        yield {
                            "type": "error",
                            "code": "synthesis_failed",
                            "message": f"{consecutive} chunks in a row could not be "
                            "synthesized; giving up.",
                            "index": chunk.index,
                            "fatal": True,
                        }
                        return
                    yield {
                        "type": "error",
                        "code": "synthesis_failed",
                        "message": f"Chunk {chunk.index} could not be synthesized.",
                        "index": chunk.index,
                        "fatal": False,
                    }
                    last_output = time.monotonic()
                    continue
                consecutive = 0
                sent += 1
                total_duration += float(event["duration"])
                yield event
                last_output = time.monotonic()
            elapsed_ms = round((time.perf_counter() - job.started_at) * 1000)
            logger.info(
                "request_id=%s tts done chars=%d chunks=%d sent=%d failed=%d voice=%s lang=%s "
                "format=%s audio_s=%.2f elapsed_ms=%d",
                job.request_id,
                job.text_length,
                len(job.plan),
                sent,
                failed,
                job.voice.spec,
                job.lang,
                job.format,
                total_duration,
                elapsed_ms,
            )
            yield {
                "type": "done",
                "total_duration": round(total_duration, 3),
                "chunks_sent": sent,
                "chunks_failed": failed,
                "elapsed_ms": elapsed_ms,
            }
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if cancelled:
                logger.info(
                    "request_id=%s tts cancelled by client after %d chunks", job.request_id, sent
                )
            self._release_after(ticket, pending)

    def release_unstarted(self, ticket: Ticket) -> None:
        """Free a reservation whose job never started (e.g. the first send failed)."""
        if not ticket.started:
            self.slots.release(ticket)

    def _release_after(self, ticket: Ticket, pending: asyncio.Future[Any] | None) -> None:
        """Free the slot, but only once any in-flight worker thread has finished."""
        if pending is None or pending.done():
            self.slots.release(ticket)
            return

        def _on_done(future: asyncio.Future[Any]) -> None:
            if not future.cancelled():
                future.exception()  # mark retrieved; the failure was already irrelevant
            self.slots.release(ticket)

        pending.add_done_callback(_on_done)

    async def stream(
        self, job: Job, ticket: Ticket, is_disconnected: IsDisconnected | None = None
    ) -> AsyncGenerator[bytes, None]:
        events = self.events(job, ticket, is_disconnected)
        try:
            async for event in events:
                yield ndjson_line(event)
        finally:
            await events.aclose()

    async def collect(
        self, job: Job, ticket: Ticket, is_disconnected: IsDisconnected | None = None
    ) -> dict[str, Any]:
        """stream=false: gather the same events into one TtsResult body.

        With `is_disconnected`, a client that gives up stops the job (and frees the slot) instead
        of the server synthesizing the whole text for nobody.
        """
        chunks: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        done: dict[str, Any] | None = None
        events = self.events(job, ticket, is_disconnected)
        try:
            async for event in events:
                kind = event["type"]
                if kind == "chunk":
                    chunks.append(event)
                elif kind == "error":
                    if event.get("fatal"):
                        raise TamberError(500, "synthesis_failed", str(event["message"]))
                    errors.append(event)
                elif kind == "done":
                    done = event
        finally:
            await events.aclose()
        if done is None:
            if is_disconnected is not None and await is_disconnected():
                message = "Synthesis stopped because the client disconnected."
            else:
                message = "Synthesis did not complete."
            raise TamberError(500, "synthesis_failed", message)
        start = job.start_event()
        return {
            "request_id": job.request_id,
            "sample_rate": SAMPLE_RATE,
            "format": job.format,
            "voice": job.voice.spec,
            "lang": job.lang,
            "speed": job.speed,
            "chunk_mode": job.chunk_mode,
            "total_chunks": start["total_chunks"],
            "start_chunk": job.start_chunk,
            "word_timestamps": job.word_timestamps,
            "text_length": job.text_length,
            "plan": start["chunks"],
            "chunks": chunks,
            "errors": errors,
            "total_duration": done["total_duration"],
            "elapsed_ms": done["elapsed_ms"],
        }

    # --- whole-file synthesis (previews, /v1/audio/speech) --------------------------------

    async def rendered_chunks(
        self,
        job: Job,
        ticket: Ticket,
        is_disconnected: IsDisconnected | None = None,
    ) -> AsyncGenerator[RenderedChunk, None]:
        """Shaped audio per chunk (no words needed), holding a slot. Failed chunks are skipped;
        3 consecutive failures raise TamberError(synthesis_failed)."""
        pending: asyncio.Future[RenderedChunk] | None = None
        ticket.started = True
        try:
            await self.slots.acquire(ticket)
            consecutive = 0
            produced = 0
            for chunk in job.plan[job.start_chunk :]:
                if is_disconnected is not None and await is_disconnected():
                    return
                pending = asyncio.ensure_future(asyncio.to_thread(self.render_chunk, job, chunk))
                future = pending
                try:
                    rendered = await asyncio.shield(future)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    pending = None
                    consecutive += 1
                    logger.warning(
                        "request_id=%s chunk=%d synthesis failed: %s",
                        job.request_id,
                        chunk.index,
                        type(exc).__name__,
                    )
                    if consecutive >= MAX_CONSECUTIVE_FAILURES:
                        raise TamberError(
                            500, "synthesis_failed", "Speech synthesis failed."
                        ) from exc
                    continue
                pending = None
                consecutive = 0
                produced += 1
                yield rendered
            if produced == 0:
                raise TamberError(500, "synthesis_failed", "Speech synthesis failed.")
        finally:
            self._release_after(ticket, pending)

    async def render_full(
        self, job: Job, ticket: Ticket, is_disconnected: IsDisconnected | None = None
    ) -> AudioArray:
        chunks = self.rendered_chunks(job, ticket, is_disconnected)
        try:
            parts = [r.audio async for r in chunks]
        finally:
            await chunks.aclose()
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts).astype(np.float32, copy=False)
