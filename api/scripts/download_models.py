#!/usr/bin/env python3
"""Bake the Kokoro model and voices into the Hugging Face cache (run at `docker build` time).

Downloads `config.json`, `kokoro-v1_0.pth` and `voices/<lang>*.pt` for the requested languages
into `$HF_HOME` (the image uses /opt/tamber/hf) with `hf_hub_download`, the same cache layout that
`KModel` / `KPipeline.load_single_voice` read at runtime with `HF_HUB_OFFLINE=1`.

* Integrity: each file's size is checked against the hub metadata, plus its SHA-256 for LFS files
  (the weights and voices) or its git blob SHA-1 for small regular files (config.json).
* Atomicity: `hf_hub_download` streams into a temporary `*.incomplete` blob and renames it into
  place only when complete; a file that fails verification is deleted and downloaded once more.
* Idempotent: files already present and valid are not downloaded again.

Usage:
    python download_models.py [--repo hexgrad/Kokoro-82M] [--languages a,b] [--revision main]
Environment fallbacks: TAMBER_MODEL_REPO, TAMBER_LANGUAGES.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from pathlib import Path
from typing import Any

MODEL_FILES = ("config.json", "kokoro-v1_0.pth")
KNOWN_LANGUAGES = set("abefhipjz")


def _lfs_sha256(info: Any) -> str | None:
    lfs = getattr(info, "lfs", None)
    if lfs is None:
        return None
    sha = getattr(lfs, "sha256", None)
    if sha is None and isinstance(lfs, dict):
        sha = lfs.get("sha256")
    return str(sha) if sha else None


def _hash_file(path: Path, algorithm: str, prefix: bytes = b"") -> str:
    digest = hashlib.new(algorithm)
    digest.update(prefix)
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(path: Path, info: Any) -> str | None:
    """None when the file matches the hub metadata, else a reason."""
    size = path.stat().st_size
    expected_size = getattr(info, "size", None)
    if expected_size is not None and size != int(expected_size):
        return f"size {size} != {expected_size}"
    sha256 = _lfs_sha256(info)
    if sha256:
        actual = _hash_file(path, "sha256")
        return None if actual == sha256 else f"sha256 {actual} != {sha256}"
    blob_id = getattr(info, "blob_id", None)
    if blob_id:
        actual = _hash_file(path, "sha1", f"blob {size}\0".encode())
        return None if actual == blob_id else f"git blob sha1 {actual} != {blob_id}"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--repo", default=os.environ.get("TAMBER_MODEL_REPO", "hexgrad/Kokoro-82M"))
    parser.add_argument("--languages", default=os.environ.get("TAMBER_LANGUAGES", "a,b"))
    parser.add_argument("--revision", default="main")
    args = parser.parse_args(argv)

    from huggingface_hub import HfApi, hf_hub_download

    languages = sorted({c.strip().lower() for c in args.languages.split(",") if c.strip()})
    unknown = [c for c in languages if c not in KNOWN_LANGUAGES]
    if unknown:
        print(f"error: unknown language code(s): {', '.join(unknown)}", file=sys.stderr)
        return 2

    api = HfApi()
    repo_files = api.list_repo_files(args.repo, revision=args.revision)
    voices = sorted(
        f
        for f in repo_files
        if f.startswith("voices/") and f.endswith(".pt") and f[len("voices/") :][:1] in languages
    )
    if not voices:
        print(f"error: no voices found for languages {languages}", file=sys.stderr)
        return 2
    wanted = [*MODEL_FILES, *voices]
    infos = {i.path: i for i in api.get_paths_info(args.repo, wanted, revision=args.revision)}
    missing = [f for f in wanted if f not in infos]
    if missing:
        print(f"error: not in {args.repo}: {', '.join(missing)}", file=sys.stderr)
        return 2

    started = time.monotonic()
    total = 0
    for name in wanted:
        info = infos[name]
        for attempt in (1, 2):
            path = Path(
                hf_hub_download(
                    args.repo, name, revision=args.revision, force_download=attempt == 2
                )
            )
            problem = verify(path, info)
            if problem is None:
                break
            print(f"warning: {name} failed verification ({problem}); retrying", file=sys.stderr)
            real = path.resolve()
            real.unlink(missing_ok=True)
            if path.is_symlink():
                path.unlink(missing_ok=True)
        else:
            print(f"error: {name} failed verification twice ({problem})", file=sys.stderr)
            return 1
        total += path.stat().st_size
        print(f"ok  {name}  ({path.stat().st_size / 1e6:.1f} MB)")
    print(
        f"{len(wanted)} files ({total / 1e6:.0f} MB) verified in {time.monotonic() - started:.0f}s"
        f" -> {os.environ.get('HF_HOME', '~/.cache/huggingface')}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
