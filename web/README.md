# Tamber web

The Tamber web app: a mobile-first, installable PWA (Vite 8 + React 19 + TypeScript 7 + Mantine 9 + motion) that streams Kokoro speech from the Tamber API and highlights each word as it is spoken. The API container serves the built app (`web/dist`) as static files, so in production the page and `/v1` share one origin.

It works on iOS Safari: audio is played with Web Audio from self-contained per-sentence chunks, **never** with MSE (see [iOS notes](#ios-notes)).

## Commands

Run everything from the repo root (pnpm workspaces; `@tamber/client` is resolved straight from `packages/client/src` through its `source` export condition, so it needs no build and hot-reloads):

```sh
pnpm install
pnpm dev:web               # http://localhost:5173, proxies /v1 to TAMBER_API_URL (default http://localhost:8880)
pnpm --filter @tamber/web typecheck   # tsc -b (TypeScript 7) over app, tests and vite config
pnpm --filter @tamber/web lint        # eslint (flat config)
pnpm --filter @tamber/web test        # vitest + jsdom (fake fetch streaming NDJSON, fake AudioContext)
pnpm build:web                        # -> web/dist (index.html, hashed assets, manifest.webmanifest, sw.js, icons)
pnpm --filter @tamber/web preview     # serve dist (also proxies /v1)
```

A local API with the model-free engine (from `api/`, see its README):

```sh
cd api && TAMBER_ENGINE=fake uvicorn tamber_api.main:app --reload --port 8880
```

Optional live test of the real player against a running API (not part of `pnpm test`):

```sh
cd web && TAMBER_API_URL=http://localhost:8880 pnpm exec vitest run src/test/integration.test.ts
```

### Environment

| Variable | Used by | Default | Meaning |
|---|---|---|---|
| `TAMBER_API_URL` | `vite` dev/preview proxy, integration test | `http://localhost:8880` | Where `/v1` is proxied during development |

At runtime nothing is baked in: the API base URL and key are user settings (Settings drawer). Leave the base URL empty when the page is served by the Tamber server (same origin, e.g. behind the NetBird URL). Set it to `https://tts.example.com` to use the app against another deployment (the server must allow the origin via `TAMBER_CORS_ORIGINS`).

### Toolchain note: TypeScript 7 + typescript-eslint

TypeScript 7 is the native compiler and its package no longer exposes the JS compiler API that typescript-eslint 8 needs (peer `typescript <6.1`). So:

- `typescript-native` (= `npm:typescript@^7.0.2`) is the compiler; `scripts/tsc.mjs` runs it for `typecheck`/`build` (both TS packages declare a `tsc` bin, so the wrapper picks TS 7 explicitly).
- `typescript` (`~6.0.3`, nested in `web/node_modules`) exists only for the ESLint parser. `scripts/eslint-typescript6.mjs` (loaded first by `eslint.config.js`) routes `require('typescript')` to it via `module.registerHooks`, because `ts-api-utils` is hoisted next to the root's TypeScript 7.

## Architecture

```
src/
  main.tsx, App.tsx, Providers.tsx, theme.ts, app.css
  brand/            tokens.ts, pwa.ts, brand.css, head-tags.html (from assets/brand, do not edit)
  store/            settings.ts (zustand persist "tamber.settings"), draft.ts ("tamber.draft"),
                    history.ts ("tamber.history"), session.ts (non-persisted UI/server state),
                    colorScheme.ts (Mantine colour scheme = settings.theme)
  api/              useTamberClient, useHealth, useVoices, errors.tsx (toasts, 401 -> settings)
  player/           ChunkedPlayer.ts (framework-free), unlock.ts, decode.ts, silentAnchor.ts,
                    mediaSession.ts, actions.ts (gesture handlers), usePlayer.ts, usePlayerBindings.ts
  reader/           Reader.tsx, highlightController.ts (DOM/ref driven), blocks.ts
  features/         compose (Composer, ReaderPanel, SidePanel, PanelDrawer: the side panel as a phone sheet), voices (VoicePicker, BlendEditor,
                    VoiceDrawer), import (URL + Dropzone), settings, history, Drawers.tsx (lazy)
  ui/               Header, PlayerDock, PlayButton, Orb, Waveform, ProgressSegments, TimeReadout,
                    TapToResume, ResponsiveDrawer
  test/             vitest suites + fakes
```

### Playback (`src/player/ChunkedPlayer.ts`)

- `unlock()` is **synchronous** and is the first call in every gesture handler (`player/actions.ts`): `navigator.audioSession.type = 'playback'` (feature-detected), create/resume the `AudioContext`, start a looping near-silent `<audio playsinline>` anchor.
- `play()` consumes `client.synthesize()` (fetch body streaming of NDJSON). Each `chunk` line is one complete WAV/MP3 file: `base64ToBytes` -> `decodeAudioData` (promise form, callback fallback) -> `AudioBufferSourceNode.start(when)` back to back on gain -> analyser -> destination, at most 3 chunks ahead. `TimelineBuilder.add(chunk, buffer.duration)` keeps word times on the same clock.
- Clock = `ctx.currentTime - origin`. Pause/resume = `ctx.suspend()/resume()`. Seek = stop the scheduled nodes and reschedule from `(chunk, offset)` with `start(when, offset)`. A chunk that is not held and more than 2 chunks beyond the stream position is re-requested with `start_chunk` (the old request is aborted).
- Decoded buffers more than 2 chunks behind are released; raw chunk bytes are kept (capped at 200 MB) for seeking back without re-synthesis and for **Save audio** (`concatWav`, WAV only, once every chunk has arrived).
- Download backpressure: with more than 10 minutes of audio held ahead of the playhead the request is closed (freeing the server's synthesis slot) and re-opened with `start_chunk` when less than 2 minutes remain. Long texts therefore never hold hundreds of MB, and Save audio for them becomes available near the end.
- Timeouts: 120 s for the first stream line (requests can queue), then 60 s between lines (the server pings every 15 s), so a stream silently cut by a proxy fails with Retry instead of loading forever.
- Speed changes during playback restart synthesis at the current chunk; voice/format changes apply to the next play.
- An `interrupted`/`suspended` context while playing sets `needsGesture` and shows **Tap to resume**. It never retries `resume()` from timers.
- React reads coarse state through `useSyncExternalStore`; per-frame work (highlight pill, clock, orb, waveform, progress playhead) runs from one shared `requestAnimationFrame` loop (`lib/ticker.ts`) with refs and motion values.

### Reader and highlighting

The reader renders exactly the submitted text: paragraph blocks (`content-visibility: auto`) containing chunk spans (from the `start` plan, or the local `planChunks()` preview until it arrives) that gain word spans as chunk events arrive. `HighlightController` picks the active word with `wordIndexAt()` and only touches the DOM when it changes: `data-active`/`data-spoken` attributes, one absolutely positioned pill moved with a spring (instant with reduced motion), and auto-scroll that keeps the active line in the middle third (paused for 4 s after manual scrolling). Tap a word or sentence to seek. Degraded mode (no word timings or highlight off): chunk wash only; the toggle is disabled with the tooltip "Word timing isn't available for this language".

### Persistence

| Key | What | Notes |
|---|---|---|
| `tamber.settings` | `TamberSettings` (incl. API key) | zustand persist v1, `migrateSettings` on load, `updateSettings` on write |
| `tamber.draft` | composer text + import info | debounced 500 ms, not saved above ~1 MB, flushed on `pagehide` |
| `tamber.history` | last 20 played texts | capped at 600k characters total |

Every storage access is wrapped in try/catch (Safari private mode). The theme is applied before first paint by an inline script in `index.html` that reads `tamber.settings`.

### PWA

`vite-plugin-pwa` (`registerType: 'prompt'`) with the manifest and icons from `src/brand/pwa.ts`. The service worker precaches the app shell and never handles `/v1/*` (navigate-fallback denylist plus a `NetworkOnly` route), `/docs` or `/openapi.json`. `index.html` carries the `apple-touch-icon` link (iOS ignores manifest icons).

**Updates.** An installed app has no address bar to reload from, so `src/pwa.ts` registers the worker itself and the `useAppUpdate` store (`src/lib/appUpdate.ts`) drives two controls: a banner under the header ("A new version of Tamber is ready" with Update) as soon as a new worker is waiting, and an **App** section in Settings with the version, build time, "Check for updates" (turns into "Update now") and a plain reload link. The app checks on load, whenever it returns to the foreground or regains focus (throttled to once per 30 s), and hourly. `__APP_VERSION__` and `__BUILD_TIME__` are injected by `vite.config.ts`.

## Brand icons

The icons come from `../assets/brand`, which is the source of truth and is never edited from here. `scripts/copy-brand-assets.mjs` copies them into `public/` (it runs automatically as part of `predev`/`prebuild`):

| File in `public/` | Source |
|---|---|
| `favicon.ico` | `favicon.ico` (16/32/48) |
| `favicon.svg` | `icon-small.svg` (small master, drawn for 16 px) |
| `apple-touch-icon.png` | `png/icon-180.png` (required: iOS ignores manifest icons) |
| `icon-192.png`, `icon-512.png` | manifest icons, purpose `any` |
| `icon-maskable-512.png` | manifest icon, purpose `maskable` |
| `mask-icon.svg`, `glyph.svg` | `glyph.svg` (Safari pinned tab, in-app logo / CSS mask) |
| `icon.svg` | `icon.svg` (full-detail mark, 48 px and up) |

`src/brand/` holds `head-tags.html` (pasted into `index.html`; no manifest link because VitePWA injects one), `pwa.ts` (`pwaManifest`, `pwaIncludeAssets`), `tokens.ts` (colours and 10-shade Mantine scales) and `brand.css` (`.tamber-mark`, `.tamber-gradient-text`).

## iOS notes

- **No MSE.** iOS Safari has no `MediaSource`; a test (`src/test/no-mse.test.ts`) fails if any file in `src/` mentions the MSE classes.
- **Gesture unlock.** `AudioContext` creation/resume only happens synchronously inside tap/key handlers (play, resume, seek taps, voice previews). Nothing awaits before `unlock()`.
- **Silent switch.** `navigator.audioSession.type = 'playback'` is set before the context starts, and a near-silent looping `<audio playsinline>` keeps the media session alive (lock screen, background).
- **WAV by default.** Safari's MP3 `decodeAudioData` is fragile and MP3 chunks can have tiny gaps; MP3 is opt-in in Settings.
- **Interruptions.** Locking the phone, a call or another app can suspend or interrupt the context. The app shows "Tap to resume audio" instead of retrying in the background.
- **Lock screen.** MediaSession metadata (title, "Tamber", voice, `/icon-512.png`) and play/pause/previous/next/seek handlers drive the player.
- **Install.** Use Safari's Share > Add to Home Screen over HTTPS; the status bar is `black-translucent`, so the layout pads with `env(safe-area-inset-*)`.
- **App-shell scrolling.** The document never scrolls (`html, body { overflow: hidden }`). `.app` is fixed to the viewport with the header, the update banner, one scroller (`[data-app-scroller]`, `overscroll-behavior: contain`) and the player dock as flex rows, so the header and dock stay docked through rubber-banding and momentum scrolls. The reader's auto-scroll targets that scroller (`Viewport.scroller` in `highlightController.ts`).
- **No zoom.** The viewport meta sets `maximum-scale=1` (Safari still lets people pinch, but it stops the focus auto-zoom that otherwise leaves the page zoomed in), `touch-action: manipulation` removes double-tap zoom, and on coarse pointers every input renders at 16 px or larger. Tap targets are at least 44 px.

## Keyboard (desktop)

Space play/pause · Left/Right previous/next sentence · Esc stop (when no drawer is open).
