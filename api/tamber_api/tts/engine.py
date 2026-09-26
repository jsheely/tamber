"""Engine protocol and the model-free FakeEngine (docs/API.md §8.4.7).

An engine turns one chunk of spoken text into one or more audio segments (float32 mono 24 kHz),
each with optional word tokens timed relative to that segment. Engines are blocking; the service
calls them from a worker thread (`asyncio.to_thread`).
"""

from __future__ import annotations

import math
import re
import threading
import time
import zlib
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np
import numpy.typing as npt

from tamber_api import SAMPLE_RATE
from tamber_api.tts.voices import ResolvedVoice, catalog_ids
from tamber_api.tts.words import TimedToken

AudioArray = npt.NDArray[np.float32]


@dataclass(slots=True)
class Segment:
    """One engine output: audio plus tokens timed relative to the start of this segment."""

    audio: AudioArray
    tokens: list[TimedToken] | None


@runtime_checkable
class Engine(Protocol):
    #: "kokoro" or "fake".
    name: str
    #: Model identifier reported by /v1/health.
    model: str
    #: Device reported by /v1/health ("cpu", "cuda", "mps").
    device: str

    def load(self) -> None:
        """Load weights (blocking). Called once from the lifespan background task."""

    def warmup(self) -> None:
        """Run one short synthesis so the first real request is fast (blocking)."""

    def loaded_languages(self) -> tuple[str, ...]:
        """Language codes this engine can speak right now (after load)."""
        ...

    def available_voice_ids(self) -> set[str]:
        """Voice ids usable right now (enabled languages only)."""
        ...

    def word_timestamps(self, lang: str) -> bool:
        """Whether chunks in `lang` carry word timings."""
        ...

    def synthesize(self, text: str, voice: ResolvedVoice, lang: str, speed: float) -> list[Segment]:
        """Synthesize `text` (already in spoken form). Blocking."""
        ...


class FakeEngine:
    """Model-free engine: a soft tone per word with evenly spaced word timings.

    Everything downstream (chunk plan, offsets, trimming, WAV/MP3 encoding, NDJSON, errors,
    cancellation) behaves exactly as with the real model, so clients can develop against it.
    """

    name = "fake"
    model = "fake"
    device = "cpu"

    WORD_SECONDS = 0.33
    GAP_SECONDS = 0.05
    AMPLITUDE = 0.2
    FADE_SECONDS = 0.01
    _WORD_RE = re.compile(r"[\w'’-]+")

    def __init__(
        self,
        languages: tuple[str, ...] = ("a", "b"),
        *,
        load_delay: float = 0.0,
        synth_delay: float = 0.0,
    ) -> None:
        self._languages = languages
        self.load_delay = load_delay
        self.synth_delay = synth_delay
        #: Number of synthesize() calls (tests assert cancellation with it).
        self.calls = 0
        self._lock = threading.Lock()
        self.loaded = False

    def load(self) -> None:
        if self.load_delay:
            time.sleep(self.load_delay)
        self.loaded = True

    def warmup(self) -> None:
        return None

    def loaded_languages(self) -> tuple[str, ...]:
        return self._languages

    def available_voice_ids(self) -> set[str]:
        return set(catalog_ids(self._languages))

    def word_timestamps(self, lang: str) -> bool:
        return True

    def synthesize(self, text: str, voice: ResolvedVoice, lang: str, speed: float) -> list[Segment]:
        with self._lock:
            self.calls += 1
        if self.synth_delay:
            time.sleep(self.synth_delay)
        words = self._WORD_RE.findall(text)
        word_len = self.WORD_SECONDS / speed
        gap_len = self.GAP_SECONDS / speed
        n_word = max(1, round(word_len * SAMPLE_RATE))
        n_gap = max(0, round(gap_len * SAMPLE_RATE))
        fade = min(n_word // 2, round(self.FADE_SECONDS * SAMPLE_RATE))
        envelope = np.ones(n_word, dtype=np.float32)
        if fade > 0:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
            envelope[:fade] = ramp
            envelope[-fade:] = ramp[::-1]
        t = np.arange(n_word, dtype=np.float32) / SAMPLE_RATE
        # A voice-dependent base pitch so blends/voices are audibly different.
        base = 220.0 + (zlib.crc32(voice.spec.encode()) % 110)
        pieces: list[AudioArray] = []
        tokens: list[TimedToken] = []
        cursor = 0
        for i, word in enumerate(words or ["_"]):
            freq = base + ((zlib.crc32(word.encode()) + i * 37) % 110)
            freq = min(440.0, max(220.0, freq))
            tone = (self.AMPLITUDE * envelope * np.sin(2 * math.pi * freq * t)).astype(np.float32)
            start = cursor / SAMPLE_RATE
            pieces.append(tone)
            cursor += n_word
            if words:
                tokens.append(TimedToken(word, start, cursor / SAMPLE_RATE))
            pieces.append(np.zeros(n_gap, dtype=np.float32))
            cursor += n_gap
        audio = np.concatenate(pieces).astype(np.float32, copy=False)
        return [Segment(audio=audio, tokens=tokens if words else None)]
