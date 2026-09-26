# Tamber API

The Tamber server: a FastAPI service that runs [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
text-to-speech, streams speech as **self-contained audio chunks with word timings**, extracts
readable text from URLs and documents, speaks the OpenAI `audio/speech` API, and serves the built
web UI. It ships as one Docker image.

- HTTP contract (normative): [`docs/API.md`](../docs/API.md)
- Architecture: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- Every environment variable, with defaults: [`.env.example`](../.env.example)

## How streaming works (and why it works on iOS)

`POST /v1/tts` validates the request and plans the chunks (the deterministic planner in
`tamber_api/tts/chunking.py`, a port of `packages/client/src/chunking.ts`). It then streams NDJSON:
one `start` line with the whole plan, then one `chunk` line per chunk, each carrying a **complete,
independently decodable WAV (or MP3) file** in base64, the word timings from Kokoro's own
`KPipeline` tokens (`start_ts` / `end_ts`), and UTF-16 character offsets into the exact text you
sent. Clients decode each chunk with `decodeAudioData` and schedule them back to back. Nothing
uses MediaSource, which iOS Safari lacks.

```
{"type":"start","total_chunks":2,"chunks":[{"index":0,"char_start":0,"char_end":12},...],...}
{"type":"chunk","index":0,"text":"Hello world.","audio":"UklGR...","duration":1.06,"words":[{"text":"Hello","start":0.0,"end":0.33,"char_start":0,"char_end":5},...]}
{"type":"chunk","index":1,...}
{"type":"done","total_duration":2.771,"chunks_sent":2,"chunks_failed":0,"elapsed_ms":1893}
```

## Layout

```
tamber_api/
  main.py          create_app(settings=None, engine=None) + module-level `app`
  __main__.py      container entrypoint (python -m tamber_api -> uvicorn, 1 worker)
  config.py        Settings (TAMBER_*), unknown-key warnings
  errors.py        error envelope + handlers (422 -> 400)
  middleware.py    request id, version header, CORS, HEAD, body limits, catch-all 500
  auth.py          optional bearer / X-API-Key auth (constant-time)
  ratelimit.py     in-process sliding window per key or IP
  routes/          health, voices, tts, extract, openai, static
  tts/             chunking, offsets, words, voices, engine (Fake), kokoro_engine, audio, service
  extract/         url (fetch), ssrf, html (trafilatura + bs4), files (pdf/docx/epub/md/txt), normalize
scripts/download_models.py   bakes model + voices into the HF cache (Docker build)
tests/                       pytest suite (fake engine) + opt-in real-model tests
```

## Local development

Python 3.10-3.12 (Kokoro does not support 3.13 yet). Commands are for Windows PowerShell; on
macOS/Linux use `.venv/bin/python`.

```powershell
cd api
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
```

### Fake engine (no torch, no model)

The fake engine produces a soft tone per word with evenly spaced word timings. Everything else
(auth, chunk plan, offsets, WAV/MP3, errors, pings, cancellation) behaves exactly like production,
so client work never needs the model.

```powershell
$env:TAMBER_ENGINE = 'fake'
.venv\Scripts\python -m uvicorn tamber_api.main:app --reload --port 8880
```

```sh
curl -s localhost:8880/v1/health
curl -sN -H 'Content-Type: application/json' -d '{"text":"Hello world. This is Tamber."}' localhost:8880/v1/tts
```

### Real Kokoro engine

```powershell
.venv\Scripts\python -m pip install -r requirements-tts.txt     # CPU torch from download.pytorch.org
.venv\Scripts\python -m spacy download en_core_web_sm            # else misaki fetches it at first use
.venv\Scripts\python scripts\download_models.py --languages a,b  # optional: pre-fetch ~330 MB
$env:TAMBER_ENGINE = 'kokoro'
.venv\Scripts\python -m uvicorn tamber_api.main:app --port 8880
```

`requirements-tts.txt` pins `torch==2.14.0+cpu`, which exists for Windows and Linux only. On macOS
install `torch==2.14.0` from PyPI first, then `kokoro==0.9.4 "misaki[en]==0.9.4"`.

`/v1/health` reports `"status": "loading"` until the model has loaded and warmed up (a few
seconds on a modern CPU); TTS requests get `503 model_loading` with `Retry-After: 5` meanwhile.
Without `HF_HUB_OFFLINE=1`, voices that aren't cached yet are downloaded on first use; with it, only
cached voices are listed.

The web UI dev server (`pnpm dev:web`, or `pnpm dev` for API + web together) proxies `/v1` to port 8880. To serve a built UI from
this server, point `TAMBER_WEB_DIR` at `web/dist`.

## Configuration

All settings are `TAMBER_*` environment variables (or a `.env` file in `api/` or the repo root),
documented in [`.env.example`](../.env.example). Unknown `TAMBER_*` keys are logged as warnings,
never fatal. The ones you'll usually touch:

| Variable | Default | Notes |
|---|---|---|
| `TAMBER_API_KEY` | empty | One or more comma-separated keys. Empty = no auth. |
| `TAMBER_CORS_ORIGINS` | `*` | `*`, an exact allow-list, or empty to disable CORS. |
| `TAMBER_ENGINE` | `kokoro` | `fake` for model-free development. |
| `TAMBER_LANGUAGES` | `a,b` | Kokoro language codes (English has word timings). |
| `TAMBER_DEVICE` | `auto` | `cuda` > `mps` > `cpu` when `auto`. |
| `TAMBER_WEB_DIR` | `/app/web` | Built web UI; empty/missing = JSON banner at `/`. |

Logs never contain API keys or request text; they carry request ids, lengths, voice, chunk
counts and timings.

## Docker

The `Dockerfile` lives at the **repo root** and uses it as the build context (the image also
builds `packages/client` and `web/`). From the repo root:

```sh
docker build -t tamber .
docker run -d --name tamber -p 8880:8880 --env-file .env tamber
```

- `--build-arg WEB_STAGE=web-empty` builds an API-only image without the web UI.
- `--build-arg TAMBER_LANGUAGES=a,b,e,f` bakes more voices (keep `TAMBER_LANGUAGES` in sync).
- `--build-arg TORCH_VARIANT=cu130` builds a CUDA image (NVIDIA driver >= 580; `cu126` for older
  drivers). torch 2.14.0 is published for `cpu`, `cu126`, `cu130` and `cu132`, not `cu128`;
  channels rotate, so check <https://download.pytorch.org/whl/> when bumping torch. Run it with
  `--gpus all`.

The image installs CPU torch from the PyTorch index, the spaCy English model, and downloads and
verifies (size + SHA-256) the model and voices into `/opt/tamber/hf` at build time. It then runs
offline (`HF_HUB_OFFLINE=1`) as the non-root user `tamber` (uid 1000) on port 8880, with a
`HEALTHCHECK` on `/v1/health`. Expect about 3 GB for the CPU image (measured: 3.0 GB with the
English voices; torch, spaCy and the 342 MB of model + voices dominate).

With Compose (from the repo root; `docker-compose.yml` reads an optional `./.env`):

```sh
docker compose up -d --build                           # CPU
docker compose --profile gpu up -d --build tamber-gpu  # NVIDIA GPU (instead of the CPU service)
```

## Behind NetBird (dedicated HTTPS URL)

Expose the container through the NetBird reverse proxy at its own hostname (for example
`https://tts.example.com`); keep `TAMBER_ROOT_PATH` empty. Then:

- set `TAMBER_API_KEY` (clients send `Authorization: Bearer <key>`; `/v1/health` stays open);
- **disable response buffering** and compression for `application/x-ndjson`, and allow a read
  timeout of at least 60 s (the server pings every 15 s on idle streams and sends
  `X-Accel-Buffering: no`);
- allow request bodies of at least `TAMBER_MAX_UPLOAD_MB`;
- forward `X-Forwarded-For` / `X-Forwarded-Proto`. The container trusts them from any peer
  (`TAMBER_FORWARDED_ALLOW_IPS=*`), which is right when only the proxy can reach it; set the proxy's
  address otherwise. Rate limits key on the API key, so traffic from one proxy IP is fine.

Check it end to end: `curl -N` a long `/v1/tts` through the proxy and confirm the lines arrive one
by one rather than all at the end.

## Tests and checks

```powershell
.venv\Scripts\python -m ruff check .
.venv\Scripts\python -m ruff format --check .
.venv\Scripts\python -m mypy tamber_api
.venv\Scripts\python -m pytest -q
```

The suite runs on the fake engine and covers chunk-planner conformance with
`packages/client/fixtures/chunking.json`, the NDJSON grammar and word/offset invariants, WAV
headers and per-chunk MP3 decodability, resume, queueing, cancellation, auth, CORS, the error
envelope, rate limits, extraction (txt/md/html/docx/pdf/epub, SSRF, redirects, truncation), the
OpenAI routes and static serving.

Real-model tests (needs `requirements-tts.txt`; downloads the model if it isn't cached):

```powershell
$env:TAMBER_TEST_MODEL = '1'
.venv\Scripts\python -m pytest -q -m model
```
