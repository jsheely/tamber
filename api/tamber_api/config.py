"""Runtime configuration (pydantic-settings).

Every variable is documented in the root .env.example.
"""

from __future__ import annotations

import logging
import os
from functools import cached_property
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tamber.config")

#: Language codes Kokoro knows about (docs/API.md §8.4.1).
KNOWN_LANGUAGE_CODES = ("a", "b", "e", "f", "h", "i", "p", "j", "z")

#: TAMBER_* variables that are legitimately present but are not settings of the running server.
_NON_SETTING_KEYS = {"TAMBER_TEST_MODEL", "TAMBER_VERSION"}


class Settings(BaseSettings):
    """All `TAMBER_*` environment variables. Defaults equal the values in `.env.example`."""

    model_config = SettingsConfigDict(
        env_prefix="TAMBER_",
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8880
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    root_path: str = ""
    forwarded_allow_ips: str = "*"

    # --- Security ---
    api_key: str = Field(default="", repr=False)
    cors_origins: str = "*"
    docs_enabled: bool = True

    # --- Engine / model ---
    engine: Literal["kokoro", "fake"] = "kokoro"
    device: Literal["auto", "cpu", "cuda", "mps"] = "auto"
    model_repo: str = "hexgrad/Kokoro-82M"
    languages: str = "a,b"
    default_voice: str = "af_heart"
    default_format: Literal["wav", "mp3"] = "wav"
    warmup: bool = True

    # --- Chunking ---
    chunk_target_chars: int = Field(default=280, ge=1)
    chunk_max_chars: int = Field(default=400, ge=50)

    # --- Limits ---
    max_text_chars: int = Field(default=100_000, ge=1)
    max_upload_mb: float = Field(default=25, gt=0)
    max_extract_chars: int = Field(default=500_000, ge=100)
    max_blend_voices: int = Field(default=4, ge=1)
    rate_limit_per_minute: int = Field(default=60, ge=0)
    max_concurrent_synth: int = Field(default=1, ge=1)
    max_queue: int = Field(default=16, ge=0)

    # --- URL extraction ---
    extract_timeout_s: float = Field(default=15, gt=0)
    extract_max_download_mb: float = Field(default=10, gt=0)
    extract_allow_private: bool = False

    # --- Web UI ---
    web_dir: str = "/app/web"

    @field_validator("log_level", "engine", "device", "default_format", mode="before")
    @classmethod
    def _lower(cls, value: object) -> object:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("root_path", mode="after")
    @classmethod
    def _root_path(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if value and not value.startswith("/"):
            value = "/" + value
        return value

    # --- Derived values -------------------------------------------------------------------

    @cached_property
    def api_keys(self) -> tuple[str, ...]:
        """Configured keys; empty tuple = auth disabled."""
        return tuple(k.strip() for k in self.api_key.split(",") if k.strip())

    @property
    def auth_required(self) -> bool:
        return bool(self.api_keys)

    @cached_property
    def cors_origin_list(self) -> list[str] | None:
        """None = CORS disabled; ["*"] = any origin; otherwise an exact allow-list."""
        raw = self.cors_origins.strip()
        if not raw:
            return None
        items = [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]
        if "*" in items:
            return ["*"]
        return items or None

    @cached_property
    def language_codes(self) -> tuple[str, ...]:
        """Enabled language codes, in configuration order, unknown codes dropped."""
        seen: list[str] = []
        for raw in self.languages.split(","):
            code = raw.strip().lower()
            if not code:
                continue
            if code not in KNOWN_LANGUAGE_CODES:
                logger.warning("Ignoring unknown language code %r in TAMBER_LANGUAGES", code)
                continue
            if code not in seen:
                seen.append(code)
        if not seen:
            logger.warning("TAMBER_LANGUAGES enables no known language; falling back to 'a'")
            seen = ["a"]
        return tuple(seen)

    @property
    def max_upload_bytes(self) -> int:
        return int(self.max_upload_mb * 1024 * 1024)

    @property
    def extract_max_download_bytes(self) -> int:
        return int(self.extract_max_download_mb * 1024 * 1024)

    @property
    def chunk_max(self) -> int:
        return max(50, self.chunk_max_chars)

    @property
    def chunk_target(self) -> int:
        return min(self.chunk_max, max(1, self.chunk_target_chars))

    @cached_property
    def web_path(self) -> Path | None:
        """The web UI directory when it holds a build (index.html), else None."""
        raw = self.web_dir.strip()
        if not raw:
            return None
        path = Path(raw)
        if (path / "index.html").is_file():
            return path.resolve()
        return None


def _env_file_keys() -> set[str]:
    keys: set[str] = set()
    for name in (".env", "../.env"):
        path = Path(name)
        if not path.is_file():
            continue
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key = line.split("=", 1)[0].strip()
                key = key.removeprefix("export ").strip()
                keys.add(key.upper())
        except OSError:
            continue
    return keys


def warn_unknown_keys() -> list[str]:
    """Log (never fail) TAMBER_* keys in the environment or .env files that are not settings."""
    known = {f"TAMBER_{name.upper()}" for name in Settings.model_fields}
    candidates = {k.upper() for k in os.environ} | _env_file_keys()
    unknown = sorted(
        k
        for k in candidates
        if k.startswith("TAMBER_") and k not in known and k not in _NON_SETTING_KEYS
    )
    for key in unknown:
        logger.warning("Unknown configuration key %s is ignored (typo?)", key)
    return unknown
