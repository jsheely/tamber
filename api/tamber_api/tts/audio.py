"""Audio post-processing and encoding (docs/API.md §7.1 and §9.1).

* `shape_chunk_audio` concatenates engine segments, trims leading silence to <= 30 ms, sets the
  trailing pause by how the chunk ends, and rounds the length to whole milliseconds so that
  `duration = samples / 24000` is exact at 3 decimals.
* `encode_wav` writes a canonical 44-byte-header PCM s16le file.
* `encode_mp3_file` builds a NEW PyAV container per call and finalizes it, so every chunk is an
  independently decodable file (what iOS `decodeAudioData` needs).
* `ContinuousEncoder` is the opposite: ONE encoder across all chunks of an OpenAI-compatible
  `/v1/audio/speech` response, draining bytes progressively as they are produced.
"""

from __future__ import annotations

import contextlib
import io
import struct
from collections.abc import Sequence
from dataclasses import dataclass

import av
import numpy as np
import numpy.typing as npt

from tamber_api import SAMPLE_RATE
from tamber_api.tts.chunking import CJK_CLAUSE, CJK_TERMINATORS, CLAUSE, CLOSERS, TERMINATORS

AudioArray = npt.NDArray[np.float32]

#: |sample| below this is silence (about -60 dBFS).
SILENCE_THRESHOLD = 1e-3
#: Leading silence kept before the first sound.
MAX_LEADING_SILENCE_S = 0.030
#: Trailing pauses by chunk ending (seconds at speed 1).
PAUSE_PARAGRAPH_S = 0.600
PAUSE_SENTENCE_S = 0.350
PAUSE_CLAUSE_S = 0.180
PAUSE_OTHER_S = 0.100
#: Samples per millisecond; chunk lengths are rounded to whole ms.
_MS = SAMPLE_RATE // 1000


def trailing_pause_seconds(chunk_text: str, paragraph_end: bool, speed: float) -> float:
    """Pause after a chunk: paragraph end / sentence terminator / clause punctuation / other."""
    if paragraph_end:
        base = PAUSE_PARAGRAPH_S
    else:
        stripped = chunk_text.rstrip()
        i = len(stripped) - 1
        while i >= 0 and ord(stripped[i]) in CLOSERS:
            i -= 1
        last = ord(stripped[i]) if i >= 0 else 0
        if last in TERMINATORS or last in CJK_TERMINATORS:
            base = PAUSE_SENTENCE_S
        elif last in CLAUSE or last in CJK_CLAUSE:
            base = PAUSE_CLAUSE_S
        else:
            base = PAUSE_OTHER_S
    return base / speed


@dataclass(slots=True)
class ShapedAudio:
    audio: AudioArray
    #: Seconds removed from the start (word times must be shifted back by this).
    lead_trim: float
    #: Seconds of voiced audio (first to last non-silent sample) after trimming.
    speech_start: float
    speech_end: float

    @property
    def samples(self) -> int:
        return int(self.audio.shape[0])

    @property
    def duration(self) -> float:
        return self.samples / SAMPLE_RATE


def concat_segments(segments: Sequence[AudioArray]) -> tuple[AudioArray, list[float]]:
    """Concatenate segment audio; return it with each segment's start offset in seconds."""
    offsets: list[float] = []
    total = 0
    for seg in segments:
        offsets.append(total / SAMPLE_RATE)
        total += int(seg.shape[0])
    if not segments:
        return np.zeros(0, dtype=np.float32), offsets
    return np.concatenate([s.astype(np.float32, copy=False) for s in segments]), offsets


def shape_chunk_audio(audio: AudioArray, trailing_pause: float) -> ShapedAudio:
    """Trim leading silence to <= 30 ms and set the trailing silence to `trailing_pause`."""
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    target_tail = max(0, round(trailing_pause * SAMPLE_RATE))
    loud = np.flatnonzero(np.abs(audio) >= SILENCE_THRESHOLD)
    if loud.size == 0:
        total = max(target_tail, _MS)
        total = -(-total // _MS) * _MS
        return ShapedAudio(np.zeros(total, dtype=np.float32), 0.0, 0.0, 0.0)
    first = int(loud[0])
    last = int(loud[-1])
    keep_lead = min(first, round(MAX_LEADING_SILENCE_S * SAMPLE_RATE))
    cut = first - keep_lead
    voiced_end = last + 1
    existing_tail = audio.shape[0] - voiced_end
    tail_keep = min(existing_tail, target_tail)
    body = audio[cut : voiced_end + tail_keep]
    pad = target_tail - tail_keep
    # Round the total length up to whole milliseconds (exact 3-decimal durations).
    length = body.shape[0] + pad
    pad += (-length) % _MS
    out = np.concatenate([body, np.zeros(pad, dtype=np.float32)]) if pad else body.copy()
    return ShapedAudio(
        audio=out.astype(np.float32, copy=False),
        lead_trim=cut / SAMPLE_RATE,
        speech_start=keep_lead / SAMPLE_RATE,
        speech_end=(voiced_end - cut) / SAMPLE_RATE,
    )


def to_pcm16(audio: AudioArray) -> npt.NDArray[np.int16]:
    clipped = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
    return np.round(clipped * 32767.0).astype("<i2")


def wav_header(num_samples: int, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Canonical 44-byte RIFF/WAVE header for PCM s16le mono."""
    data_size = num_samples * 2
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        1,  # mono
        sample_rate,
        sample_rate * 2,  # byte rate
        2,  # block align
        16,  # bits per sample
        b"data",
        data_size,
    )


def encode_wav(audio: AudioArray) -> bytes:
    pcm = to_pcm16(audio)
    return wav_header(int(pcm.shape[0])) + pcm.tobytes()


def _mono_frame(pcm: npt.NDArray[np.int16], pts: int) -> av.AudioFrame:
    frame = av.AudioFrame.from_ndarray(pcm.reshape(1, -1), format="s16", layout="mono")
    frame.sample_rate = SAMPLE_RATE
    frame.pts = pts
    return frame


def encode_mp3_file(audio: AudioArray) -> bytes:
    """One complete MP3 file (CBR 128 kbps, 24 kHz mono, no ID3) in a fresh container."""
    buf = io.BytesIO()
    container = av.open(
        buf,
        mode="w",
        format="mp3",
        container_options={"id3v2_version": "0", "write_id3v1": "0"},
    )
    try:
        stream = container.add_stream("libmp3lame", rate=SAMPLE_RATE, layout="mono")
        stream.bit_rate = 128_000
        pcm = to_pcm16(audio)
        if pcm.shape[0]:
            for packet in stream.encode(_mono_frame(pcm, 0)):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    finally:
        container.close()
    return buf.getvalue()


def encode_flac_file(audio: AudioArray) -> bytes:
    buf = io.BytesIO()
    container = av.open(buf, mode="w", format="flac")
    try:
        stream = container.add_stream("flac", rate=SAMPLE_RATE, layout="mono")
        pcm = to_pcm16(audio)
        if pcm.shape[0]:
            for packet in stream.encode(_mono_frame(pcm, 0)):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    finally:
        container.close()
    return buf.getvalue()


def encode_chunk(audio: AudioArray, fmt: str) -> bytes:
    """Encode one chunk as a complete, independently decodable file."""
    if fmt == "wav":
        return encode_wav(audio)
    if fmt == "mp3":
        return encode_mp3_file(audio)
    raise ValueError(f"Unsupported chunk format {fmt!r}")


# --- continuous encoders (/v1/audio/speech) ------------------------------------------------------


class _Sink:
    """Write-only, non-seekable file object: muxers must stream and never seek back."""

    def __init__(self) -> None:
        self._parts: list[bytes] = []

    def write(self, data: bytes) -> int:
        self._parts.append(bytes(data))
        return len(data)

    def flush(self) -> None:
        return None

    def drain(self) -> bytes:
        out = b"".join(self._parts)
        self._parts.clear()
        return out


#: format -> (container format, codec, bit rate)
_CONTINUOUS: dict[str, tuple[str, str, int | None]] = {
    "mp3": ("mp3", "libmp3lame", 128_000),
    "opus": ("ogg", "libopus", 64_000),
    "aac": ("adts", "aac", 128_000),
}


class ContinuousEncoder:
    """One encoder for a whole response; `write()` returns the bytes ready so far."""

    def __init__(self, fmt: str) -> None:
        self.format = fmt
        self._pts = 0
        self._closed = False
        self._sink: _Sink | None = None
        self._container: av.container.OutputContainer | None = None
        self._stream: av.audio.stream.AudioStream | None = None
        if fmt == "pcm":
            return
        if fmt not in _CONTINUOUS:
            raise ValueError(f"Unsupported streaming format {fmt!r}")
        container_format, codec, bit_rate = _CONTINUOUS[fmt]
        self._sink = _Sink()
        options = {"id3v2_version": "0", "write_id3v1": "0"} if fmt == "mp3" else {}
        self._container = av.open(
            self._sink, mode="w", format=container_format, container_options=options
        )
        stream = self._container.add_stream(codec, rate=SAMPLE_RATE, layout="mono")
        if bit_rate:
            stream.bit_rate = bit_rate
        self._stream = stream

    def write(self, audio: AudioArray) -> bytes:
        pcm = to_pcm16(audio)
        if self.format == "pcm":
            return pcm.tobytes()
        assert self._container is not None and self._stream is not None and self._sink is not None
        if pcm.shape[0]:
            for packet in self._stream.encode(_mono_frame(pcm, self._pts)):
                self._container.mux(packet)
            self._pts += int(pcm.shape[0])
        return self._sink.drain()

    def finish(self) -> bytes:
        if self.format == "pcm" or self._closed:
            return b""
        assert self._container is not None and self._stream is not None and self._sink is not None
        self._closed = True
        for packet in self._stream.encode(None):
            self._container.mux(packet)
        self._container.close()
        return self._sink.drain()

    def close(self) -> None:
        if self._container is not None and not self._closed:
            self._closed = True
            with contextlib.suppress(Exception):
                self._container.close()


def encode_complete(audio: AudioArray, fmt: str) -> bytes:
    """A whole response as one file (wav/flac, and any continuous format)."""
    if fmt == "wav":
        return encode_wav(audio)
    if fmt == "flac":
        return encode_flac_file(audio)
    enc = ContinuousEncoder(fmt)
    return enc.write(audio) + enc.finish()
