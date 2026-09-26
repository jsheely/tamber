"""The real engine: hexgrad `kokoro` (PyTorch) with word timings from `KPipeline` tokens.

torch and kokoro are imported lazily in `load()`, so `TAMBER_ENGINE=fake` never needs them.
One `KModel` is shared by one `KPipeline` per enabled language. Voice packs come from the HF
cache (`pipeline.load_single_voice`); blends are weighted sums of packs, cached in an LRU.
"""

from __future__ import annotations

import logging
import os
import threading
import time
import warnings
from typing import Any

import numpy as np

from tamber_api.tts.engine import Segment
from tamber_api.tts.voices import (
    LANGUAGE_BY_CODE,
    LRUCache,
    ResolvedVoice,
    catalog_ids,
    lang_of_voice,
)
from tamber_api.tts.words import TimedToken, has_speakable

logger = logging.getLogger("tamber.engine")

_OFFLINE_VALUES = {"1", "true", "yes", "on"}


class _SerializedG2P:
    """Wraps a KPipeline's G2P so only one thread phonemizes at a time.

    misaki's G2P (spaCy + lexicon + the espeak-ng fallback) is not thread-safe: two threads
    phonemizing through one instance get each other's words back. That matters as soon as
    TAMBER_MAX_CONCURRENT_SYNTH > 1. G2P takes milliseconds, so model inference, which is
    thread-safe and is the expensive part, still runs in parallel.
    """

    def __init__(self, g2p: Any, lock: threading.Lock) -> None:
        self._g2p = g2p
        self._lock = lock

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._g2p(*args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._g2p, name)


class KokoroEngine:
    name = "kokoro"

    def __init__(
        self,
        repo_id: str,
        languages: tuple[str, ...],
        device: str = "auto",
        default_voice: str = "af_heart",
    ) -> None:
        self.model = repo_id
        self.repo_id = repo_id
        self.requested_device = device
        self.device = "cpu" if device == "auto" else device
        self.default_voice = default_voice
        self._languages = languages
        self._loaded_languages: tuple[str, ...] = ()
        self._kmodel: Any = None
        self._pipelines: dict[str, Any] = {}
        self._torch: Any = None
        self._blends: LRUCache[str, Any] = LRUCache(32)
        self._voice_lock = threading.Lock()
        #: One lock for every pipeline's G2P (see _SerializedG2P).
        self._g2p_lock = threading.Lock()
        self._available: set[str] | None = None
        self._available_at = 0.0

    # --- lifecycle -------------------------------------------------------------------------

    def _resolve_device(self, torch: Any) -> str:
        if self.requested_device != "auto":
            return self.requested_device
        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
        return "cpu"

    def load(self) -> None:
        with warnings.catch_warnings():
            # Known, harmless deprecation noise from Kokoro's torch modules.
            warnings.filterwarnings("ignore", category=FutureWarning, module=r"torch\..*")
            warnings.filterwarnings("ignore", category=UserWarning, module=r"torch\..*")
            self._load()

    def _load(self) -> None:
        import torch
        from kokoro import KModel, KPipeline

        self._torch = torch
        device = self._resolve_device(torch)
        started = time.perf_counter()
        logger.info("Loading Kokoro model %s on %s", self.repo_id, device)
        kmodel = KModel(repo_id=self.repo_id).to(device).eval()
        self._kmodel = kmodel
        self.device = device
        loaded: list[str] = []
        for code in self._languages:
            try:
                pipeline = KPipeline(lang_code=code, repo_id=self.repo_id, model=kmodel)
                pipeline.g2p = _SerializedG2P(pipeline.g2p, self._g2p_lock)
                self._pipelines[code] = pipeline
                loaded.append(code)
            except Exception:
                logger.exception(
                    "Language %r (%s) could not be initialised and is disabled",
                    code,
                    LANGUAGE_BY_CODE[code].name,
                )
        if not loaded:
            raise RuntimeError("No Kokoro language pipeline could be initialised")
        self._loaded_languages = tuple(loaded)
        logger.info(
            "Kokoro ready in %.1fs (languages: %s)",
            time.perf_counter() - started,
            ",".join(loaded),
        )

    def warmup(self) -> None:
        lang = self._loaded_languages[0]
        voice_id = self.default_voice
        if lang_of_voice(voice_id) != lang or voice_id not in self.available_voice_ids():
            candidates = [v for v in catalog_ids((lang,)) if v in self.available_voice_ids()]
            if not candidates:
                logger.warning("Warm-up skipped: no voice available for language %r", lang)
                return
            voice_id = candidates[0]
        voice = ResolvedVoice(spec=voice_id, components=((voice_id, 1.0),), lang=lang)
        started = time.perf_counter()
        self.synthesize("Hello! Tamber is warming up.", voice, lang, 1.0)
        logger.info("Warm-up synthesis took %.2fs", time.perf_counter() - started)

    # --- capabilities ----------------------------------------------------------------------

    def loaded_languages(self) -> tuple[str, ...]:
        return self._loaded_languages or self._languages

    def word_timestamps(self, lang: str) -> bool:
        # KPipeline only attaches timed tokens for English (misaki G2P).
        return lang in ("a", "b")

    def available_voice_ids(self) -> set[str]:
        """Catalog voices of enabled languages; offline, only those whose .pt is cached."""
        now = time.monotonic()
        if self._available is not None and now - self._available_at < 60:
            return self._available
        ids = set(catalog_ids(self.loaded_languages()))
        offline = os.environ.get("HF_HUB_OFFLINE", "").strip().lower() in _OFFLINE_VALUES
        if offline:
            try:
                from huggingface_hub import try_to_load_from_cache

                ids = {
                    v
                    for v in ids
                    if isinstance(try_to_load_from_cache(self.repo_id, f"voices/{v}.pt"), str)
                }
            except Exception:
                logger.exception("Could not inspect the Hugging Face cache for voices")
        self._available = ids
        self._available_at = now
        return ids

    # --- synthesis -------------------------------------------------------------------------

    def _pipeline_for(self, lang: str) -> Any:
        pipeline = self._pipelines.get(lang)
        if pipeline is None:
            raise RuntimeError(f"Language {lang!r} is not loaded")
        return pipeline

    def _voice_pack(self, voice_id: str) -> Any:
        lang = lang_of_voice(voice_id)
        pipeline = self._pipelines.get(lang) or next(iter(self._pipelines.values()))
        with self._voice_lock:
            return pipeline.load_single_voice(voice_id)

    def voice_tensor(self, voice: ResolvedVoice) -> Any:
        """The style tensor for a voice or blend: sum(w_i * pack_i), weights summing to 1."""

        def build() -> Any:
            if len(voice.components) == 1:
                return self._voice_pack(voice.components[0][0])
            total: Any = None
            for voice_id, weight in voice.components:
                pack = self._voice_pack(voice_id).float() * float(weight)
                total = pack if total is None else total + pack
            return total

        if len(voice.components) == 1:
            return build()
        return self._blends.get_or_create(voice.spec, build)

    def synthesize(self, text: str, voice: ResolvedVoice, lang: str, speed: float) -> list[Segment]:
        torch = self._torch
        if torch is None or self._kmodel is None:
            raise RuntimeError("Kokoro engine is not loaded")
        pipeline = self._pipeline_for(lang)
        tensor = self.voice_tensor(voice)
        timed = self.word_timestamps(lang)
        segments: list[Segment] = []
        with torch.inference_mode():
            for result in pipeline(text, voice=tensor, speed=speed, split_pattern=None):
                audio_t = result.audio
                if audio_t is None:
                    continue
                if hasattr(audio_t, "detach"):
                    audio_np = audio_t.detach().to("cpu").float().numpy()
                else:
                    audio_np = np.asarray(audio_t, dtype=np.float32)
                audio = np.ascontiguousarray(audio_np.reshape(-1), dtype=np.float32)
                tokens: list[TimedToken] | None = None
                if timed and result.tokens is not None:
                    tokens = []
                    for tok in result.tokens:
                        start = getattr(tok, "start_ts", None)
                        end = getattr(tok, "end_ts", None)
                        tok_text = str(getattr(tok, "text", "") or "")
                        if start is None or end is None:
                            continue
                        if not getattr(tok, "phonemes", None):
                            continue
                        if not has_speakable(tok_text):
                            continue
                        tokens.append(TimedToken(tok_text, float(start), float(end)))
                segments.append(Segment(audio=audio, tokens=tokens))
        return segments
