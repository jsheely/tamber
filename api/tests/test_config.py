"""Settings parsing and the unknown-key warning."""

from __future__ import annotations

import logging

import pytest

from tamber_api.config import Settings, warn_unknown_keys

from .conftest import make_settings


def test_defaults_match_env_example(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(__import__("os").environ):
        if key.upper().startswith("TAMBER_"):
            monkeypatch.delenv(key)
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert (s.host, s.port, s.engine, s.device) == ("0.0.0.0", 8880, "kokoro", "auto")
    assert s.model_repo == "hexgrad/Kokoro-82M"
    assert s.language_codes == ("a", "b")
    assert (s.chunk_target, s.chunk_max) == (280, 400)
    assert s.max_upload_bytes == 25 * 1024 * 1024
    assert s.auth_required is False and s.cors_origin_list == ["*"]
    assert s.web_dir == "/app/web"


def test_env_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TAMBER_API_KEY", " a , b ,, ")
    monkeypatch.setenv("TAMBER_CORS_ORIGINS", "https://x.example/, chrome-extension://abc")
    monkeypatch.setenv("TAMBER_LANGUAGES", "A, b, q, a")
    monkeypatch.setenv("TAMBER_ENGINE", "FAKE")
    monkeypatch.setenv("TAMBER_ROOT_PATH", "tts/")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.api_keys == ("a", "b")
    assert s.cors_origin_list == ["https://x.example", "chrome-extension://abc"]
    assert s.language_codes == ("a", "b")
    assert s.engine == "fake"
    assert s.root_path == "/tts"
    assert "api_key" not in repr(s)  # never printed


def test_cors_empty_disables() -> None:
    assert make_settings(cors_origins="").cors_origin_list is None
    assert make_settings(cors_origins="https://a, *").cors_origin_list == ["*"]


def test_chunk_limits_are_clamped() -> None:
    s = make_settings(chunk_target_chars=900, chunk_max_chars=300)
    assert (s.chunk_target, s.chunk_max) == (300, 300)
    with pytest.raises(ValueError):
        make_settings(chunk_max_chars=10)


def test_unknown_keys_are_warned_not_fatal(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("TAMBER_API_KYE", "s3cret-value")
    monkeypatch.setenv("TAMBER_TEST_MODEL", "0")
    with caplog.at_level(logging.WARNING, logger="tamber.config"):
        unknown = warn_unknown_keys()
    assert "TAMBER_API_KYE" in unknown
    assert "TAMBER_TEST_MODEL" not in unknown
    assert any("TAMBER_API_KYE" in rec.getMessage() for rec in caplog.records)
    assert all("s3cret-value" not in rec.getMessage() for rec in caplog.records)
