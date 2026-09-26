"""Map engine tokens (text + seconds) to word timings with offsets into the original text (§7.2).

Each timed token is located in the chunk's spoken text by a forward scan from a cursor, treating
curly and straight quotes/apostrophes as equal. Its spoken span is mapped back to original
code-point indices and then to UTF-16 offsets. Tokens that can't be located are omitted, never
guessed. Times are clamped to [0, duration], forced into order without overlap, and rounded to ms.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

from tamber_api.tts.offsets import SpokenText, Utf16Index

#: Folding applied to both the spoken text and token text before matching (length-preserving).
_FOLD = str.maketrans({"‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"'})

#: How far past the cursor a token may start (spoken characters). Bounds the damage when an
#: earlier token could not be located, and stops a short token matching far ahead.
_SEARCH_WINDOW = 80

_WORD_RE = re.compile(r"[\w'’-]+")


@dataclass(frozen=True, slots=True)
class TimedToken:
    """One engine token: its text and times in seconds relative to the chunk audio."""

    text: str
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class WordTiming:
    text: str
    start: float
    end: float
    char_start: int
    char_end: int

    def as_dict(self) -> dict[str, object]:
        return {
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "char_start": self.char_start,
            "char_end": self.char_end,
        }


def fold(text: str) -> str:
    return text.translate(_FOLD)


def has_speakable(text: str) -> bool:
    """True when `text` holds a letter or digit (Unicode L* / N*)."""
    return any(unicodedata.category(ch)[0] in ("L", "N") for ch in text)


def _is_word_char(ch: str) -> bool:
    return ch.isalnum()


def _locate(haystack: str, needle: str, cursor: int) -> int:
    """First match of `needle` at or after `cursor` within the search window, preferring a match
    that starts on a word boundary. Returns -1 when not found."""
    limit = cursor + _SEARCH_WINDOW + len(needle)
    window_end = min(len(haystack), limit)
    first_any = -1
    pos = haystack.find(needle, cursor, window_end)
    while pos >= 0:
        if first_any < 0:
            first_any = pos
        boundary = pos == 0 or not _is_word_char(needle[0]) or not _is_word_char(haystack[pos - 1])
        if boundary:
            return pos
        pos = haystack.find(needle, pos + 1, window_end)
    return first_any


def map_tokens(
    tokens: Sequence[TimedToken],
    spoken: SpokenText,
    index: Utf16Index,
    duration: float,
) -> list[WordTiming]:
    """Locate tokens in the chunk and build ordered, non-overlapping word timings."""
    haystack = fold(spoken.text)
    original = index.text
    words: list[WordTiming] = []
    cursor = 0
    prev_end = 0.0
    for tok in tokens:
        needle = fold(tok.text.strip())
        if not needle or not has_speakable(needle):
            continue
        pos = _locate(haystack, needle, cursor)
        if pos < 0:
            continue
        last = pos + len(needle) - 1
        cp_start = spoken.index_map[pos]
        cp_end = spoken.index_map[last] + 1
        cursor = pos + len(needle)
        start = min(max(tok.start, 0.0), duration)
        end = min(max(tok.end, start), duration)
        start = round(max(start, prev_end), 3)
        end = round(max(end, start), 3)
        if end > duration:
            end = round(duration, 3)
            start = min(start, end)
        prev_end = end
        words.append(
            WordTiming(
                text=original[cp_start:cp_end],
                start=start,
                end=end,
                char_start=index.to_utf16(cp_start),
                char_end=index.to_utf16(cp_end),
            )
        )
    return words


def estimate_tokens(spoken_text: str, speech_start: float, speech_end: float) -> list[TimedToken]:
    """Proportional word timings over the voiced part of a chunk.

    Only used when an engine that normally reports word timings returned none for a chunk; the
    chunk is then flagged with `words_estimated: true`.
    """
    found = _WORD_RE.findall(spoken_text)
    if not found or speech_end <= speech_start:
        return []
    weights = [len(w) + 1 for w in found]
    total = float(sum(weights))
    span = speech_end - speech_start
    out: list[TimedToken] = []
    t = speech_start
    for word, weight in zip(found, weights, strict=True):
        d = span * weight / total
        out.append(TimedToken(word, t, t + d))
        t += d
    return out
