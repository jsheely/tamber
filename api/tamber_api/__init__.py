"""Tamber API: self-hosted Kokoro text-to-speech with word-level timestamps."""

__version__ = "0.1.0"

#: Contract major version (docs/API.md). Additive changes do not bump it.
API_VERSION = 1

#: Kokoro's output sample rate (Hz). Every audio file Tamber produces uses it.
SAMPLE_RATE = 24000
