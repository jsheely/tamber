"""Deterministic chunk planner: a rule-for-rule port of packages/client/src/chunking.ts.

docs/API.md §6.3 is the specification and packages/client/fixtures/chunking.json is the
conformance suite (tests/test_chunking.py runs every case). To be byte-for-byte identical with the
TypeScript reference, the planner runs directly on the text's UTF-16 code units (JavaScript string
indices): every length, limit and emitted offset is in UTF-16 units, and surrogate pairs are only
decoded where the reference decodes them (the lower-case and "speakable" checks). A cut is never
placed inside a surrogate pair.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Literal

ChunkMode = Literal["balanced", "sentence"]

CHUNK_TARGET_CHARS_DEFAULT = 280
CHUNK_MAX_CHARS_DEFAULT = 400
CHUNK_MAX_CHARS_MIN = 50

# --- Character classes (all BMP; compared as UTF-16 code units) ---------------------------------

WHITESPACE: frozenset[int] = frozenset(
    {
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680,
        0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
        0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    }
)  # fmt: skip


def _units(chars: str) -> frozenset[int]:
    return frozenset(ord(c) for c in chars)


#: Sentence terminators.
TERMINATORS = _units(".!?…‼⁇⁈⁉。！？｡")
#: Terminators that end a sentence even without following whitespace (CJK full-width).
CJK_TERMINATORS = _units("。！？｡")
#: Closing quotes/brackets that stay attached to the sentence they close.
CLOSERS = _units("\"'”’)]}»›」』）】")
#: Opening quotes/brackets stripped from the front of a word before the abbreviation check.
OPENERS = _units("\"'“‘([{«‹「『（【")
#: Clause punctuation used to split an over-long sentence (needs following whitespace).
CLAUSE = _units(",;:—–")
#: CJK clause punctuation (no following whitespace needed).
CJK_CLAUSE = _units("，；：、")

#: Lower-case abbreviations (without the final period) that do not end a sentence.
ABBREVIATIONS: frozenset[str] = frozenset(
    """
    mr mrs ms mx dr prof sr jr st mt ft vs etc al cf approx dept est fig figs inc ltd co corp no
    nos vol vols pp ed eds rev gen gov sen rep lt col capt sgt cpl jan feb mar apr jun jul aug sep
    sept oct nov dec mon tue tues wed thu thur thurs fri sat sun e.g i.e a.m p.m u.s u.k e.u ph.d
    m.d b.a m.a ave blvd rd hwy
    """.split()  # noqa: SIM905
)

_DOT = ord(".")
_CR = 0x0D
_LF = 0x0A
_SINGLE_BREAKS = frozenset({0x0A, 0x0B, 0x0C, 0x85, 0x2028})
_PARA_SEP = 0x2029


@dataclass(frozen=True, slots=True)
class TextSpan:
    """Half-open `[start, end)` span in UTF-16 code units."""

    start: int
    end: int


@dataclass(frozen=True, slots=True)
class ChunkSpan:
    """One planned chunk. Offsets are UTF-16 code units into the submitted text."""

    index: int
    char_start: int
    char_end: int
    #: True when this is the last chunk of its paragraph (selects the trailing pause, §7.1).
    paragraph_end: bool = False

    def as_dict(self) -> dict[str, int]:
        return {"index": self.index, "char_start": self.char_start, "char_end": self.char_end}


def to_utf16_units(text: str) -> list[int]:
    """The UTF-16 code units of `text` (what a JavaScript string indexes)."""
    raw = text.encode("utf-16-le", "surrogatepass")
    return [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]


def _units_to_str(units: list[int]) -> str:
    raw = b"".join(u.to_bytes(2, "little") for u in units)
    return raw.decode("utf-16-le", "surrogatepass")


def _is_high(u: int) -> bool:
    return 0xD800 <= u <= 0xDBFF


def _is_low(u: int) -> bool:
    return 0xDC00 <= u <= 0xDFFF


def _code_point_at(units: list[int], i: int) -> int:
    """JavaScript `String.prototype.codePointAt`."""
    u = units[i]
    if _is_high(u) and i + 1 < len(units) and _is_low(units[i + 1]):
        return 0x10000 + ((u - 0xD800) << 10) + (units[i + 1] - 0xDC00)
    return u


class _Text:
    """UTF-16 view of a string with the helpers the reference implementation uses."""

    __slots__ = ("n", "u")

    def __init__(self, text: str) -> None:
        self.u = to_utf16_units(text)
        self.n = len(self.u)

    def is_ws(self, i: int) -> bool:
        return self.u[i] in WHITESPACE

    def line_breaks(self, s: int, e: int) -> int:
        """Line breaks in [s, e): CRLF counts once, U+2029 counts twice."""
        count = 0
        i = s
        u = self.u
        while i < e:
            c = u[i]
            if c == _CR:
                count += 1
                if i + 1 < e and u[i + 1] == _LF:
                    i += 1
            elif c in _SINGLE_BREAKS:
                count += 1
            elif c == _PARA_SEP:
                count += 2
            i += 1
        return count

    def trim(self, s: int, e: int) -> TextSpan | None:
        while s < e and self.is_ws(s):
            s += 1
        while e > s and self.is_ws(e - 1):
            e -= 1
        return TextSpan(s, e) if s < e else None


# --- Rules ---------------------------------------------------------------------------------------


def _split_paragraphs(t: _Text) -> list[TextSpan]:
    """Rule 1: split at every whitespace run holding >= 2 line breaks; trim; drop empties."""
    out: list[TextSpan] = []
    n = t.n
    seg_start = 0
    i = 0
    while i < n:
        if t.is_ws(i):
            j = i
            while j < n and t.is_ws(j):
                j += 1
            if t.line_breaks(i, j) >= 2:
                span = t.trim(seg_start, i)
                if span:
                    out.append(span)
                seg_start = j
            i = j
        else:
            i += 1
    last = t.trim(seg_start, n)
    if last:
        out.append(last)
    return out


def _is_lowercase_letter(cp: int) -> bool:
    return unicodedata.category(chr(cp)) == "Ll"


def _split_sentences(t: _Text, para: TextSpan) -> list[TextSpan]:
    """Rule 2: sentence boundaries inside one trimmed paragraph."""
    ps, pe = para.start, para.end
    u = t.u
    cuts: list[int] = []
    i = ps
    while i < pe:
        ch = u[i]
        if ch not in TERMINATORS:
            i += 1
            continue
        run_start = i
        j = i
        has_cjk = False
        while j < pe and u[j] in TERMINATORS:
            if u[j] in CJK_TERMINATORS:
                has_cjk = True
            j += 1
        run_end = j
        end = j
        while end < pe and u[end] in CLOSERS:
            end += 1
        if end < pe and (has_cjk or t.is_ws(end)):
            valid = True
            # Suppression (a): a single "." after an abbreviation or a single ASCII letter.
            if run_end - run_start == 1 and ch == _DOT:
                ws = run_start
                while ws > ps and not t.is_ws(ws - 1):
                    ws -= 1
                w = ws
                while w < run_start and u[w] in OPENERS:
                    w += 1
                word_units = u[w:run_start]
                is_initial = len(word_units) == 1 and (
                    0x41 <= word_units[0] <= 0x5A or 0x61 <= word_units[0] <= 0x7A
                )
                if is_initial or _units_to_str(word_units).lower() in ABBREVIATIONS:
                    valid = False
            # Suppression (b): the next non-whitespace character is a lower-case letter (Ll).
            if valid:
                m = end
                while m < pe and t.is_ws(m):
                    m += 1
                if m < pe and _is_lowercase_letter(_code_point_at(u, m)):
                    valid = False
            if valid:
                cuts.append(end)
        i = end if end > run_end else run_end
    out: list[TextSpan] = []
    s = ps
    for c in cuts:
        span = t.trim(s, c)
        if span:
            out.append(span)
        s = c
    last = t.trim(s, pe)
    if last:
        out.append(last)
    return out


def _split_long_sentence(t: _Text, sentence: TextSpan, max_chars: int) -> list[TextSpan]:
    """Rule 3: cut a sentence longer than max_chars at clause punctuation, whitespace, or hard."""
    out: list[TextSpan] = []
    u = t.u
    a = sentence.start
    b = sentence.end
    while b - a > max_chars:
        limit = a + max_chars
        cut = -1
        for x in range(limit, a, -1):
            prev = u[x - 1]
            if (prev in CLAUSE and t.is_ws(x)) or prev in CJK_CLAUSE:
                cut = x
                break
        if cut < 0:
            for x in range(limit, a, -1):
                if t.is_ws(x):
                    cut = x
                    break
        if cut < 0:
            cut = limit
            if _is_high(u[cut - 1]):
                cut -= 1
        piece = t.trim(a, cut)
        if piece:
            out.append(piece)
        a = cut
        while a < b and t.is_ws(a):
            a += 1
    if a < b:
        out.append(TextSpan(a, b))
    return out


def _is_speakable(t: _Text, span: TextSpan) -> bool:
    """Rule 4: the span contains at least one letter or digit (Unicode L* or N*)."""
    u = t.u
    i = span.start
    while i < span.end:
        cp = u[i]
        if _is_high(cp) and i + 1 < span.end and _is_low(u[i + 1]):
            cp = 0x10000 + ((cp - 0xD800) << 10) + (u[i + 1] - 0xDC00)
            i += 1
        if unicodedata.category(chr(cp))[0] in ("L", "N"):
            return True
        i += 1
    return False


def resolve_limits(
    mode: str | None, target_chars: int | None, max_chars: int | None
) -> tuple[ChunkMode, int, int]:
    resolved_mode: ChunkMode = "sentence" if mode == "sentence" else "balanced"
    mx = max(
        CHUNK_MAX_CHARS_MIN,
        int(max_chars) if max_chars is not None else CHUNK_MAX_CHARS_DEFAULT,
    )
    target = min(
        mx, max(1, int(target_chars) if target_chars is not None else CHUNK_TARGET_CHARS_DEFAULT)
    )
    return resolved_mode, target, mx


def plan_chunks(
    text: str,
    mode: str | None = "balanced",
    target_chars: int | None = CHUNK_TARGET_CHARS_DEFAULT,
    max_chars: int | None = CHUNK_MAX_CHARS_DEFAULT,
) -> list[ChunkSpan]:
    """Plan the chunks for `text` (docs/API.md §6.3). Offsets are UTF-16 code units.

    1. paragraphs -> 2. sentences -> 3. long-sentence pieces -> 4. drop unspeakable pieces ->
    5. pack (`sentence`: one piece per chunk; `balanced`: first piece alone, then merge pieces of
    one paragraph while `last.end - first.start <= target`) -> 6. number 0..n-1.
    """
    resolved_mode, target, mx = resolve_limits(mode, target_chars, max_chars)
    t = _Text(text)
    spans: list[tuple[int, int, bool]] = []
    is_first = True
    for para in _split_paragraphs(t):
        pieces: list[TextSpan] = []
        for sentence in _split_sentences(t, para):
            for piece in _split_long_sentence(t, sentence, mx):
                if _is_speakable(t, piece):
                    pieces.append(piece)
        para_spans: list[tuple[int, int]] = []
        cur: list[int] | None = None
        for p in pieces:
            if resolved_mode == "sentence":
                para_spans.append((p.start, p.end))
                continue
            if is_first:
                para_spans.append((p.start, p.end))
                is_first = False
                continue
            if cur is not None and p.end - cur[0] <= target:
                cur[1] = p.end
            else:
                if cur is not None:
                    para_spans.append((cur[0], cur[1]))
                cur = [p.start, p.end]
        if cur is not None:
            para_spans.append((cur[0], cur[1]))
        for k, (s, e) in enumerate(para_spans):
            spans.append((s, e, k == len(para_spans) - 1))
    return [ChunkSpan(i, s, e, last) for i, (s, e, last) in enumerate(spans)]


def chunk_index_for_offset(plan: list[ChunkSpan], offset: int) -> int:
    """Index of the chunk containing `offset` (or the next one after a gap); -1 if none."""
    lo, hi, ans = 0, len(plan) - 1, -1
    while lo <= hi:
        mid = (lo + hi) >> 1
        if plan[mid].char_end > offset:
            ans = mid
            hi = mid - 1
        else:
            lo = mid + 1
    return ans
