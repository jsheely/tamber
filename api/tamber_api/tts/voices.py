"""Voice catalog, languages, the blend-spec grammar and a small LRU cache (docs/API.md §8.2).

The grammar matches `parseVoiceSpec()` / `formatVoiceSpec()` in packages/client/src/voice-spec.ts:

    spec      := component ( "+" component )*        at most TAMBER_MAX_BLEND_VOICES
    component := voice_id [ "(" weight ")" ]
    voice_id  := [a-z]{2}_[a-z0-9]+(_[a-z0-9]+)*
    weight    := decimal, 0 < weight <= 100            default 1
"""

from __future__ import annotations

import math
import re
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Generic, TypeVar

# --- Languages -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Language:
    code: str
    tag: str
    name: str
    #: Whether the Kokoro pipeline itself yields word timings for this language.
    native_word_timestamps: bool


LANGUAGES: tuple[Language, ...] = (
    Language("a", "en-US", "American English", True),
    Language("b", "en-GB", "British English", True),
    Language("e", "es", "Spanish", False),
    Language("f", "fr-FR", "French", False),
    Language("h", "hi", "Hindi", False),
    Language("i", "it", "Italian", False),
    Language("p", "pt-BR", "Brazilian Portuguese", False),
    Language("j", "ja", "Japanese", False),
    Language("z", "zh", "Mandarin Chinese", False),
)
LANGUAGE_BY_CODE: dict[str, Language] = {lang.code: lang for lang in LANGUAGES}
LANGUAGE_ORDER: dict[str, int] = {lang.code: i for i, lang in enumerate(LANGUAGES)}

LANG_ALIASES: dict[str, str] = {
    "a": "a",
    "en-us": "a",
    "en": "a",
    "b": "b",
    "en-gb": "b",
    "e": "e",
    "es": "e",
    "f": "f",
    "fr-fr": "f",
    "fr": "f",
    "h": "h",
    "hi": "h",
    "i": "i",
    "it": "i",
    "p": "p",
    "pt-br": "p",
    "pt": "p",
    "j": "j",
    "ja": "j",
    "z": "z",
    "zh": "z",
}


def resolve_lang(value: str | None) -> str | None:
    """Letter code for a code or alias (case-insensitive); None when unknown or empty."""
    if not value:
        return None
    return LANG_ALIASES.get(value.strip().lower())


# --- Catalog -------------------------------------------------------------------------------------

#: Kokoro-82M voices with their overall grade from VOICES.md (None = ungraded).
VOICE_GRADES: dict[str, str | None] = {
    # American English
    "af_heart": "A",
    "af_bella": "A-",
    "af_nicole": "B-",
    "af_aoede": "C+",
    "af_kore": "C+",
    "af_sarah": "C+",
    "af_alloy": "C",
    "af_nova": "C",
    "af_sky": "C-",
    "af_jessica": "D",
    "af_river": "D",
    "am_fenrir": "C+",
    "am_michael": "C+",
    "am_puck": "C+",
    "am_echo": "D",
    "am_eric": "D",
    "am_liam": "D",
    "am_onyx": "D",
    "am_santa": "D-",
    "am_adam": "F+",
    # British English
    "bf_emma": "B-",
    "bf_isabella": "C",
    "bf_alice": "D",
    "bf_lily": "D",
    "bm_fable": "C",
    "bm_george": "C",
    "bm_lewis": "D+",
    "bm_daniel": "D",
    # Spanish
    "ef_dora": None,
    "em_alex": None,
    "em_santa": None,
    # French
    "ff_siwis": "B-",
    # Hindi
    "hf_alpha": "C",
    "hf_beta": "C",
    "hm_omega": "C",
    "hm_psi": "C",
    # Italian
    "if_sara": "C",
    "im_nicola": "C",
    # Brazilian Portuguese
    "pf_dora": None,
    "pm_alex": None,
    "pm_santa": None,
    # Japanese
    "jf_alpha": "C+",
    "jf_gongitsune": "C",
    "jf_nezumi": "C-",
    "jf_tebukuro": "C",
    "jm_kumo": "C-",
    # Mandarin Chinese
    "zf_xiaobei": "D",
    "zf_xiaoni": "D",
    "zf_xiaoxiao": "D",
    "zf_xiaoyi": "D",
    "zm_yunjian": "D",
    "zm_yunxi": "D",
    "zm_yunxia": "D",
    "zm_yunyang": "D",
}

_GRADE_SCALE = ("A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+", "F")
_GRADE_RANK = {g: i for i, g in enumerate(_GRADE_SCALE)}
_RECOMMENDED_RANK = _GRADE_RANK["B-"]

PREVIEW_TEXT: dict[str, str] = {
    "a": "Hi, I'm {name}. Tamber can read anything to you, one word at a time.",
    "b": "Hi, I'm {name}. Tamber can read anything to you, one word at a time.",
    "e": "Hola, soy {name}. Tamber puede leerte cualquier cosa, palabra por palabra.",
    "f": "Bonjour, je suis {name}. Tamber peut tout vous lire, un mot à la fois.",
    "h": "नमस्ते, मैं {name} हूँ। Tamber आपके लिए कुछ भी पढ़ सकता है, एक-एक शब्द करके।",
    "i": "Ciao, sono {name}. Tamber può leggerti qualsiasi cosa, una parola alla volta.",
    "p": "Olá, eu sou {name}. O Tamber pode ler qualquer coisa para você, uma palavra de cada vez.",
    "j": "こんにちは、{name}です。Tamberは何でも一語ずつ読み上げます。",
    "z": "你好，我是{name}。Tamber 可以为你朗读任何内容，一字一句。",
}


def grade_rank(grade: str | None) -> int:
    return _GRADE_RANK.get(grade, len(_GRADE_SCALE)) if grade else len(_GRADE_SCALE) + 1


def display_name(voice_id: str) -> str:
    """`af_heart` -> `Heart`; `x_y_z` -> `Y Z`."""
    rest = voice_id.split("_", 1)[1] if "_" in voice_id else voice_id
    return " ".join(part[:1].upper() + part[1:] for part in rest.split("_") if part)


def lang_of_voice(voice_id: str) -> str:
    return voice_id[:1]


def gender_of_voice(voice_id: str) -> str:
    return "male" if voice_id[1:2] == "m" else "female"


def voice_info(voice_id: str, default_voice: str, word_timestamps: bool) -> dict[str, object]:
    lang = LANGUAGE_BY_CODE[lang_of_voice(voice_id)]
    grade = VOICE_GRADES.get(voice_id)
    name = display_name(voice_id)
    tags: list[str] = []
    if voice_id == default_voice:
        tags.append("default")
    if grade is not None and grade_rank(grade) <= _RECOMMENDED_RANK:
        tags.append("recommended")
    return {
        "id": voice_id,
        "name": name,
        "language": lang.tag,
        "language_name": lang.name,
        "lang_code": lang.code,
        "gender": gender_of_voice(voice_id),
        "grade": grade,
        "word_timestamps": word_timestamps,
        "preview_text": preview_text(voice_id),
        "tags": tags,
    }


def preview_text(voice_id: str) -> str:
    template = PREVIEW_TEXT.get(lang_of_voice(voice_id), PREVIEW_TEXT["a"])
    return template.format(name=display_name(voice_id))


def sort_voice_ids(ids: Iterable[str]) -> list[str]:
    """Sorted by language (table order), then grade (best first), then name."""
    return sorted(
        ids,
        key=lambda v: (
            LANGUAGE_ORDER.get(lang_of_voice(v), 99),
            grade_rank(VOICE_GRADES.get(v)),
            display_name(v).lower(),
            v,
        ),
    )


def catalog_ids(languages: Iterable[str]) -> list[str]:
    enabled = set(languages)
    return [v for v in VOICE_GRADES if lang_of_voice(v) in enabled]


# --- Blend specs ---------------------------------------------------------------------------------

VOICE_ID_PATTERN = re.compile(r"^[a-z]{2}_[a-z0-9]+(?:_[a-z0-9]+)*$")
_COMPONENT_PATTERN = re.compile(r"^([a-z0-9_]+)\s*(?:\(\s*([0-9]*\.?[0-9]+)\s*\))?$")


class VoiceSpecError(ValueError):
    """Malformed spec, unknown voice or too many voices. The message is user-presentable."""


@dataclass(frozen=True, slots=True)
class ResolvedVoice:
    """A parsed, validated voice spec."""

    #: Canonical spec, echoed as `voice` in the start event.
    spec: str
    #: (voice id, weight) with the weights normalised to sum to 1.
    components: tuple[tuple[str, float], ...]
    #: Language of the first component.
    lang: str

    @property
    def is_blend(self) -> bool:
        return len(self.components) > 1

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(c[0] for c in self.components)


def parse_voice_spec(spec: str, max_voices: int) -> list[tuple[str, float]]:
    """Parse into (id, raw weight) with duplicates merged, keeping first-appearance order."""
    trimmed = spec.strip()
    if not trimmed:
        raise VoiceSpecError("Voice is empty")
    merged: dict[str, float] = {}
    for raw_part in trimmed.split("+"):
        part = raw_part.strip()
        if not part:
            raise VoiceSpecError(f'Malformed voice spec "{spec}": empty component')
        m = _COMPONENT_PATTERN.match(part)
        if not m:
            raise VoiceSpecError(f'Malformed voice component "{part}"')
        voice_id = m.group(1)
        if not VOICE_ID_PATTERN.match(voice_id):
            raise VoiceSpecError(f'Invalid voice id "{voice_id}"')
        weight = 1.0 if m.group(2) is None else float(m.group(2))
        if not math.isfinite(weight) or weight <= 0 or weight > 100:
            raise VoiceSpecError(f'Weight for "{voice_id}" must be > 0 and <= 100')
        merged[voice_id] = merged.get(voice_id, 0.0) + weight
    if len(merged) > max_voices:
        raise VoiceSpecError(f"A blend can use at most {max_voices} voices")
    return list(merged.items())


def _format_weight(w: float) -> str:
    # JavaScript: String(Math.round(w * 1000) / 1000)
    r = math.floor(w * 1000 + 0.5) / 1000
    if r == int(r):
        return str(int(r))
    return repr(r)


def format_voice_spec(components: list[tuple[str, float]]) -> str:
    """Canonical spec: weights omitted when all equal, else `(w)` rounded to 3 decimals."""
    if not components:
        raise VoiceSpecError("No voices")
    first = components[0][1]
    all_equal = all(abs(w - first) < 1e-9 for _, w in components)
    return "+".join(vid if all_equal else f"{vid}({_format_weight(w)})" for vid, w in components)


def resolve_voice(
    spec: str, max_voices: int, available: set[str] | frozenset[str]
) -> ResolvedVoice:
    """Parse, check availability and normalise. Raises VoiceSpecError."""
    components = parse_voice_spec(spec, max_voices)
    for voice_id, _ in components:
        if voice_id not in available:
            raise VoiceSpecError(
                f"Unknown voice '{voice_id}'. GET /v1/voices lists the available voices."
            )
    total = sum(w for _, w in components)
    normalised = tuple((vid, w / total) for vid, w in components)
    return ResolvedVoice(
        spec=format_voice_spec(components),
        components=normalised,
        lang=lang_of_voice(components[0][0]),
    )


# --- OpenAI voice names (docs/API.md §9.1) --------------------------------------------------------

OPENAI_VOICE_MAP: dict[str, str] = {
    "alloy": "af_alloy",
    "ash": "am_adam",
    "ballad": "bm_fable",
    "coral": "af_heart",
    "echo": "am_echo",
    "fable": "bm_fable",
    "nova": "af_nova",
    "onyx": "am_onyx",
    "sage": "af_sarah",
    "shimmer": "af_bella",
    "verse": "am_michael",
}


# --- LRU -----------------------------------------------------------------------------------------

K = TypeVar("K")
V = TypeVar("V")


class LRUCache(Generic[K, V]):
    """Thread-safe LRU cache (used for blended voice tensors and voice previews)."""

    def __init__(self, maxsize: int) -> None:
        self.maxsize = maxsize
        self._data: OrderedDict[K, V] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: K) -> V | None:
        with self._lock:
            if key not in self._data:
                return None
            self._data.move_to_end(key)
            return self._data[key]

    def put(self, key: K, value: V) -> None:
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self.maxsize:
                self._data.popitem(last=False)

    def get_or_create(self, key: K, factory: Callable[[], V]) -> V:
        found = self.get(key)
        if found is not None:
            return found
        value = factory()
        self.put(key, value)
        return value

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def __contains__(self, key: object) -> bool:
        with self._lock:
            return key in self._data
