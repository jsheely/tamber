"""Cross-cutting HTTP behaviour: health, auth, CORS, error envelope, limits, request ids."""

from __future__ import annotations

import re
from typing import Any

from fastapi.testclient import TestClient

from tamber_api import __version__

from .conftest import make_app, ready_client, wait_ready

ENVELOPE_KEYS = {"code", "message", "type", "param", "request_id", "details"}


def assert_envelope(r: Any, status: int, code: str, type_: str | None = None) -> dict[str, Any]:
    assert r.status_code == status, r.text
    body = r.json()
    assert set(body) == {"error"}
    err: dict[str, Any] = body["error"]
    assert set(err) == ENVELOPE_KEYS
    assert err["code"] == code
    if type_:
        assert err["type"] == type_
    assert err["request_id"] == r.headers["x-request-id"]
    return err


def test_health_shape(client: TestClient) -> None:
    r = client.get("/v1/health")
    assert r.status_code == 200
    h = r.json()
    assert h["status"] == "ok"
    assert h["version"] == __version__ and h["api_version"] == 1
    assert (h["engine"], h["model"], h["device"]) == ("fake", "fake", "cpu")
    assert h["model_loaded"] is True and h["auth_required"] is False
    assert h["sample_rate"] == 24000 and h["formats"] == ["wav", "mp3"]
    assert h["default_voice"] == "af_heart" and h["default_format"] == "wav"
    assert h["languages"] == [
        {"code": "a", "tag": "en-US", "name": "American English", "word_timestamps": True},
        {"code": "b", "tag": "en-GB", "name": "British English", "word_timestamps": True},
    ]
    assert h["limits"] == {
        "max_text_chars": 100000,
        "max_upload_bytes": 26214400,
        "max_extract_chars": 500000,
        "chunk_target_chars": 280,
        "chunk_max_chars": 400,
        "rate_limit_per_minute": 0,
        "speed_min": 0.25,
        "speed_max": 4.0,
        "max_blend_voices": 4,
    }
    assert all(h["features"].values()) and len(h["features"]) == 6
    assert client.head("/v1/health").status_code == 200


def test_request_id_and_version_headers(client: TestClient) -> None:
    r = client.get("/v1/health", headers={"X-Request-ID": "abc.DEF_123-x"})
    assert r.headers["x-request-id"] == "abc.DEF_123-x"
    assert r.headers["x-tamber-version"] == __version__
    r = client.get("/v1/health", headers={"X-Request-ID": "bad id with spaces"})
    assert re.fullmatch(r"[0-9a-f]{32}", r.headers["x-request-id"])
    r = client.get("/v1/nope", headers={"X-Request-ID": "trace-1"})
    assert r.json()["error"]["request_id"] == "trace-1"


def test_auth_disabled_everything_open(client: TestClient) -> None:
    assert client.get("/v1/voices").status_code == 200
    assert client.get("/v1/models").status_code == 200


def test_auth_bearer_and_x_api_key() -> None:
    with ready_client(api_key=" key-one , key-two ,, ") as client:
        health = client.get("/v1/health")
        assert health.status_code == 200 and health.json()["auth_required"] is True
        for path in ("/v1/voices", "/v1/models", "/v1/audio/voices", "/v1/voices/af_heart/preview"):
            r = client.get(path)
            err = assert_envelope(r, 401, "unauthorized", "authentication_error")
            assert r.headers["www-authenticate"] == 'Bearer realm="tamber"'
            assert "key-one" not in err["message"]
        wrong = client.post(
            "/v1/tts", json={"text": "Hi."}, headers={"Authorization": "Bearer nope"}
        )
        missing = client.post("/v1/tts", json={"text": "Hi."})
        assert wrong.json()["error"]["message"] == missing.json()["error"]["message"]
        assert wrong.status_code == missing.status_code == 401
        # Invalid JSON without a key is still 401 (auth runs before body parsing).
        r = client.post("/v1/tts", content=b"{nope", headers={"Content-Type": "application/json"})
        assert r.status_code == 401
        ok = client.get("/v1/voices", headers={"Authorization": "Bearer key-one"})
        assert ok.status_code == 200
        ok = client.get("/v1/voices", headers={"authorization": "bearer key-two"})
        assert ok.status_code == 200
        ok = client.get("/v1/voices", headers={"X-API-Key": "key-two"})
        assert ok.status_code == 200
        assert client.get("/v1/voices", headers={"X-API-Key": "key-three"}).status_code == 401
        r = client.post(
            "/v1/tts", json={"text": "Hi."}, headers={"Authorization": "Bearer key-one"}
        )
        assert r.status_code == 200
        # Docs and the (absent) UI banner stay public.
        assert client.get("/openapi.json").status_code == 200
        assert client.get("/").status_code == 200


def test_cors_wildcard() -> None:
    with ready_client(cors_origins="*") as client:
        r = client.get("/v1/health", headers={"Origin": "https://any.example"})
        assert r.headers["access-control-allow-origin"] == "*"
        assert "x-request-id" in r.headers["access-control-expose-headers"].lower()
        pre = client.options(
            "/v1/tts",
            headers={
                "Origin": "https://any.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization, content-type",
            },
        )
        assert pre.status_code == 200
        assert pre.headers["access-control-allow-origin"] == "*"
        assert pre.headers["access-control-max-age"] == "600"
        assert "POST" in pre.headers["access-control-allow-methods"]
        assert "access-control-allow-credentials" not in pre.headers
        assert "x-request-id" in pre.headers


def test_cors_allow_list() -> None:
    origins = "https://tts.example.com,chrome-extension://abcdefgh"
    with ready_client(cors_origins=origins, api_key="k") as client:
        r = client.get("/v1/health", headers={"Origin": "chrome-extension://abcdefgh"})
        assert r.headers["access-control-allow-origin"] == "chrome-extension://abcdefgh"
        assert "origin" in r.headers.get("vary", "").lower()
        r = client.get("/v1/health", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in r.headers
        # Preflight is exempt from auth.
        pre = client.options(
            "/v1/tts",
            headers={
                "Origin": "https://tts.example.com",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        assert pre.status_code == 200
        assert pre.headers["access-control-allow-origin"] == "https://tts.example.com"
        # Errors are readable cross-origin too.
        r = client.get("/v1/voices", headers={"Origin": "https://tts.example.com"})
        assert r.status_code == 401
        assert r.headers["access-control-allow-origin"] == "https://tts.example.com"


def test_cors_disabled() -> None:
    with ready_client(cors_origins="") as client:
        r = client.get("/v1/health", headers={"Origin": "https://a.example"})
        assert "access-control-allow-origin" not in r.headers
        pre = client.options(
            "/v1/tts",
            headers={"Origin": "https://a.example", "Access-Control-Request-Method": "POST"},
        )
        assert "access-control-allow-origin" not in pre.headers


def test_error_envelopes(client: TestClient) -> None:
    assert_envelope(client.get("/v1/does-not-exist"), 404, "not_found", "invalid_request_error")
    assert_envelope(client.get("/v1/tts"), 405, "method_not_allowed")
    assert_envelope(client.post("/v1/health"), 405, "method_not_allowed")
    err = assert_envelope(
        client.post("/v1/tts", content=b"{not json", headers={"Content-Type": "application/json"}),
        400,
        "invalid_request",
    )
    assert err["details"][0]["type"] == "json_invalid"
    # FastAPI's 422 is remapped to 400 with the validation details.
    err = assert_envelope(
        client.post("/v1/tts", json={"text": "Hi", "speed": 0.1}), 400, "invalid_request"
    )
    assert err["param"] == "speed"
    assert err["details"][0]["loc"] == ["body", "speed"]
    assert {"loc", "msg", "type"} <= set(err["details"][0])
    err = assert_envelope(
        client.get("/v1/voices/af_heart/preview?format=ogg"), 400, "unsupported_format"
    )
    assert_envelope(
        client.post("/v1/tts", content=b"text=hi", headers={"Content-Type": "text/csv"}),
        415,
        "unsupported_media_type",
    )


def test_body_limits_413() -> None:
    with ready_client(max_text_chars=100, max_upload_mb=0.001) as client:
        big = client.post(
            "/v1/tts",
            content=b'{"text": "' + b"a" * 20000 + b'"}',
            headers={"Content-Type": "application/json"},
        )
        err = assert_envelope(big, 413, "text_too_long")
        assert err["details"]["max"] == 100
        upload = client.post(
            "/v1/extract", files={"file": ("big.txt", b"word " * 300_000, "text/plain")}
        )
        assert_envelope(upload, 413, "file_too_large")


def test_rate_limit_429() -> None:
    with ready_client(rate_limit_per_minute=2) as client:
        r1 = client.post("/v1/tts", json={"text": "One."})
        assert r1.headers["x-ratelimit-limit"] == "2"
        assert r1.headers["x-ratelimit-remaining"] == "1"
        r2 = client.post("/v1/tts", json={"text": "Two."})
        assert r2.status_code == 200 and r2.headers["x-ratelimit-remaining"] == "0"
        r3 = client.post("/v1/tts", json={"text": "Three."})
        err = assert_envelope(r3, 429, "rate_limited", "rate_limit_error")
        assert int(r3.headers["retry-after"]) >= 1
        assert r3.headers["x-ratelimit-remaining"] == "0"
        assert "try again" in err["message"].lower()
        # Health and GET routes are not rate limited.
        for _ in range(5):
            assert client.get("/v1/health").status_code == 200
            assert client.get("/v1/voices").status_code == 200


def test_rate_limit_is_per_key_when_auth_is_on() -> None:
    with ready_client(rate_limit_per_minute=1, api_key="a,b") as client:
        ha = {"Authorization": "Bearer a"}
        hb = {"X-API-Key": "b"}
        assert client.post("/v1/tts", json={"text": "x1."}, headers=ha).status_code == 200
        assert client.post("/v1/tts", json={"text": "x2."}, headers=ha).status_code == 429
        assert client.post("/v1/tts", json={"text": "x3."}, headers=hb).status_code == 200


def test_openapi_and_docs_toggle() -> None:
    with ready_client(docs_enabled=False) as client:
        assert client.get("/openapi.json").status_code == 404
        assert client.get("/docs").status_code == 404
    with ready_client() as client:
        schema = client.get("/openapi.json").json()
        assert "/v1/tts" in schema["paths"] and "/v1/audio/speech" in schema["paths"]
        assert client.get("/docs").status_code == 200


def test_internal_errors_use_the_envelope() -> None:
    app = make_app()

    @app.get("/v1/boom")
    async def boom() -> None:
        raise RuntimeError("secret detail")

    with TestClient(app, raise_server_exceptions=False) as client:
        wait_ready(client)
        r = client.get("/v1/boom", headers={"Origin": "https://x.example"})
        err = assert_envelope(r, 500, "internal_error", "server_error")
        assert "secret" not in err["message"]
        assert r.headers["access-control-allow-origin"] == "*"
