"""Serving the built web UI (docs/API.md §10)."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from .conftest import ready_client

HTML = {"Accept": "text/html,application/xhtml+xml"}


@pytest.fixture
def web_dir(tmp_path: Path) -> Path:
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>Tamber</title>", encoding="utf-8")
    (root / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (root / "sw.js").write_text("self.x=1", encoding="utf-8")
    (root / "workbox-5f1e2d.js").write_text("wb", encoding="utf-8")
    (root / "manifest.webmanifest").write_text('{"name":"Tamber"}', encoding="utf-8")
    (root / "icon-192.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (tmp_path / "secret.txt").write_text("nope", encoding="utf-8")
    return root


@pytest.fixture
def web_client(web_dir: Path) -> Iterator[TestClient]:
    with ready_client(web_dir=str(web_dir)) as client:
        yield client


def test_index_and_assets_cache_headers(web_client: TestClient) -> None:
    r = web_client.get("/", headers=HTML)
    assert r.status_code == 200 and "Tamber" in r.text
    assert r.headers["cache-control"] == "no-cache"
    assert r.headers["content-type"].startswith("text/html")
    a = web_client.get("/assets/index-abc123.js")
    assert a.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert a.headers["content-type"].startswith("text/javascript")
    assert web_client.get("/sw.js").headers["cache-control"] == "no-cache"
    assert web_client.get("/workbox-5f1e2d.js").headers["cache-control"] == "no-cache"
    m = web_client.get("/manifest.webmanifest")
    assert m.headers["content-type"] == "application/manifest+json"
    assert m.headers["cache-control"] == "no-cache"
    icon = web_client.get("/icon-192.png")
    assert icon.headers["cache-control"] == "public, max-age=3600"
    assert icon.headers["content-type"] == "image/png"
    assert web_client.head("/assets/index-abc123.js").status_code == 200


def test_spa_fallback_only_for_html(web_client: TestClient) -> None:
    r = web_client.get("/reader/some/deep/link", headers=HTML)
    assert r.status_code == 200 and "Tamber" in r.text
    assert r.headers["cache-control"] == "no-cache"
    r = web_client.get("/missing.js", headers={"Accept": "*/*"})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_v1_is_never_the_spa(web_client: TestClient) -> None:
    for path in ("/v1/unknown", "/v1", "/v1/voices/x/y/z"):
        r = web_client.get(path, headers=HTML)
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/json")
        assert r.json()["error"]["code"] == "not_found"
    r = web_client.get("/v1/tts", headers=HTML)
    assert r.status_code == 405
    assert web_client.get("/v1/health").json()["status"] == "ok"
    assert web_client.get("/docs").status_code == 200


def test_no_path_traversal(web_client: TestClient) -> None:
    for path in ("/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt"):
        r = web_client.get(path)
        assert "nope" not in r.text


def test_banner_without_web_dir(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    with ready_client(web_dir=str(empty)) as client:
        r = client.get("/")
        assert r.json() == {"name": "Tamber", "api": "/v1", "docs": "/docs"}
        assert client.get("/something", headers=HTML).status_code == 404
    with ready_client(web_dir="") as client:
        assert client.get("/").json()["api"] == "/v1"
