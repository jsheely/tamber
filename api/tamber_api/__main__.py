"""Container entrypoint: `python -m tamber_api`.

Reads TAMBER_HOST / TAMBER_PORT / TAMBER_FORWARDED_ALLOW_IPS / TAMBER_LOG_LEVEL and runs uvicorn
with proxy headers, a 75 s keep-alive and ONE worker (one model in memory). TAMBER_ROOT_PATH is
applied by the app itself (FastAPI `root_path`), so it also works with a plain `uvicorn` command.
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    host = os.environ.get("TAMBER_HOST", "0.0.0.0") or "0.0.0.0"
    port = int(os.environ.get("TAMBER_PORT", "8880") or "8880")
    forwarded = os.environ.get("TAMBER_FORWARDED_ALLOW_IPS", "*") or "*"
    log_level = (os.environ.get("TAMBER_LOG_LEVEL", "info") or "info").lower()
    uvicorn.run(
        "tamber_api.main:app",
        host=host,
        port=port,
        proxy_headers=True,
        forwarded_allow_ips=forwarded,
        timeout_keep_alive=75,
        workers=1,
        log_level=log_level,
        server_header=False,
    )


if __name__ == "__main__":
    main()
