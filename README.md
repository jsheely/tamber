<p align="center">
  <img src="assets/brand/icon.svg" width="96" height="96" alt="Tamber icon" />
</p>

<h1 align="center">Tamber</h1>

<p align="center"><b>Self-hosted text-to-speech that highlights every word as it's spoken.</b><br/>
Kokoro-82M in one Docker container, a web app that streams on iPhone too, a Chrome extension, and a mobile app.</p>

---

<!-- Screenshots: add real captures here (none are committed yet).
     docs/screenshots/web-reader.png      web reader, word highlight mid-sentence (iPhone width)
     docs/screenshots/web-voices.png      voice drawer with blend editor
     docs/screenshots/extension.png       side panel reader + in-page mini-player
     docs/screenshots/mobile-player.png   mobile player after sharing a web page -->
| Web reader | Voices | Chrome extension | Mobile |
|---|---|---|---|
| _screenshot pending_ | _screenshot pending_ | _screenshot pending_ | _screenshot pending_ |

## What it is

Tamber turns text, web pages and documents (PDF, DOCX, EPUB, HTML, Markdown, TXT) into natural speech with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), running entirely on your own hardware. It replaces [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI):

- **Streams on iOS Safari.** The server sends audio sentence by sentence as small, self-contained WAV (or MP3) chunks inside an NDJSON stream. Clients decode each chunk with Web Audio and schedule them back to back. Nothing uses MediaSource, which iOS Safari does not support.
- **Karaoke-style word highlighting** driven by Kokoro's own word timings (English), with character offsets into your exact text. You can tap any word to seek to it.
- **One container, four clients.** The API also serves the web UI. The Chrome extension reads any selection aloud, and the mobile app reads anything you share to it.
- **Drop-in OpenAI-compatible** `/v1/audio/speech` on port 8880, so existing Kokoro-FastAPI integrations keep working.
- **Remembers your settings** (server, voice, speed, format, theme and more) in every client.

## Architecture

```
  iPhone / desktop browser        Chrome extension           Expo app (iOS / Android)      OpenAI-compatible tools
  (web UI, PWA)                   (offscreen audio,          (share sheet → read aloud)    (Open WebUI, SDKs…)
          │                        side panel, mini-player)          │                              │
          └───────────────┬───────────────┴──────────────────────────┴──────────────────────────────┘
                          │  HTTPS  (dedicated URL via NetBird reverse proxy, optional bearer key)
                ┌─────────▼──────────────────────────────────────────────────────────────┐
                │  tamber container :8880                                                  │
                │   FastAPI ── /v1/tts  → NDJSON: {start} {chunk: wav+words}… {done}       │
                │           ── /v1/extract, /v1/voices, /v1/health, /v1/audio/speech       │
                │           ── static web UI (Vite build)                                  │
                │   Kokoro-82M (PyTorch, CPU or CUDA) · voices baked in · runs offline     │
                └──────────────────────────────────────────────────────────────────────────┘
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · HTTP contract: [docs/API.md](docs/API.md) · Build and verification status: [docs/STATUS.md](docs/STATUS.md)

## Repository

| Path | What | Docs |
|---|---|---|
| [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml) | One image: API plus the built web UI (build context = repo root) | this file, [`api/README.md`](api/README.md) |
| [`api/`](api/) | FastAPI + Kokoro service | [`api/README.md`](api/README.md) |
| [`web/`](web/) | Vite + React + Mantine web app / PWA | [`web/README.md`](web/README.md) |
| [`extension/`](extension/) | Chrome MV3 extension (WXT) | [`extension/README.md`](extension/README.md) |
| [`mobile/`](mobile/) | Expo (React Native) app | [`mobile/README.md`](mobile/README.md) |
| [`packages/client/`](packages/client/) | `@tamber/client`: shared types, API client, settings model, chunk planner, timeline | [`packages/client/README.md`](packages/client/README.md) |
| [`assets/brand/`](assets/brand/) | Icon masters and brand guide | [`assets/brand/BRAND.md`](assets/brand/BRAND.md) |
| [`docs/`](docs/) | Architecture, API contract, status, research | |

## Quick start (Docker)

```sh
cp .env.example .env                  # optional; every variable has a default
docker compose up -d --build          # builds the image (about 3 GB) and starts it on :8880
# open http://localhost:8880
```

Without Compose:

```sh
docker build -t tamber .
docker run -d --name tamber --env-file .env -p 8880:8880 --restart unless-stopped tamber
```

The first build downloads PyTorch (CPU), spaCy, and the Kokoro model and voices, and verifies each file. After that the container runs **offline**. It starts in a few seconds; `/v1/health` reports `"status":"loading"` until the model is warm, then `"ok"`, and Docker's HEALTHCHECK turns `healthy`.

### NVIDIA GPU

The CPU image works everywhere. On a machine with an NVIDIA card, build the CUDA image and give the container the GPU; synthesis is several times faster and can run a couple of jobs in parallel.

**1. Host prerequisites**

- **Linux:** the NVIDIA driver plus the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). After installing it, register it with Docker once: `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
- **Windows (Docker Desktop, WSL 2 backend):** only the regular Windows NVIDIA driver is needed. Docker Desktop passes the GPU through; do not install a driver inside WSL.
- **Pick the CUDA channel from your driver.** `nvidia-smi` prints the highest CUDA version the driver supports (top right). `TORCH_VARIANT=cu130` (the default for the GPU service) needs driver >= 580. Use `cu126` for older drivers (note: no RTX 50-series support there). torch 2.14.0 publishes `cpu`, `cu126`, `cu130` and `cu132`; there is **no `cu128`** build.
- **Check the passthrough works** before building anything:

  ```sh
  docker run --rm --gpus all ubuntu nvidia-smi
  ```

  If that prints your GPU, Docker can hand it to Tamber.

**2. With Compose (recommended)**

```sh
docker compose --profile gpu up -d --build tamber-gpu
```

The `tamber-gpu` service builds with `TORCH_VARIANT=cu130`, sets `TAMBER_DEVICE=cuda` and `TAMBER_MAX_CONCURRENT_SYNTH=2`, and reserves every NVIDIA GPU through `deploy.resources.reservations.devices`, which is Compose's equivalent of `docker run --gpus all`. Edit the `TORCH_VARIANT` build arg in `docker-compose.yml` if you need `cu126`. Run either the CPU service or the GPU one, not both (they share port 8880).

**3. Without Compose**

```sh
docker build --build-arg TORCH_VARIANT=cu130 -t tamber:cuda .
docker run -d --name tamber --gpus all   -e TAMBER_DEVICE=cuda -e TAMBER_MAX_CONCURRENT_SYNTH=2   --env-file .env -p 8880:8880 --restart unless-stopped tamber:cuda
```

`--gpus all` is what makes the card visible inside the container; without it a CUDA image still starts but has no GPU. Setting `TAMBER_DEVICE=cuda` explicitly (rather than `auto`) is deliberate: if the GPU is missing, the model load fails and the container exits with a clear error in `docker logs tamber`, instead of quietly running on the CPU. Drop `--env-file .env` if you have no `.env`.

**4. Confirm it is using the GPU**

```sh
curl -s localhost:8880/v1/health      # look for "device":"cuda"
docker exec tamber nvidia-smi         # the python process appears in the process list
```

**API only (no web UI):** `docker build --build-arg WEB_STAGE=web-empty -t tamber:api-only .`

### Environment variables

All variables are documented in [`.env.example`](.env.example). The ones you're most likely to change:

| Variable | Default | What |
|---|---|---|
| `TAMBER_API_KEY` | _(empty = no auth)_ | Bearer key(s), comma-separated. Clients send `Authorization: Bearer <key>` (or `X-API-Key`). `/v1/health` and the static UI stay open. |
| `TAMBER_CORS_ORIGINS` | `*` | `*`, a comma-separated allow-list, or empty to disable CORS. |
| `TAMBER_DEFAULT_VOICE` | `af_heart` | Voice id or blend such as `af_heart(2)+af_bella(1)`. |
| `TAMBER_LANGUAGES` | `a,b` | Enabled languages. Voices are baked in at build time via the build arg of the same name, so keep the two in sync. |
| `TAMBER_DEVICE` | `auto` | `auto`, `cpu`, `cuda` or `mps`. |
| `TAMBER_MAX_CONCURRENT_SYNTH` | `1` | Parallel synthesis jobs. Keep 1 on CPU. |
| `TAMBER_RATE_LIMIT_PER_MINUTE` | `60` | Per API key (else per IP), on POST routes. `0` = off. |
| `TAMBER_MAX_TEXT_CHARS` | `100000` | Longest text accepted by `/v1/tts`. |
| `TAMBER_FORWARDED_ALLOW_IPS` | `*` | Proxies whose `X-Forwarded-*` headers are trusted. |

## Deploying behind NetBird

Tamber is designed to sit behind a NetBird reverse-proxy route at its **own HTTPS hostname**, for example `https://tts.example.com`:

```
phone / laptop / extension ──HTTPS──▶ NetBird reverse proxy (https://tts.example.com) ──HTTP──▶ tamber:8880
```

1. **Dedicated URL.** Point a NetBird reverse-proxy route with its own hostname and TLS at the container's port 8880. Serve Tamber at the root of that hostname (leave `TAMBER_ROOT_PATH` empty). The web UI is then same-origin with the API and needs no configuration.
2. **Set an API key.** The service is reachable from every peer on the mesh, so set `TAMBER_API_KEY` (generate one with `python -c "import secrets; print(secrets.token_urlsafe(32))"`). Comma-separate several keys to give each device its own. The web UI asks for the key on first use and stores it locally.
3. **Set CORS origins.** Browser pages on other origins need CORS. Restrict it to what you use, for example `TAMBER_CORS_ORIGINS=https://tts.example.com`. Add `chrome-extension://<extension-id>` if your extension's requests are rejected. Extension pages with the granted host permission and the native mobile app normally don't need CORS. The default `*` is safe (auth is a header, never a cookie) but broader than necessary.
4. **Keep streaming unbuffered.** For `/v1/tts`, turn proxy buffering off, don't compress `application/x-ndjson`, and allow a read/idle timeout of at least 60 s (the server pings every 15 s). Allow request bodies of at least `TAMBER_MAX_UPLOAD_MB` (25 MB by default) for document uploads, and pass `X-Forwarded-For` / `X-Forwarded-Proto`.
5. **Check it.** `curl -N -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"text":"One. Two. Three. Four."}' https://tts.example.com/v1/tts | cut -c1-120`. Lines must arrive one by one, not all at the end. This has not yet been checked against a real NetBird proxy (see [docs/STATUS.md](docs/STATUS.md)).

## Pointing each client at the server

| Client | Where | Server URL | API key |
|---|---|---|---|
| **Web UI** | open `https://tts.example.com` | Nothing to set (same origin). To use a different server, go to **Settings → Server**. | **Settings → API key** (opens automatically on a 401) |
| **Chrome extension** | **Options → Server** | `https://tts.example.com` (Chrome then asks for permission to access that origin) | **Options → API key** (stored in `chrome.storage.local`, never synced) |
| **Mobile app** | onboarding on first launch, later **Settings** | `https://tts.example.com` | same screen (stored in the secure keychain/keystore) |
| **OpenAI-compatible tools** | base URL `https://tts.example.com/v1` | | the key as the OpenAI API key |

Every client accepts `tts.example.com`, `https://tts.example.com/` or `.../v1` and normalises it. **Test connection** reports whether the server is reachable, whether the key is accepted, the server version and the voice count.

## Chrome extension (load unpacked)

```sh
pnpm install
pnpm build:extension                # -> extension/.output/chrome-mv3/
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `extension/.output/chrome-mv3`.
3. The Options page opens: enter the server URL and key, then click **Save** and allow the permission prompt.
4. Select text on any page and choose **Read with Tamber** from the context menu, or press **Alt+Shift+R**. **Alt+Shift+P** toggles play/pause and **Alt+Shift+S** stops.

`pnpm zip:extension` produces `extension/.output/tamber-0.1.0-chrome.zip` for sharing.

## Mobile app (Expo)

The app uses native modules (share-sheet targets, MMKV, background audio), so it runs as a **development build**, not in Expo Go. See [`mobile/README.md`](mobile/README.md) for details.

```sh
pnpm install                                 # mobile/ is a workspace member; nothing else to build
```

- **Android (local):** needs Android Studio (SDK, emulator or a USB device) and JDK 17. Run `cd mobile && pnpm exec expo run:android`, then `pnpm dev:mobile` for later JS-only changes.
- **iOS (EAS Build in the cloud):** `pnpm add -g eas-cli && eas login`, then `cd mobile && eas build --profile development --platform ios` (register the phone with `eas device:create`). Install the build and run `pnpm dev:mobile` on your computer. Before the first build, EAS creates the bundle id `net.thirtytech.tamber` and the App Group `group.net.thirtytech.tamber`. Release builds use `--profile preview` (internal) or `production` (store).
- Share a web page, a document or text to **Tamber** from the OS share sheet, or paste text in the app.

## Development

```sh
pnpm install                       # every workspace: packages/client, web, extension, mobile

# API venv (add -r requirements-tts.txt for the real Kokoro engine)
cd api && python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt -r requirements-tts.txt && cd ..

pnpm dev                           # API (real engine, :8880) + web dev server (:5173) in one terminal
pnpm dev:fake                      # the same with the fake engine (tones + synthetic word timings; no model needed)

pnpm dev:api                       # API only (pnpm dev:api:fake for the fake engine)
pnpm dev:web                       # web only: http://localhost:5173, proxies /v1 to :8880
pnpm dev:ext                       # WXT watch build; load extension/.output/chrome-mv3-dev unpacked
pnpm dev:mobile                    # Metro for the mobile dev client
pnpm build                         # builds every workspace
```

`@tamber/client` needs no build step during development: its `package.json` exports a `source` condition that Vite (web, extension), Metro (mobile), vitest and tsc resolve first, so edits under `packages/client/src` hot-reload in every app.

On macOS/Linux use `.venv/bin/python`. For the real engine install `-r requirements-tts.txt` as well. Note that the `torch==2.14.0+cpu` pin has no macOS wheel, so on a Mac install torch from PyPI.

**Checks:**

- JS (all workspaces, including mobile): `pnpm typecheck && pnpm lint && pnpm test`
- Python (in `api/`): `.venv/Scripts/python -m ruff check . && .venv/Scripts/python -m mypy tamber_api && .venv/Scripts/python -m pytest -q`

**TypeScript toolchain note:** web and extension run TypeScript 7 for typechecking (as the `typescript-native` alias, via `scripts/tsc.mjs`), while ESLint uses a local TypeScript 6.0 because typescript-eslint does not support TS 7 yet. See [`web/README.md`](web/README.md#toolchain-note-typescript-7--typescript-eslint).

## Limitations

- Word-level highlighting is English only (a Kokoro limitation). Other languages highlight by sentence. Japanese and Chinese are not in the default image.
- CPU synthesis speed depends heavily on hardware. The first sentence is sent on its own so playback starts quickly (about 0.4 s to first audio on a desktop CPU).
- Nothing has run on a real iPhone or Android device yet. See [docs/STATUS.md](docs/STATUS.md) for what is verified and what is not.

## License

Not yet chosen (`UNLICENSED`). The Kokoro-82M weights are Apache-2.0, and the dependencies avoid AGPL (pypdf rather than PyMuPDF).
