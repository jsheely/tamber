"""Voice catalog, blend grammar (same as voice-spec.ts), previews."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tamber_api.tts.voices import (
    VoiceSpecError,
    display_name,
    format_voice_spec,
    parse_voice_spec,
    resolve_voice,
    sort_voice_ids,
)

from .conftest import make_app, parse_ndjson, ready_client, wait_ready

AVAILABLE = frozenset({"af_heart", "af_bella", "af_sky", "am_adam", "bf_emma", "af_nicole"})


@pytest.mark.parametrize(
    ("spec", "canonical"),
    [
        ("af_heart", "af_heart"),
        ("  af_heart  ", "af_heart"),
        ("af_bella+af_sky", "af_bella+af_sky"),
        ("af_bella(2)+af_sky(1)", "af_bella(2)+af_sky(1)"),
        ("af_bella( 2 ) + af_sky", "af_bella(2)+af_sky(1)"),
        ("af_bella(1)+af_sky(1)", "af_bella+af_sky"),
        ("af_bella(.5)+af_sky(0.25)", "af_bella(0.5)+af_sky(0.25)"),
        ("af_bella+af_sky+af_bella", "af_bella(2)+af_sky(1)"),
        ("af_bella(0.3333)+af_sky(0.6666)", "af_bella(0.333)+af_sky(0.667)"),
        ("af_bella(100)+af_sky(0.0005)", "af_bella(100)+af_sky(0.001)"),
    ],
)
def test_canonical_spec(spec: str, canonical: str) -> None:
    assert resolve_voice(spec, 4, AVAILABLE).spec == canonical


def test_weights_are_normalised_and_language_is_first_component() -> None:
    v = resolve_voice("bf_emma(3)+af_heart(1)", 4, AVAILABLE)
    assert v.components == (("bf_emma", 0.75), ("af_heart", 0.25))
    assert v.lang == "b" and v.is_blend


@pytest.mark.parametrize(
    "spec",
    [
        "",
        "   ",
        "af_heart+",
        "+af_heart",
        "af_heart++af_sky",
        "AF_HEART",
        "af-heart",
        "heart",
        "af_heart(0)",
        "af_heart(101)",
        "af_heart(-1)",
        "af_heart(1e2)",
        "af_heart(abc)",
        "af_heart-af_sky",
        "af_heart+af_bella+af_sky+am_adam+bf_emma",
        "af_nope",
    ],
)
def test_invalid_specs(spec: str) -> None:
    with pytest.raises(VoiceSpecError):
        resolve_voice(spec, 4, AVAILABLE)


def test_parse_merges_duplicates_and_limit_counts_unique_ids() -> None:
    assert parse_voice_spec("af_heart+af_heart(2)", 1) == [("af_heart", 3.0)]
    assert format_voice_spec([("a_b", 1.0), ("c_d", 1.0)]) == "a_b+c_d"


def test_display_names_and_sorting() -> None:
    assert display_name("af_heart") == "Heart"
    assert display_name("zf_xiao_xiao") == "Xiao Xiao"
    ordered = sort_voice_ids(["bm_george", "af_sky", "af_heart", "af_bella", "bf_emma"])
    assert ordered == ["af_heart", "af_bella", "af_sky", "bf_emma", "bm_george"]


def test_voices_endpoint(client: TestClient) -> None:
    body = client.get("/v1/voices").json()
    assert body["default_voice"] == "af_heart"
    assert [lang["code"] for lang in body["languages"]] == ["a", "b"]
    ids = [v["id"] for v in body["voices"]]
    assert ids[0] == "af_heart" and ids[1] == "af_bella"
    assert all(v[:1] in "ab" for v in ids)
    assert len(ids) == 28
    heart = body["voices"][0]
    assert heart == {
        "id": "af_heart",
        "name": "Heart",
        "language": "en-US",
        "language_name": "American English",
        "lang_code": "a",
        "gender": "female",
        "grade": "A",
        "word_timestamps": True,
        "preview_text": "Hi, I'm Heart. Tamber can read anything to you, one word at a time.",
        "tags": ["default", "recommended"],
    }
    george = next(v for v in body["voices"] if v["id"] == "bm_george")
    assert george["tags"] == [] and george["gender"] == "male" and george["grade"] == "C"
    emma = next(v for v in body["voices"] if v["id"] == "bf_emma")
    assert emma["tags"] == ["recommended"]
    legacy = client.get("/v1/audio/voices").json()
    assert legacy["default_voice"] == "af_heart"
    assert legacy["voices"][0] == {"id": "af_heart", "name": "af_heart"}


def test_only_enabled_languages_are_listed() -> None:
    with ready_client(languages="a,e,f") as client:
        body = client.get("/v1/voices").json()
        codes = {v["lang_code"] for v in body["voices"]}
        assert codes == {"a", "e", "f"}
        spanish = next(v for v in body["voices"] if v["id"] == "ef_dora")
        assert spanish["preview_text"].startswith("Hola, soy Dora.")
        assert spanish["grade"] is None
        r = client.post("/v1/tts", json={"text": "Hola amigo.", "voice": "ef_dora"})
        assert parse_ndjson(r.text)[0]["lang"] == "e"


def test_preview_is_cached_with_etag_and_rate_limited_only_when_uncached() -> None:
    app = make_app(rate_limit_per_minute=1)
    with TestClient(app) as client:
        wait_ready(client)
        engine = app.state.engine
        r = client.get("/v1/voices/af_heart/preview")
        assert r.status_code == 200
        assert r.headers["content-type"] == "audio/wav"
        assert r.headers["cache-control"] == "private, max-age=86400"
        etag = r.headers["etag"]
        assert r.content[:4] == b"RIFF"
        calls = engine.calls
        again = client.get("/v1/voices/af_heart/preview")
        assert again.status_code == 200 and again.content == r.content
        assert engine.calls == calls  # served from the cache, not rate limited
        not_modified = client.get("/v1/voices/af_heart/preview", headers={"If-None-Match": etag})
        assert not_modified.status_code == 304
        # A different (uncached) preview now exceeds the 1/minute limit.
        limited = client.get("/v1/voices/af_bella/preview?format=mp3")
        assert limited.status_code == 429
        missing = client.get("/v1/voices/af_nope/preview")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "not_found"
        bad_blend = client.get("/v1/voices/af_heart+af_nope/preview")
        assert bad_blend.status_code == 400
        assert bad_blend.json()["error"]["code"] == "unknown_voice"


def test_blend_preview_is_cached_by_canonical_spec() -> None:
    app = make_app(rate_limit_per_minute=1)
    with TestClient(app) as client:
        wait_ready(client)
        engine = app.state.engine
        r = client.get("/v1/voices/af_heart(2)+af_sky(1)/preview")
        assert r.status_code == 200
        assert r.headers["content-type"] == "audio/wav"
        assert r.content[:4] == b"RIFF"
        calls = engine.calls
        # Same blend written differently (URL-encoded "+", spaces, equivalent weights): cache hit.
        same = client.get("/v1/voices/af_heart(4)%2B%20af_sky(2)/preview")
        assert same.status_code == 200 and same.content == r.content
        assert engine.calls == calls
        # A different mix is a different (uncached) preview and hits the 1/minute limit.
        assert client.get("/v1/voices/af_heart+af_sky/preview").status_code == 429
        too_many = client.get("/v1/voices/af_heart+af_sky+af_bella+af_nicole+am_adam/preview")
        assert too_many.status_code == 400


def test_mp3_preview() -> None:
    with ready_client() as client:
        r = client.get("/v1/voices/bf_emma/preview?format=mp3")
        assert r.status_code == 200
        assert r.headers["content-type"] == "audio/mpeg"
        assert not r.content.startswith(b"ID3") and len(r.content) > 1000
