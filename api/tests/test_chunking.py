"""Chunk planner conformance with the shared TypeScript fixtures, plus offset helpers."""

from __future__ import annotations

import json
from typing import Any

import pytest

from tamber_api.tts.chunking import chunk_index_for_offset, plan_chunks, to_utf16_units
from tamber_api.tts.offsets import Utf16Index, spoken_form, utf16_len

from .conftest import FIXTURES


def _cases() -> list[dict[str, Any]]:
    data = json.loads(FIXTURES.read_text(encoding="utf-8"))
    cases: list[dict[str, Any]] = data["cases"]
    return cases


def _js_slice(text: str, start: int, end: int) -> str:
    units = to_utf16_units(text)[start:end]
    raw = b"".join(u.to_bytes(2, "little") for u in units)
    return raw.decode("utf-16-le", "surrogatepass")


def test_fixture_file_is_present_and_nonempty() -> None:
    assert FIXTURES.is_file(), f"missing {FIXTURES}"
    assert len(_cases()) >= 20


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["name"])
def test_planner_matches_reference_fixture(case: dict[str, Any]) -> None:
    opts = case["options"]
    plan = plan_chunks(case["text"], opts["mode"], opts["targetChars"], opts["maxChars"])
    assert [[c.char_start, c.char_end] for c in plan] == case["expected"]
    assert [c.index for c in plan] == list(range(len(plan)))
    assert [_js_slice(case["text"], c.char_start, c.char_end) for c in plan] == case[
        "expected_text"
    ]


def test_every_case_respects_max_and_never_splits_surrogates() -> None:
    for case in _cases():
        text = case["text"]
        opts = case["options"]
        units = to_utf16_units(text)
        for c in plan_chunks(text, opts["mode"], opts["targetChars"], opts["maxChars"]):
            assert c.char_end - c.char_start <= max(50, opts["maxChars"])
            if c.char_start < len(units):
                assert not 0xDC00 <= units[c.char_start] <= 0xDFFF
            assert not 0xD800 <= units[c.char_end - 1] <= 0xDBFF


def test_paragraph_end_flags() -> None:
    text = "One. Two.\n\nThree. Four! Five?\n\nSix"
    plan = plan_chunks(text, "sentence")
    assert [c.paragraph_end for c in plan] == [False, True, False, False, True, True]


def test_emoji_offsets_are_utf16() -> None:
    text = "I 😀 you. Next 👍🏽 one."
    plan = plan_chunks(text, "sentence")
    assert utf16_len(text) == len(to_utf16_units(text))
    assert [(c.char_start, c.char_end) for c in plan] == [(0, 9), (10, 24)]
    assert _js_slice(text, 0, 9) == "I 😀 you."
    idx = Utf16Index(text)
    assert idx.slice_utf16(10, 24) == "Next 👍🏽 one."
    assert idx.to_utf16(3) == 4  # after the emoji
    with pytest.raises(ValueError):
        idx.to_cp(3)  # inside the surrogate pair


def test_chunk_index_for_offset() -> None:
    plan = plan_chunks("Hello world. This is Tamber.")
    assert chunk_index_for_offset(plan, 0) == 0
    assert chunk_index_for_offset(plan, 12) == 1
    assert chunk_index_for_offset(plan, 100) == -1


def test_spoken_form_collapses_whitespace_and_maps_back() -> None:
    text = "  Hello \n\t world  again  "
    spoken = spoken_form(text, 2, len(text) - 2)
    assert spoken.text == "Hello world again"
    for i, ch in enumerate(spoken.text):
        if ch != " ":
            assert text[spoken.index_map[i]] == ch
