# Tamber architecture

Tamber is a self-hosted text-to-speech platform built on the Kokoro-82M model. It replaces [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI). One Docker container serves both the API and a web UI, and a Chrome extension and an Expo mobile app talk to the same API. Every client plays audio progressively, **including on iOS Safari**, and highlights each word as it is spoken using timings produced by the model itself.

- HTTP contract: [`docs/API.md`](API.md) (normative)
- Shared TS package: [`packages/client`](../packages/client/README.md)
- Research this design is based on: [`docs/research/`](research/)
- Env vars: [`.env.example`](../.env.example)

---

## 1. System overview

```
                   ┌────────────────────────── one Docker container (port 8880) ───────────────────────────┐
                   │                                                                                        │
 Browser / PWA ────┤  FastAPI (uvicorn)                                                                    │
 (web UI, iOS OK)  │   ├─ /v1/health, /v1/voices, /v1/voices/{id}/preview                                   │
                   │   ├─ /v1/tts ───────────┐  chunk planner (§6.3) → per-chunk KPipeline → per-chunk     │
 Chrome extension ─┤   │                     │  WAV/MP3 file + word timings → NDJSON line, flushed          │
 (offscreen audio) │   ├─ /v1/extract        │  (trafilatura, pypdf, python-docx, ebooklib, markdown-it)    │
                   │   ├─ /v1/audio/speech   │  OpenAI-compatible, continuous encoder                        │
 Expo app ─────────┤   ├─ /v1/models, /v1/audio/voices                                                    │
 (iOS/Android)     │   ├─ auth (optional bearer) · CORS · rate limit · request ids · error envelope        │
                   │   └─ static SPA: /app/web  (Vite build of web/, hashed assets, long cache)            │
 OpenAI tools ─────┤                                                                                        │
 (Open WebUI …)    │  Kokoro engine: one shared KModel + one KPipeline per enabled language (a, b, …)       │
                   │  weights + voices baked into /opt/tamber/hf at build time (HF_HUB_OFFLINE=1)           │
                   └────────────────────────────────────────────────────────────────────────────────────────┘
                              ▲
        HTTPS (dedicated URL) │  NetBird reverse proxy: TLS termination, no buffering, long read timeout
```

Design principles:

1. **One contract, four consumers.** `docs/API.md` and `@tamber/client` define everything the clients share: types, the streaming parser, settings, chunk planning and timeline math. Clients own only UI and platform audio.
2. **Chunks are self-contained.** The server splits text into sentence-sized chunks. Every NDJSON line carries a *complete* audio file plus word timings and character offsets for that chunk. No client ever needs MediaSource/SourceBuffer (forbidden: iOS Safari has no MSE).
3. **Word timings come from the model.** `KPipeline` yields `MToken.start_ts/end_ts` for English. No forced aligner is used.
4. **Offsets index the user's own text.** Character offsets are UTF-16 indices into the exact string the client sent, so highlighting is `text.slice(start, end)`.
5. **Fast first audio.** The first chunk is a single sentence. Synthesis streams chunk by chunk while earlier chunks play.

---

## 2. Repository layout

```
tamber/
├── package.json               root scripts (pnpm); packageManager pnpm@10
├── pnpm-workspace.yaml        workspaces: packages/*, web, extension, mobile
├── pnpm-lock.yaml             single lockfile for every workspace
├── .env.example               every env var the API reads
├── .editorconfig  .gitignore  .gitattributes  .prettierrc.json
├── README.md
├── docs/
│   ├── ARCHITECTURE.md        this file
│   ├── API.md                 HTTP contract (normative)
│   └── research/              upstream / stack research (read-only input)
├── assets/brand/              icon masters + BRAND.md (source of truth; never edited by apps)
├── packages/
│   └── client/                @tamber/client: types, TamberClient, NDJSON, settings, planner, timeline, brand tokens
│       ├── src/  dist/  test/  fixtures/chunking.json  scripts/generate-fixtures.mjs
├── Dockerfile  .dockerignore  docker-compose.yml   one image: API + built web UI (context = repo root)
├── api/                       Python 3.12 FastAPI service
│   ├── pyproject.toml  requirements*.txt
│   ├── scripts/download_models.py
│   ├── tamber_api/            app package (config, auth, routes/, tts/, extract/, static)
│   └── tests/
├── web/                       Vite + React + TS + Mantine SPA/PWA (built into the API image)
│   ├── public/  (brand icons, copied by scripts/copy-brand-assets.mjs)
│   ├── scripts/copy-brand-assets.mjs
│   └── src/  (brand/, player/, reader/, features/, store/, …)
├── extension/                 WXT (MV3) Chrome extension, React + Mantine
│   ├── public/icons/          brand PNGs
│   └── src/entrypoints/  (background, offscreen, sidepanel, popup, options, content/mini-player)
└── mobile/                    Expo SDK 57 app (expo-router), consumes @tamber/client via file: dependency
    └── assets/                brand PNGs
```

---

## 3. The single container

A multi-stage `Dockerfile` at the **repo root** (context = repo root): `docker build -t tamber .`.

| Stage | Base | Does |
|---|---|---|
| `web-build` | `node:24-slim` | Installs pnpm, copies `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packages/client`, `web`, the `extension/` and `mobile/` manifests (the frozen lockfile lists every workspace) and `assets/brand`. Runs `pnpm install --frozen-lockfile --filter @tamber/web...` then `pnpm --filter @tamber/web build` (the client is consumed from source via its `source` export condition). Output: `web/dist`. |
| `runtime` | `python:3.12-slim` | `pip install` of `api/requirements.txt` plus `api/requirements-tts.txt` with `--extra-index-url https://download.pytorch.org/whl/${TORCH_VARIANT}` (default `cpu`). Installs the spaCy `en_core_web_sm` model at build time (misaki would otherwise download it at runtime). Runs `scripts/download_models.py` to fetch `kokoro-v1_0.pth`, `config.json` and `voices/<lang>*.pt` for `TAMBER_LANGUAGES` into `HF_HOME=/opt/tamber/hf`, verifying each file's SHA-256 against the HF metadata and writing to a temp name before renaming atomically. Copies `api/tamber_api` and `web/dist` to `/app/web`. Runs as uid 1000 `tamber`. `ENV HF_HUB_OFFLINE=1`. `EXPOSE 8880`. `HEALTHCHECK` is a python urllib GET of `/v1/health` that checks `status == "ok"`. |

Build args: `TORCH_VARIANT` (`cpu` default; torch 2.14.0 also has `cu126`, `cu130`, `cu132` but not `cu128`; check the current channel names at https://download.pytorch.org/whl/), `TAMBER_LANGUAGES` (default `a,b`), `TAMBER_VERSION`.

Runtime:

- `uvicorn tamber_api.main:app --host $TAMBER_HOST --port $TAMBER_PORT --proxy-headers --forwarded-allow-ips $TAMBER_FORWARDED_ALLOW_IPS --timeout-keep-alive 75`, one worker (one model in memory).
- The FastAPI lifespan loads the engine in a background task, so the server answers `/v1/health` with `status: "loading"` immediately. It then warms up with one short synthesis.
- Volumes: none required, because models are baked in. An optional volume on `/opt/tamber/hf` lets you reuse weights across image rebuilds.
- Images: about 3.0 GB for CPU (measured with the English voices; torch, spaCy and ~342 MB of model + voices dominate).
- The root `docker-compose.yml` (context `.`) runs the image with an optional `env_file: ./.env`, port `8880:8880`, `restart: unless-stopped`, and a `gpu` profile (`tamber-gpu`, `TORCH_VARIANT=cu130`, NVIDIA reservation).

---

## 4. Deployment behind NetBird (dedicated HTTPS URL)

```
phone / laptop / extension ──HTTPS──▶ NetBird reverse proxy (https://tts.example.com) ──HTTP──▶ tamber:8880
```

- **Dedicated URL.** Tamber lives at the root of its own hostname (for example `https://tts.example.com`), so `TAMBER_ROOT_PATH` stays empty. The web UI is same-origin with the API and needs no CORS and no base-URL setting: its default `apiBaseUrl` of `""` means same origin.
- **TLS** terminates at the proxy. Remote clients must use `https://` (iOS requires it for PWA install; Chrome host permissions are per origin).
- **API key.** Set `TAMBER_API_KEY` (comma-separate for per-device keys). The static UI stays public but useless without the key: the user pastes it into Settings once, and it is stored locally. `/v1/health` stays open so clients can show "server reachable, key required".
- **CORS.** `TAMBER_CORS_ORIGINS=*` is the default and is safe (no cookies). Tighten it to specific origins if other web apps must not call the API from browsers.
- **Proxy requirements for streaming.** Proxy **buffering must be off** for `/v1/tts` (the server also sends `X-Accel-Buffering: no` and `Cache-Control: no-store`). **No compression** of `application/x-ndjson`. **Read/idle timeout** of at least 300 s (the server sends `ping` lines every 15 s while idle, so 60 s also works). Request body limit of at least `TAMBER_MAX_UPLOAD_MB`. Pass `X-Forwarded-For` / `X-Forwarded-Proto`.
- **Rate limit** keys on the API key, so all traffic arriving from one proxy IP is fine.
- **Checklist** (not yet run against the real NetBird proxy): `curl -N` a long `/v1/tts` through the proxy and confirm lines arrive incrementally, not all at the end.

---

## 5. iOS-safe chunked playback

### 5.1 Why not MSE / `<audio src=stream>`

iOS Safari has no `MediaSource`. `ManagedMediaSource` (iOS 17.1+) is limited, attaches only to media elements, and can't feed Web Audio. Kokoro-FastAPI's player silently falls back to "download everything, then play" on iPhone. Tamber drops MSE entirely.

### 5.2 Server side

For each planned chunk: synthesize (all KPipeline segments), trim silence (API.md §7.1), encode **a fresh, finalized WAV (default) or MP3 file**, base64 it, and write one NDJSON line. The line is flushed immediately. Before the first chunk the server writes a `start` line with the full plan, so the client can render the text and real progress (`received / total`) right away.

### 5.3 Web client (`ChunkedPlayer`, framework-free, `web/src/player/`)

```
tap Play (user gesture)
  ├─ navigator.audioSession.type = 'playback'   (feature-detected; Safari 16.4+; before creating/resuming)
  ├─ ctx = new AudioContext() / ctx.resume()     (synchronously, inside the gesture, before any await)
  ├─ anchor <audio playsinline loop> of near-silent WAV .play()  (keeps the iOS media session alive for lock screen)
  └─ start fetch → for await (event of client.synthesize(...))
         chunk → base64ToBytes → decodeAudioData (promise form, callback fallback)
               → queue.push({buffer, event})
               → schedule while lookahead < 3 chunks:
                    src = ctx.createBufferSource(); src.buffer = buffer
                    src.connect(gain → analyser → destination)
                    src.start(nextStartTime); nextStartTime += buffer.duration      (gapless)
                    timeline.add(event, buffer.duration)
rAF loop (UI only): t = ctx.currentTime - playbackOrigin  →  wordIndexAt(timeline, t)  →  highlight
```

Rules, all learned from the research:

- The **clock is `AudioContext.currentTime`**, never `Date.now()` or rAF timestamps.
- `AudioContext` creation and `resume()` happen **only** in direct gesture handlers (play, resume, "tap to enable audio"). They never happen after an `await` or in a timer. An `interrupted`/`suspended` context after backgrounding shows a "Tap to resume" affordance instead of retrying in a loop.
- **Pause** = `ctx.suspend()` (freezes the clock and all scheduled nodes). **Resume** = `ctx.resume()` inside the tap handler.
- **Seek** = stop all scheduled nodes, then reschedule from the target chunk at an in-buffer offset (`src.start(when, offset)`). If the target chunk isn't decoded or received yet and is more than about 2 chunks ahead, abort the current request and start a new one with `start_chunk = target` (chunk-relative timings make this trivial). Decoded buffers already received are kept, bounded to about 10 minutes of audio (older ones are evicted).
- **Memory.** Decoded `AudioBuffer`s of chunks more than 2 behind the playhead are released. Base64 strings are dropped right after decoding.
- **Lock screen.** Set `navigator.mediaSession` metadata (title, voice, artwork `/icon-512.png`) and wire the `play`/`pause`/`seekbackward`/`seekforward`/`previoustrack`/`nexttrack` handlers to the player.
- **WAV by default.** Safari's MP3 `decodeAudioData` is fragile. MP3 is an opt-in setting.

### 5.4 Extension

The same pipeline runs inside the **offscreen document** (reason `AUDIO_PLAYBACK`), which owns fetch, decode, the `AudioContext` and the clock. It is Chrome-only, so it needs no iOS workarounds but does need the gesture-unlock fallback UI. The service worker only orchestrates.

### 5.5 Mobile

`expo/fetch` streams the NDJSON. Each chunk's base64 is written to a cache file (`expo-file-system` `File.write(b64, {encoding:'base64'})`). `expo-audio` `AudioPlaylist.add({uri})` provides native gapless playback. The clock is `playlist.currentIndex` plus `playlist.currentTime`, read in a rAF loop. Lock-screen and background playback use `setActiveForLockScreen`.

---

## 6. Word-highlighting data flow

```
KPipeline(text_chunk) ─▶ Result.tokens[i].start_ts/end_ts (s, relative to segment audio)
      │  drop punctuation / untimed tokens; + offset of earlier segments; − trimmed leading silence
      ▼
spoken-text index map ─▶ word.char_start/char_end in the ORIGINAL text (UTF-16)      (server)
      ▼
NDJSON chunk { index, char_start, char_end, duration, words:[{text,start,end,char_start,char_end}] }
      ▼
TimelineBuilder.add(chunk, decodedDuration)  → absolute word times on the playback timeline   (@tamber/client)
      ▼
rAF: i = wordIndexAt(timeline, clock)  →  if i changed: move highlight (direct DOM/ref update, no React re-render per frame)
```

- **Rendering (web/extension):** the reader renders the submitted text as chunk spans (from the `start` plan) containing word spans (created as chunk events arrive; text between words stays plain). The active word gets a `data-active` attribute and an animated pill (a motion `layoutId` element or a CSS transform). The active chunk gets a soft wash, and already-spoken text is dimmed. Auto-scroll keeps the active line within the middle third of the viewport and pauses for 4 s after the user scrolls manually.
- **Tap a word** → `timeForCharOffset()` → seek (§5.3).
- **Degraded mode:** when `start.word_timestamps` is `false` or a chunk has `words: []`, only the chunk wash follows playback. The word-highlight toggle is disabled with the tooltip "Word timing isn't available for this language".
- **Highlight off** (`settings.highlight = false`): the chunk wash only.

---

## 7. Settings model (shared by every client)

Defined in `@tamber/client` (`TamberSettings`, `DEFAULT_SETTINGS`, `migrateSettings`). Every client persists it under the key **`tamber.settings`** and runs loaded data through `migrateSettings(persisted, version)`, which validates, clamps, fills defaults and upgrades old versions. Setters go through `updateSettings()`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `version` | `1` | `1` | Schema version. |
| `apiBaseUrl` | string | `""` | Origin (plus an optional path), no trailing `/`, no `/v1`. `""` = same origin (web only). Extension and mobile show onboarding while it is empty. Normalized with `normalizeBaseUrl`. |
| `apiKey` | string | `""` | Secret. Web: localStorage. Extension: `chrome.storage.local` (not synced). Mobile: `expo-secure-store`. |
| `voice` | string | `af_heart` | Id or blend spec. |
| `speed` | number | `1.0` | UI range 0.5-2.0, step 0.05. |
| `format` | `wav`/`mp3` | `wav` | |
| `lang` | LangCode/null | `null` | null = from the voice. |
| `chunkMode` | `balanced`/`sentence` | `balanced` | |
| `highlight` | boolean | `true` | Word-level karaoke on/off. |
| `autoScroll` | boolean | `true` | |
| `theme` | `auto`/`light`/`dark` | `auto` | Mantine `defaultColorScheme` / RN `useColorScheme`. |
| `motion` | `system`/`full`/`reduced` | `system` | `system` follows `prefers-reduced-motion`. |
| `volume` | 0..1 | `1` | Client-side gain. |
| `favoriteVoices` | string[] | `[]` | At most 24, most recent first. |

| Client | Storage | Mechanism |
|---|---|---|
| web | `localStorage["tamber.settings"]` | zustand `persist` (`name: 'tamber.settings'`, `version: 1`, `migrate: migrateSettings`, `merge` that re-validates) |
| extension | `chrome.storage.sync["tamber.settings"]` (everything except `apiKey`) + `chrome.storage.local["tamber.secrets"]` (`{apiKey}`) | One settings module used by every extension context. `chrome.storage.onChanged` keeps the popup, side panel, options page and offscreen document in sync. |
| mobile | MMKV `tamber.settings` (everything except `apiKey`) + `expo-secure-store` `tamber.apiKey` | zustand `persist` + `createJSONStorage(() => mmkvStorage)`; the secret is hydrated asynchronously at boot |

Non-settings state that is also persisted: the **web draft text** (`localStorage["tamber.draft"]`, debounced 500 ms, capped at 1 MB) and **recent documents** on mobile (last 20: title, source, char count, text stored in a file, not MMKV).

---

## 8. Security

- Optional bearer key (constant-time compare, multiple keys allowed, never logged, never in URLs).
- There are no cookies or sessions, so CSRF does not apply, and a CORS `*` default is acceptable.
- SSRF guard on URL extraction (private ranges refused unless explicitly allowed; re-checked on every redirect hop).
- Size and time limits on text, uploads, downloads and queue depth. A per-client rate limit.
- Container runs as non-root. The model is baked in and runs offline (`HF_HUB_OFFLINE=1`). There is no remote code at runtime.
- Extension: MV3 CSP with no remote code, `optional_host_permissions` requested for the one configured origin, no static `<all_urls>` content script.
- Dependencies: pypdf (BSD) rather than pymupdf (AGPL). No AGPL dependency is pulled in implicitly.

---

## 9. Per-client architecture

### 9.1 `api/`

`tamber_api` package: `config.py` (pydantic-settings, all `TAMBER_*`), `errors.py` (envelope and exception handlers, 422 remapped to 400), `auth.py` (dependency), `ratelimit.py`, `middleware.py` (request id, version header, CORS), `routes/` (health, voices, tts, extract, openai, static), `tts/` (`chunking.py` port of the reference planner, `offsets.py` UTF-16 mapping, `engine.py` Engine protocol plus `FakeEngine`, `kokoro_engine.py`, `voices.py` catalog and blends, `audio.py` trim and encode, `service.py` queue, slots and the per-chunk pipeline), `extract/` (url, html, files, normalize). Torch and kokoro are imported lazily, so `TAMBER_ENGINE=fake` runs with only `requirements.txt`.

### 9.2 `web/`

A Vite SPA, installable as a PWA, and mobile-first. Layers: `store/` (zustand settings + draft + session), `player/` (framework-free `ChunkedPlayer`, iOS unlock, media session), `reader/` (text renderer + highlight engine), `features/` (compose, voices, settings, import), `ui/` (orb and waveform visuals driven by the analyser plus motion values).

### 9.3 `extension/`

WXT MV3. Contexts: **background** (service worker: context menus, commands, offscreen lifecycle, permissions; stateless relay), **offscreen** (playback engine, single source of truth), **sidepanel** (rich reader with highlighting), **popup** (quick controls and paste-to-read), **options** (settings and connection), **mini-player** content script (shadow DOM, injected on demand). Messages are typed in one shared module. Ports carry the high-frequency position stream.

### 9.4 `mobile/`

Expo SDK 57, expo-router, custom dev client (share intent requires it). A pnpm workspace member like the others, installed with pnpm's **hoisted** linker (`nodeLinker: hoisted` in `pnpm-workspace.yaml`, a flat npm-style `node_modules`). Isolated linking was tried first and works for the JS side, but React Native's C++ builds (react-native-screens, worklets, nitro-modules) mirror each module's absolute source path under `android/.cxx`, and on Windows the extra `node_modules/.pnpm/<hash>/node_modules/` segment pushed object paths past CMake's 250-character limit (ninja: "manifest build.ninja still dirty"). Hoisting removes that segment; Expo documents hoisted as the fallback for exactly this. A flat layout means every workspace shares one React, so **web and extension pin the same `react`/`react-dom` (19.2.3) as Expo SDK 57**; keep them aligned when upgrading, or React Native sees two React copies and fails with a null hooks dispatcher. Mobile depends on `"@tamber/client": "workspace:*"`; `expo/metro-config` detects the workspace root from `pnpm-workspace.yaml`, and `metro.config.js` adds the `source` export condition so Metro bundles `packages/client/src/*.ts` directly (hot reload, no build step). Jest maps `@tamber/client` to the same source files.

### 9.5 `packages/client` is consumed from source

`packages/client/package.json` lists a `source` condition first in every `exports` entry (`./src/index.ts`, `./src/brand.ts`), ahead of `types`/`import`/`default` (which point at `dist/`). Each consumer opts in: `resolve.conditions: ['source', ...defaultClientConditions]` in the web Vite/vitest configs and the WXT/vitest configs, `resolver.unstable_conditionNames` in Metro, and `customConditions: ["source"]` in every consumer tsconfig. Relative imports inside the client use `.ts` extensions with `rewriteRelativeImportExtensions`, so the same files work unbuilt in bundlers and, once built, as plain Node ESM in `dist/` (the client's own `node --test` suite runs against `dist/`).

---

## 10. Tech stack and exact versions

All versions were checked against the npm and PyPI registries on 2026-09-26. Pin with `^` (JS) or `==` (Python) as shown. **Mobile versions are resolved by `pnpm exec expo install`**, never hand-pinned.

### API (Python 3.12)

| Package | Version | Why |
|---|---|---|
| python | 3.12 (`python:3.12-slim`) | kokoro requires `<3.13` |
| fastapi | 0.141.1 | |
| uvicorn[standard] | 0.54.0 | |
| pydantic / pydantic-settings | 2.13.5 / 2.15.0 | |
| python-multipart | 0.0.32 | uploads |
| httpx | 0.28.1 | URL fetch (and TestClient) |
| torch | 2.14.0+cpu (index `download.pytorch.org/whl/cpu`) | the plain PyPI wheel pulls GBs of CUDA |
| kokoro / misaki[en] | 0.9.4 / 0.9.4 | engine + G2P (espeakng-loader bundled, no apt espeak) |
| spaCy model | `en_core_web_sm` matching the resolved spaCy | installed at build time |
| numpy | resolver-chosen, `<3` | |
| av (PyAV) | 18.1.0 | MP3/Opus/AAC/FLAC encoding (WAV is written by hand) |
| trafilatura | 2.2.0 | URL/HTML extraction |
| pypdf | 6.19.0 | PDF |
| python-docx | 1.2.0 | DOCX |
| ebooklib | 0.20 | EPUB |
| beautifulsoup4 | 4.15.0 | HTML to text helper |
| markdown-it-py | 4.2.0 | Markdown |
| charset-normalizer | 3.5.1 | text encoding detection |
| dev: pytest / pytest-asyncio / ruff / mypy | 9.1.1 / 1.4.0 / 0.16.9 / 2.3.1 | |

### Shared + web + extension (Node 24, pnpm 10; hoisted node_modules, one copy of each package)

| Package | Version | Used by |
|---|---|---|
| typescript | ^7.0.2 (native compiler) | all |
| @tamber/client | `workspace:*`, consumed from `src/` via the `source` export condition | web, extension, mobile |
| react / react-dom / @types/react(-dom) | 19.2.3 / ~19.2.2, pinned to Expo SDK 57's React so the hoisted workspace has one copy | web, extension (and mobile) |
| vite | ^8.3.1 | web (and WXT's peer) |
| @vitejs/plugin-react | ^6.1.1 | web |
| @mantine/core, hooks, notifications, dropzone | ^9.6.2 (bump together) | web; extension uses core, hooks, notifications |
| postcss / postcss-preset-mantine / postcss-simple-vars | ^8.5.28 / ^1.18.0 / ^7.0.1 | web, extension |
| motion | ^13.4.4 (`motion/react`) | web, extension |
| zustand | ^5.0.15 | web (and mobile) |
| vite-plugin-pwa | ^1.3.0 | web |
| @tabler/icons-react | ^3.48.0 | web, extension |
| @fontsource-variable/inter | ^5.3.0 | web, extension (bundled font, works under MV3 CSP) |
| wxt / @wxt-dev/module-react | ^0.21.4 / ^1.2.2 | extension |
| eslint / @eslint/js / typescript-eslint | ^10.11.0 / ^10.0.1 / ^8.70.1 | web, extension |
| eslint-plugin-react-hooks / eslint-plugin-react-refresh / globals | ^7.1.1 / ^0.5.7 / ^17.12.0 | web, extension |
| vitest / @vitest/coverage-v8 | ^5.0.2 | web, extension |
| @testing-library/react / jest-dom / user-event | ^16.3.3 / ^7.0.1 / ^14.6.7 | web, extension |
| jsdom | ^30.1.1 | web, extension tests |
| prettier | ^3.9.9 | root |

### Mobile (resolved by `pnpm exec expo install` for SDK 57)

expo 57.0.x, react-native 0.86.x, react 19.2.x, expo-router 57, expo-audio 57, expo-file-system 57, expo-clipboard 57, expo-document-picker 57, expo-dev-client 57, expo-secure-store 57, expo-haptics 57, expo-linear-gradient 57, expo-splash-screen 57, expo-share-intent 8.0.1, react-native-reanimated 4.7.x + react-native-worklets 0.13.x, react-native-mmkv 4.3.x, react-native-safe-area-context / react-native-screens (SDK-pinned), zustand ^5.0.15, jest-expo 57.

---

## 11. Build, test and run matrix

| Where | Install | Typecheck | Lint | Test | Build | Run |
|---|---|---|---|---|---|---|
| root (JS) | `pnpm install` | `pnpm typecheck` | `pnpm lint` | `pnpm test` | `pnpm build` | `pnpm dev` (API + web), `pnpm dev:fake` |
| packages/client | (root) | `pnpm --filter @tamber/client typecheck` | | `pnpm --filter @tamber/client test` | `pnpm build:client` (only for `dist/` consumers and the package's own tests) | |
| web | (root) | `pnpm --filter @tamber/web typecheck` | `pnpm --filter @tamber/web lint` | `pnpm --filter @tamber/web test` | `pnpm build:web` | `pnpm dev:web` (proxies `/v1` to `:8880`) |
| extension | (root) | `pnpm --filter @tamber/extension typecheck` | `pnpm --filter @tamber/extension lint` | `pnpm --filter @tamber/extension test` | `pnpm build:extension` → `extension/.output/chrome-mv3`; `pnpm zip:extension` | `pnpm dev:ext` |
| api | `cd api && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt` (+ `-r requirements-tts.txt --extra-index-url https://download.pytorch.org/whl/cpu` for the real engine) | `mypy tamber_api` | `ruff check . && ruff format --check .` | `pytest` (fake engine; `-m model` for real-model tests) | `docker build -t tamber .` (from the root) | `TAMBER_ENGINE=fake uvicorn tamber_api.main:app --reload --port 8880` |
| mobile | (root) | `pnpm typecheck:mobile` | `pnpm lint:mobile` | `pnpm test:mobile` | `cd mobile && pnpm export:check` (JS bundle check); `eas build` for binaries | `pnpm dev:mobile`; `cd mobile && pnpm exec expo run:android` |

---

## 12. Decision log

| # | Decision | Alternatives rejected | Reason |
|---|---|---|---|
| D1 | NDJSON lines, each with a complete audio file | MSE streaming (upstream), SSE, WebSocket | iOS has no MSE; NDJSON over fetch streams everywhere (Safari, expo/fetch, extension) and is trivial to debug with curl. |
| D2 | Fresh encoder/container per chunk | Upstream's one container per request | Upstream's per-line bytes are not independently decodable. |
| D3 | WAV default, MP3 opt-in | MP3 default | Safari MP3 decode fragility; WAV is sample-exact and gapless. |
| D4 | Chunk-relative word times + client timeline helper | Absolute times (upstream) | Independent scheduling, skip-on-error and `start_chunk` resume. |
| D5 | UTF-16 offsets into the original text, length-preserving normalization | Code points, normalized-text offsets | Clients are all JS; `slice()` just works; no second copy of the text. |
| D6 | Character-based deterministic chunk planner with a TS reference + shared fixtures | Token-budget packing (upstream) | Clients can predict boundaries; the server sends the plan anyway; conformance is testable in both languages. |
| D7 | First chunk = first sentence | Uniform packing | Faster time to first audio on CPU. |
| D8 | `start_chunk` resume | Client-side-only seek | Seeking far ahead in long articles without re-synthesizing. |
| D9 | PyTorch `kokoro` engine | kokoro-onnx | Only the PyTorch pipeline yields word timings (English). |
| D10 | pypdf | pymupdf | License (AGPL). |
| D11 | WXT for the extension | CRXJS v3 (2 days old), hand-rolled Vite | First-class offscreen, side panel and content-script entrypoints. |
| D12 | pnpm workspace with the hoisted linker and one shared React version; mobile is a member; `@tamber/client` consumed from source via a `source` export condition | Isolated linking (broke React Native's C++ builds on Windows: object paths over CMake's 250-character limit); npm workspaces with mobile outside them and a prebuilt `dist/` | Native builds get short paths on every OS; client edits hot-reload in every app without a build step. |
| D13 | `TAMBER_ENGINE=fake` | Mocking in each client | Every builder tests against the real HTTP behaviour without the model. |
| D14 | Port 8880 + `/v1/audio/speech` compatibility | New port | Drop-in for existing Kokoro-FastAPI integrations. |

---

## 13. Known limitations and open items

- No word timings for non-English in v1. Japanese and Chinese are not supported by the default image.
- CPU first-audio latency is roughly 1-3.5 s depending on hardware (research). The single-sentence first chunk mitigates it.
- iOS PWA backgrounding: audio may need a tap to resume after long pauses in the background. This is surfaced in the UI, not retried silently.
- Open: verify NetBird proxy streaming behaviour (§4) and real-device iOS Safari playback (silent switch, lock screen).
- Resolved: on Chrome 154 an offscreen-document AudioContext starts `running` with no user gesture, so the gesture-unlock chain is not needed (see extension/README.md). The "click to start audio" fallback remains.
- Open: the iOS Share Extension needs a real-device test (EAS build).
- Current verification status and the prioritised follow-up list: [STATUS.md](STATUS.md).
