# Tamber build status

Snapshot as of 2026-09-26, written at integration. Each app was built by one agent and then checked by a separate verifier, and the integration step checked all of them together. This page lists what exists, how it was checked, and what is still open.

## Summary

| Part | Implemented | Automated checks | Ran for real | Not yet verified |
|---|---|---|---|---|
| `api/` | Complete to docs/API.md | ruff, strict mypy, pytest **168 passed / 3 skipped** (the real-model tests pass when opted in) | Docker image built and run; real Kokoro streamed, auth, CORS, UI serving | NetBird proxy buffering, GPU image |
| `packages/client` | Complete | node:test **22 passed** | Used by every client against the live API | |
| `web/` | Complete | typecheck, lint, vitest **40 passed / 2 opt-in skipped**, build | Headless Chrome with iPhone-size emulation against the API (27/27 + 11/11 end-to-end checks) | Real iPhone: silent switch, lock screen, interruptions, PWA install |
| `extension/` | Complete | typecheck, lint, vitest **72 passed / 4 opt-in skipped**, build, zip | Chrome 154 loaded the build and played audio from a mock server (before the verifier's fixes) | Load unpacked by hand, permission prompt, mini-player on real pages, re-test after fixes |
| `mobile/` | Complete | tsc, expo lint, jest **58 passed**, expo-doctor 21/21, Android export, one local `gradlew assembleDebug` | Never launched | Everything on device: playback, background audio, lock screen, share sheet, iOS build |
| Docker | Root `Dockerfile` + `docker-compose.yml` | `docker build -t tamber:dev .` **passed**, `docker compose config` valid | Container healthy, `/v1/health` ok, UI at `/` | `cu130` GPU variant |

## Contract and hard constraints (checked across all apps)

- **No MediaSource / SourceBuffer** in any source or built bundle. web, extension and mobile each have a test that scans their sources, and mobile's ESLint config bans them.
- **NDJSON chunk shape** is identical in docs/API.md, `packages/client/src/types.ts` and the server. At integration, live `/v1/health`, `/v1/voices`, `/v1/extract` and the error envelope were compared key by key with `types.ts`: nothing missing and nothing extra. A real `/v1/tts` chunk has exactly the `TtsChunkEvent` fields. The optional `words_estimated: true` field was added to API.md and `types.ts`.
- **Word timings** come from Kokoro's `KPipeline` tokens (`start_ts` / `end_ts`) and are mapped to UTF-16 offsets into the exact submitted text. In the container, every word satisfied `text.slice(char_start, char_end) === word.text`, including after an emoji and a curly apostrophe.
- **Settings:** every client uses the `@tamber/client` settings model and `migrateSettings()` under the key `tamber.settings`:

  | Client | Settings | API key |
  |---|---|---|
  | web | `localStorage` | stored with the settings |
  | extension | `chrome.storage.sync` | `chrome.storage.local` (`tamber.secrets`) |
  | mobile | MMKV | secure storage (`tamber.apiKey`) |

- **Auth:** every client sends `Authorization: Bearer <key>` through `TamberClient`. The server also accepts `X-API-Key`.
- **Port:** 8880 everywhere (server default, Docker `EXPOSE`, compose, the web dev proxy, docs).
- **Voice blend syntax** (`af_heart(2)+af_bella(1)`): all clients use `parseVoiceSpec` / `formatVoiceSpec` / `canonicalVoiceSpec` from `@tamber/client`. The server's parser is a port of the same grammar, and the server echoed the canonical spec in the container test.
- **Brand:** the icons in `web/public`, `extension/public/icons` and `mobile/assets` are byte-identical to `assets/brand/`. They are referenced as BRAND.md prescribes: favicon and apple-touch-icon, PWA manifest icons 192/512/maskable, extension manifest icons 16/32/48/128, and the Expo icon, adaptive icon (with monochrome) and splash on `#0F0D1C`.

## Per app

### api/ (FastAPI + Kokoro)

**Implemented:**

- Routes: `/v1/health`, `/v1/voices` (blends, cached and ETagged previews), NDJSON `/v1/tts`, `/v1/extract`, and the OpenAI-compatible `/v1/audio/speech`, `/v1/models` and `/v1/audio/voices`.
- `/v1/tts` details: per-chunk WAV/MP3, real word timings, `start_chunk` resume, `stream:false`, queue events, pings, and cancellation on disconnect.
- `/v1/extract` accepts a URL (with an SSRF guard), HTML, or a PDF/DOCX/EPUB/MD/TXT/HTML upload.
- Security and limits: bearer auth, CORS from env, rate limiting, body-size limits, and one error envelope for every failure.
- The static web UI with an SPA fallback that never shadows `/v1`.

**Verified:**

- ruff, strict mypy and pytest pass: 168 passed and 3 real-model tests skipped by default. With `TAMBER_TEST_MODEL=1` the real-model tests pass too.
- The Python chunk planner matched the TypeScript planner on 2000 random texts, and an offset fuzz covered about 114k words.

**Fixed by the verifier:**

- An abandoned non-streaming request no longer keeps synthesizing while holding the only slot.
- A G2P thread-safety race that swapped words between concurrent jobs.
- An encoder close-during-write race.
- A slot released too early on cancellation.
- The GPU variant pinned a torch wheel that doesn't exist; it now uses `cu130` instead of `cu128`.
- NDJSON lines could contain raw U+2028 / U+2029 / U+0085 characters, which many line splitters treat as line breaks.

**Integration run** of `tamber:dev` (3.02 GB) with a key and a CORS allow-list:

- **Startup:** health went `ok` in about 8 s, Docker's HEALTHCHECK turned `healthy`, and the container runs as uid 1000.
- **UI:** `/` serves the web UI, and the manifest, service worker, favicon and icons have the right types.
- **Auth:** 401 without a key or with a wrong one; 200 with `Bearer` or `X-API-Key`.
- **CORS:** the allowed origin gets `Access-Control-Allow-Origin`; another origin's preflight gets a 400.
- **Routing:** an unknown `/v1` path returns a JSON 404.
- **Streaming:** a real Kokoro stream with a blended voice returned its first chunk after 0.36 s. Lines arrived one by one, and WAV durations were exact.

### packages/client (`@tamber/client`)

Contract types, `TamberClient` (NDJSON streaming, extract, previews, test connection), settings model and migration, chunk planner (with shared fixtures), `TimelineBuilder`, `concatWav`, and brand tokens. **Integration fix:** `send()` used to unlink the caller's `AbortSignal` from `fetch` once response headers arrived, so aborting a stream took effect only when the next NDJSON line came in. The signal now stays linked while the body is read, with a regression test. The web and mobile workarounds are kept as defence in depth.

### web/ (Vite + React + Mantine PWA)

**Implemented:**

- **Player:** `ChunkedPlayer` (decodeAudioData, gapless scheduling on the AudioContext clock), a synchronous iOS unlock, backpressure on long texts (at most 10 minutes buffered ahead), and stall timeouts.
- **Reader:** a karaoke reader (one spring-animated pill, sentence wash, tap-to-seek, auto-scroll).
- **Screens:** composer and import (URL and files), voice drawer with previews and a blend editor, and settings.
- **Visuals and platform:** orb, waveform and progress visuals; MediaSession; PWA.
- **Persistence:** settings, draft and history are kept across reloads.

**Verified** in headless Chrome with iPhone-sized emulation and real taps against the API, with and without a key (see the verifier's harness).

### extension/ (Chrome MV3, WXT)

**Implemented:**

- **Entry points:** context menus (selection, page, link) and shortcuts (Alt+Shift+R/P/S).
- **Playback:** an offscreen audio engine with the shared-design `ChunkedPlayer` and a memory bound.
- **UI:** side-panel reader with highlighting, popup, options page (server with a runtime host-permission request, key, voice library, blends), and an on-demand shadow-DOM mini-player.
- **Settings:** `chrome.storage.sync` for settings, with the key in `chrome.storage.local`.
- **Manifest:** no static host permissions, content scripts or web-accessible resources.

**Verified:**

- Unit and jsdom tests, plus an opt-in live test against the real API.
- Chrome 154 played audio in the offscreen document without a user gesture.

### mobile/ (Expo SDK 57)

**Implemented:**

- **Input:** the share sheet (expo-share-intent: text, URLs and files), paste, open a link, and import a document.
- **Playback:** a `StreamPlayer` that writes each chunk to a cache file and appends it to an expo-audio playlist, with word highlighting on the playlist clock, seeking, background audio and a lock-screen anchor.
- **Screens:** voices (favourites, blends, previews), settings, onboarding, and a library.
- **Persistence:** settings in MMKV, the key in secure storage.

**Verified:** tsc, lint, jest 58, expo-doctor, an Android JS export, and one native Android debug compile.

## Known gaps and follow-ups (priority order)

1. **Real-device iOS test of the web app** (the reason Tamber exists). Check on an iPhone:
   - playback starts from a tap;
   - playback with the silent switch on;
   - lock screen and background audio;
   - recovery after a phone call or Siri interruption;
   - PWA install;
   - WAV decode in Safari.
2. **NetBird proxy streaming check.** `curl -N` a long `/v1/tts` through the real proxy and confirm lines arrive one by one (no buffering or compression). Then play from the phone over the mesh.
3. **Mobile on devices.** Needs an EAS development build for iOS (bundle id `net.thirtytech.tamber`, App Group `group.net.thirtytech.tamber`) and an Android device or emulator. Check gapless playlist playback, background audio (Android stops unregistered audio after about 3 minutes), the lock-screen anchor workaround, and share-sheet intake, including Android `content://` uploads. The iOS seek-before-ready and anchor-status fixes are based on reading the expo-audio source and are untested.
4. **Extension re-test in real Chrome after the verifier's fixes:**
   - load unpacked by hand;
   - the permission prompt;
   - mini-player injection on real sites;
   - the 30 s offscreen no-audio limit when the server queues or the CPU is slow.
5. **GPU image.** `TORCH_VARIANT=cu130` (compose `gpu` profile) has not been built or run.
6. **Memory for non-streaming requests.** `stream:false` `/v1/tts` and wav/flac `/v1/audio/speech` hold the whole result in memory, which can reach about 1 GB at the 100k-character limit. Consider a lower limit for non-streaming requests.
7. **SSRF hardening.** The URL extractor has a DNS-rebinding window between the check and the connection, and does not block the NAT64 prefix `64:ff9b::/96`.
8. **Mobile chunk cache.** Chunk files are not size-limited until stop or a new document (WAV is about 170 MB per hour).
9. **Toolchain.** typescript-eslint does not support TypeScript 7 yet. web and extension each carry a TS 6 shim for ESLint (`scripts/eslint-typescript6.mjs` and the `eslint.config.js` redirect). Remove both when typescript-eslint supports TS 7. jsdom 30 wants Node >= 24.15, and this machine has 24.13 (a warning only). The repo uses pnpm 10 workspaces (isolated linker); `@tamber/client` is consumed from source via a `source` export condition, so no client build step precedes app builds.
10. **Smaller UX items:**
    - blends can't be previewed (the preview route takes single voices only);
    - `.txt` imports read the file name as the title;
    - on long texts, web's "Save audio" appears only once every chunk has arrived;
    - a second share while the mobile player is open pushes a duplicate route;
    - the mobile lock screen has no scrubber.
11. **Project hygiene:**
    - choose a license;
    - add real screenshots to the README;
    - publish images from CI;
    - misaki sometimes merges tokens without whitespace between them (for example `o’clock—“don’t`), and these are highlighted as one word (upstream behaviour).

## How to reproduce the checks

```sh
pnpm install
pnpm build
pnpm typecheck && pnpm lint && pnpm test      # every workspace, including mobile
cd api && .venv/Scripts/python -m ruff check . && .venv/Scripts/python -m mypy tamber_api && .venv/Scripts/python -m pytest -q && cd ..
docker build -t tamber:dev .
docker run -d --name tamber-check -p 8880:8880 -e TAMBER_API_KEY=test tamber:dev
curl -s localhost:8880/v1/health        # "status":"ok" after a few seconds
curl -s -H "Accept: text/html" localhost:8880/ | grep "<title>"
```
