"""Output rules for /v1/extract (docs/API.md §8.5 "Output rules").

* paragraphs (and headings, list items) are separated by exactly "\\n\\n";
* inside a paragraph, whitespace runs are collapsed to one space;
* no leading/trailing whitespace, no soft hyphens, no zero-width characters;
* truncation at TAMBER_MAX_EXTRACT_CHARS happens at the last paragraph break, else the last
  sentence end, else the last whitespace before the limit.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from tamber_api.tts.offsets import utf16_len

#: Soft hyphen, zero-width space/non-joiner/joiner, word joiner, BOM/ZWNBSP, LRM/RLM marks.
_INVISIBLE_RE = re.compile("[­​‌‍⁠﻿‎‏᠎]")
#: Any whitespace (Unicode-aware; includes NBSP and the contract's whitespace set).
_WS_RE = re.compile(r"[\s   -     　]+")
#: Blank-line paragraph boundaries in plain text.
_PARA_SPLIT_RE = re.compile(r"(?:\r\n|\r|\n| )[ \t ]*(?:(?:\r\n|\r|\n| )[ \t ]*)+| ")
_BULLET_RE = re.compile(r"^(?:[-*•◦▪‣]\s+)")
_SENTENCE_END_RE = re.compile(r"[.!?…。！？][\"'”’)\]]*\s")


def clean_paragraph(text: str) -> str:
    text = _INVISIBLE_RE.sub("", text)
    return _WS_RE.sub(" ", text).strip()


def join_paragraphs(paragraphs: Iterable[str]) -> str:
    out: list[str] = []
    for p in paragraphs:
        cleaned = clean_paragraph(p)
        if cleaned:
            out.append(cleaned)
    return "\n\n".join(out)


def split_plain_paragraphs(text: str) -> list[str]:
    """Plain text: blank lines separate paragraphs; single newlines are ordinary spaces."""
    text = text.replace("\r\n", "\n")
    return [p for p in _PARA_SPLIT_RE.split(text) if p.strip()]


def strip_bullet(text: str) -> str:
    return _BULLET_RE.sub("", text.strip())


@dataclass(slots=True)
class Normalized:
    text: str
    truncated: bool
    word_count: int
    char_count: int


def _truncate(text: str, max_chars: int) -> tuple[str, bool]:
    if utf16_len(text) <= max_chars:
        return text, False
    # Largest code-point prefix whose UTF-16 length fits.
    units = 0
    limit = 0
    for i, ch in enumerate(text):
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > max_chars:
            break
        limit = i + 1
    head = text[:limit]
    cut = head.rfind("\n\n")
    if cut <= 0:
        last_end = -1
        # The sentence-end regex needs the following whitespace, so search one char further.
        for m in _SENTENCE_END_RE.finditer(text[: limit + 1]):
            last_end = m.end() - 1
        cut = last_end if last_end > 0 else -1
    if cut <= 0:
        ws = max(head.rfind(" "), head.rfind("\n"))
        cut = ws if ws > 0 else limit
    return text[:cut].rstrip(), True


def finalize(paragraphs: Iterable[str], max_chars: int) -> Normalized:
    text = join_paragraphs(paragraphs)
    text, truncated = _truncate(text, max_chars)
    return Normalized(
        text=text,
        truncated=truncated,
        word_count=len(text.split()),
        char_count=utf16_len(text),
    )
