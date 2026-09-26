"""UTF-16 offset helpers and the spoken-text index map (docs/API.md §6.1).

Python strings index code points; every offset on the wire is a UTF-16 code unit (a JavaScript
string index). `Utf16Index` converts between the two with a prefix-sum table. `SpokenText` is the
internal form sent to the model (whitespace runs collapsed to one space) together with a map from
each spoken index back to the original code-point index, so word offsets always refer to the text
the client submitted.
"""

from __future__ import annotations

from dataclasses import dataclass

from tamber_api.tts.chunking import WHITESPACE


def utf16_len(text: str) -> int:
    """Length of `text` in UTF-16 code units (JavaScript `text.length`)."""
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


def is_ws(ch: str) -> bool:
    """Whitespace as defined by the contract (§6.1), not `str.isspace`."""
    return ord(ch) in WHITESPACE


class Utf16Index:
    """Prefix table: `utf16[i]` = UTF-16 length of `text[:i]`, plus the inverse mapping."""

    __slots__ = ("_cp_of_u16", "length", "text", "utf16")

    def __init__(self, text: str) -> None:
        self.text = text
        prefix = [0] * (len(text) + 1)
        acc = 0
        for i, ch in enumerate(text):
            acc += 2 if ord(ch) > 0xFFFF else 1
            prefix[i + 1] = acc
        self.utf16 = prefix
        self.length = acc
        inverse = [-1] * (acc + 1)
        for cp_index, u in enumerate(prefix):
            inverse[u] = cp_index
        self._cp_of_u16 = inverse

    def to_utf16(self, cp_index: int) -> int:
        return self.utf16[cp_index]

    def to_cp(self, u16_index: int) -> int:
        """Code-point index for a UTF-16 index. Raises ValueError inside a surrogate pair."""
        cp = self._cp_of_u16[u16_index]
        if cp < 0:
            raise ValueError(f"UTF-16 offset {u16_index} is inside a surrogate pair")
        return cp

    def slice_utf16(self, start: int, end: int) -> str:
        """`text.slice(start, end)` with UTF-16 offsets."""
        return self.text[self.to_cp(start) : self.to_cp(end)]


@dataclass(frozen=True, slots=True)
class SpokenText:
    """A chunk's spoken form plus `index_map[i]` = original code-point index of `text[i]`."""

    text: str
    index_map: list[int]


def spoken_form(text: str, cp_start: int, cp_end: int) -> SpokenText:
    """Collapse whitespace runs of `text[cp_start:cp_end]` to one space (the chunk is trimmed)."""
    out: list[str] = []
    index_map: list[int] = []
    in_ws = False
    for i in range(cp_start, cp_end):
        ch = text[i]
        if ord(ch) in WHITESPACE:
            if not in_ws and out:
                out.append(" ")
                index_map.append(i)
            in_ws = True
            continue
        in_ws = False
        out.append(ch)
        index_map.append(i)
    # A trimmed chunk never ends in whitespace, but be defensive.
    while out and out[-1] == " ":
        out.pop()
        index_map.pop()
    return SpokenText("".join(out), index_map)
