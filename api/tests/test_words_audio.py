"""Token-to-word mapping (§7.2) and chunk audio shaping (§7.1)."""

from __future__ import annotations

import itertools

import numpy as np
import pytest

from tamber_api import SAMPLE_RATE
from tamber_api.tts.audio import (
    encode_wav,
    shape_chunk_audio,
    trailing_pause_seconds,
    wav_header,
)
from tamber_api.tts.offsets import Utf16Index, spoken_form
from tamber_api.tts.words import TimedToken, estimate_tokens, map_tokens


def _map(text: str, tokens: list[TimedToken], duration: float = 10.0) -> list[dict[str, object]]:
    index = Utf16Index(text)
    spoken = spoken_form(text, 0, len(text))
    return [w.as_dict() for w in map_tokens(tokens, spoken, index, duration)]


def test_curly_quotes_and_apostrophes_match_straight_tokens() -> None:
    text = "She said “don’t   worry” — it’s fine."
    tokens = [
        TimedToken("She", 0.1, 0.3),
        TimedToken("said", 0.3, 0.5),
        TimedToken('"', 0.5, 0.55),  # punctuation-only: skipped
        TimedToken("don't", 0.55, 0.8),
        TimedToken("worry", 0.8, 1.1),
        TimedToken("it's", 1.2, 1.4),
        TimedToken("fine", 1.4, 1.7),
    ]
    words = _map(text, tokens)
    assert [w["text"] for w in words] == ["She", "said", "don’t", "worry", "it’s", "fine"]
    for w in words:
        assert text[int(w["char_start"]) : int(w["char_end"])] == w["text"]  # type: ignore[call-overload]


def test_emoji_before_words_shifts_utf16_offsets() -> None:
    text = "😀 Hello 👍🏽 world"
    words = _map(text, [TimedToken("Hello", 0.0, 0.4), TimedToken("world", 0.5, 0.9)])
    assert [(w["char_start"], w["char_end"]) for w in words] == [(3, 8), (14, 19)]
    js = text.encode("utf-16-le")
    assert js[3 * 2 : 8 * 2].decode("utf-16-le") == "Hello"
    assert js[14 * 2 : 19 * 2].decode("utf-16-le") == "world"


def test_unlocatable_tokens_are_omitted_not_guessed() -> None:
    text = "It costs $5,000 in 1990."
    tokens = [
        TimedToken("It", 0.0, 0.2),
        TimedToken("costs", 0.2, 0.5),
        TimedToken("five thousand dollars", 0.5, 1.2),  # normalised text, not in the source
        TimedToken("in", 1.2, 1.3),
        TimedToken("1990", 1.3, 1.9),
    ]
    assert [w["text"] for w in _map(text, tokens)] == ["It", "costs", "in", "1990"]


def test_times_are_clamped_ordered_and_rounded() -> None:
    text = "one two three"
    tokens = [
        TimedToken("one", -0.2, 0.41234),
        TimedToken("two", 0.3, 0.2),  # overlaps and ends before it starts
        TimedToken("three", 0.9, 5.0),  # beyond the audio
    ]
    words = _map(text, tokens, duration=1.5)
    assert words[0]["start"] == 0.0 and words[0]["end"] == 0.412
    assert words[1]["start"] == 0.412 and words[1]["end"] == 0.412
    assert words[2]["end"] == 1.5
    for a, b in itertools.pairwise(words):
        assert a["end"] <= b["start"]  # type: ignore[operator]


def test_short_token_does_not_match_inside_a_later_word() -> None:
    text = "cat a scatter"
    words = _map(text, [TimedToken("cat", 0, 0.2), TimedToken("a", 0.2, 0.3)])
    assert [(w["text"], w["char_start"]) for w in words] == [("cat", 0), ("a", 4)]


def test_estimate_tokens_cover_the_voiced_span() -> None:
    tokens = estimate_tokens("Hola mundo feliz", 0.03, 1.53)
    assert [t.text for t in tokens] == ["Hola", "mundo", "feliz"]
    assert tokens[0].start == pytest.approx(0.03) and tokens[-1].end == pytest.approx(1.53)


@pytest.mark.parametrize(
    ("text", "paragraph_end", "expected"),
    [
        ("Hello world.", True, 0.6),
        ("Hello world.", False, 0.35),
        ("Hello “world.”", False, 0.35),
        ("Hello world,", False, 0.18),
        ("Hello world —", False, 0.18),
        ("Hello world", False, 0.1),
        ("你好。", False, 0.35),
    ],
)
def test_trailing_pause_by_ending(text: str, paragraph_end: bool, expected: float) -> None:
    assert trailing_pause_seconds(text, paragraph_end, 1.0) == pytest.approx(expected)
    assert trailing_pause_seconds(text, paragraph_end, 2.0) == pytest.approx(expected / 2)


def test_shape_trims_lead_and_sets_tail() -> None:
    lead = np.zeros(int(0.2 * SAMPLE_RATE), dtype=np.float32)
    voice = np.full(int(0.5 * SAMPLE_RATE), 0.3, dtype=np.float32)
    tail = np.zeros(int(1.0 * SAMPLE_RATE), dtype=np.float32)
    shaped = shape_chunk_audio(np.concatenate([lead, voice, tail]), 0.35)
    assert shaped.lead_trim == pytest.approx(0.17)
    assert shaped.speech_start == pytest.approx(0.03)
    assert shaped.speech_end == pytest.approx(0.53)
    assert shaped.duration == pytest.approx(0.03 + 0.5 + 0.35, abs=1e-3)
    assert shaped.samples % (SAMPLE_RATE // 1000) == 0  # whole milliseconds
    # Too little trailing silence is padded with zeros.
    shaped = shape_chunk_audio(voice, 0.6)
    assert shaped.duration == pytest.approx(0.5 + 0.6, abs=1e-3)
    assert shaped.lead_trim == 0.0
    # All-silent audio still yields a valid (silent) file.
    silent = shape_chunk_audio(np.zeros(100, dtype=np.float32), 0.1)
    assert silent.samples == int(0.1 * SAMPLE_RATE)


def test_wav_writer() -> None:
    data = encode_wav(np.array([0.0, 1.0, -1.0, 2.0], dtype=np.float32))
    assert data[:44] == wav_header(4)
    assert np.frombuffer(data[44:], dtype="<i2").tolist() == [0, 32767, -32767, 32767]
