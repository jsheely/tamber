"""Real Kokoro smoke test. Opt-in: TAMBER_TEST_MODEL=1 pytest -m model (needs requirements-tts.txt
and the model in the Hugging Face cache or network access to download it)."""

from __future__ import annotations

import base64
import time

import pytest
from fastapi.testclient import TestClient

from tamber_api.tts.kokoro_engine import KokoroEngine

from .conftest import make_settings, parse_ndjson

pytestmark = pytest.mark.model

TEXT = (
    "Hello world! Tamber reads “anything” to you, one word at a time. "
    "It costs $5,000 in 1990, e.g. at Dr. Smith's.\n\nA second paragraph."
)


@pytest.fixture(scope="module")
def model_client() -> TestClient:
    from tamber_api.main import create_app

    settings = make_settings(engine="kokoro", device="cpu", warmup=True)
    engine = KokoroEngine(settings.model_repo, settings.language_codes, "cpu", "af_heart")
    app = create_app(settings=settings, engine=engine)
    client = TestClient(app)
    client.__enter__()
    deadline = time.monotonic() + 600
    while client.get("/v1/health").json()["status"] == "loading":
        assert time.monotonic() < deadline, "model did not load in time"
        time.sleep(0.5)
    return client


def test_real_model_word_timings(model_client: TestClient) -> None:
    health = model_client.get("/v1/health").json()
    assert health["status"] == "ok" and health["engine"] == "kokoro"
    r = model_client.post("/v1/tts", json={"text": TEXT, "voice": "af_heart"})
    assert r.status_code == 200
    events = parse_ndjson(r.text)
    assert events[0]["type"] == "start" and events[-1]["type"] == "done"
    chunks = [e for e in events if e["type"] == "chunk"]
    assert chunks and events[-1]["chunks_failed"] == 0
    js = TEXT.encode("utf-16-le")
    all_words = []
    for c in chunks:
        assert base64.b64decode(c["audio"])[:4] == b"RIFF"
        assert c["words"], f"no word timings for chunk {c['index']}"
        prev = 0.0
        for w in c["words"]:
            assert w["text"] == js[w["char_start"] * 2 : w["char_end"] * 2].decode("utf-16-le")
            assert prev <= w["start"] <= w["end"] <= c["duration"]
            prev = w["end"]
        all_words.extend(w["text"] for w in c["words"])
    assert "Hello" in all_words and "anything" in all_words and "1990" in all_words


def test_real_model_blend_and_british(model_client: TestClient) -> None:
    r = model_client.post(
        "/v1/tts",
        json={"text": "Colour and flavour.", "voice": "bf_emma(2)+af_heart(1)", "stream": False},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["voice"] == "bf_emma(2)+af_heart(1)" and body["lang"] == "b"
    assert body["chunks"][0]["words"]


def test_real_model_concurrent_jobs_do_not_mix_texts() -> None:
    """With TAMBER_MAX_CONCURRENT_SYNTH > 1, two jobs share one KPipeline. Its G2P (misaki +
    espeak fallback) is not thread-safe: unguarded, concurrent calls return each other's words.
    The engine installs a serialized G2P on every pipeline; hammer it from several threads."""
    import threading

    engine = KokoroEngine("hexgrad/Kokoro-82M", ("a",), "cpu", "af_heart")
    engine.load()
    g2p = engine._pipelines["a"].g2p
    texts = [
        "Zorbluxian flimwaddle quantastic brimbleworth snazzlefrump.",
        "Grumpletonian wizzlebop fandangulous crinkleberry spoofmatic.",
        "Xylophonic brazzlewig tromboozle frinkadoodle mizzleshank.",
        "Plunderbuss wobblefritz scrumptulous fizzlewhack glimmerquist.",
    ]
    expected = {t: g2p(t)[0] for t in texts}
    outcomes: list[bool] = []

    def worker(offset: int) -> None:
        for k in range(30):
            text = texts[(offset + k) % len(texts)]
            outcomes.append(g2p(text)[0] == expected[text])

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(outcomes) == 180 and all(outcomes), f"{outcomes.count(False)} mixed-up results"
