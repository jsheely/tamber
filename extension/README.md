# Tamber for Chrome

A Manifest V3 extension that reads text aloud with your self-hosted [Tamber](../README.md) voice
server, highlighting each word as it is spoken.

- **Read anything**: select text, right-click, then choose **Read with Tamber** (or press
  <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>). With nothing selected, the shortcut reads the
  page's main text. The right-click menu also has **Read this page with Tamber** and
  **Read linked page with Tamber**.
- **Side panel reader**: shows the exact text with word-by-word karaoke highlighting, a moving
  highlight pill, a wash on the current sentence and dimmed text for what has already been read. It
  auto-scrolls, you can click any word to jump there, and it has progress segments plus speed and
  voice chips.
- **Popup**: connection status, the current sentence with its active word, play / pause / stop /
  previous / next, a quick speed slider and voice picker, **Read selection or page**, and
  **Paste text & read** (or **Read clipboard**).
- **Mini-player**: a small floating pill in the page you are reading. It lives in a shadow DOM, so
  its styles are isolated from the page. You can drag it, and it shows the current sentence with the
  active word, progress, play/pause, stop and close.
- **Options**: server address and API key (with a runtime permission request and a connection
  test), a voice library (search, language filter, preview, favourites, blend editor), speed,
  volume, format, chunking, highlight, auto-scroll, theme, motion, extension-only switches, keyboard
  shortcuts and reset.
- **Badge**: shows progress (`42%`) while speaking, `II` when paused, `…` while loading and `!` on
  errors.

Audio is never streamed through Media Source Extensions. The server sends NDJSON lines, and each
line holds a complete WAV/MP3 chunk plus word timings. The offscreen document decodes every chunk
with `AudioContext.decodeAudioData` and schedules the chunks back to back (gapless), which is the
same design as the web app's iOS-safe player.

## Build

From the **repo root** (pnpm workspaces; `@tamber/client` is bundled from source and hot-reloads):

```sh
pnpm install
pnpm --filter @tamber/extension typecheck   # wxt prepare + TypeScript 7 (tsgo) --noEmit
pnpm --filter @tamber/extension lint        # ESLint 10 + typescript-eslint
pnpm --filter @tamber/extension test        # Vitest + WXT fake browser + jsdom
pnpm build:extension                        # -> extension/.output/chrome-mv3/
pnpm zip:extension                          # -> extension/.output/tamber-0.1.0-chrome.zip
pnpm dev:ext                                # watch mode (then load .output/chrome-mv3-dev unpacked)
```

Each script first builds `@tamber/client` (via its `pre*` hook).

## Install (load unpacked)

1. Run `pnpm build:extension`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select `extension/.output/chrome-mv3`.
5. Pin **Tamber** from the puzzle-piece menu so you can reach its popup.

On first install, the Options page opens automatically.

## Configure

1. In **Options → Server**, enter your server's address, for example `https://tts.example.com`.
   The address is normalized: `https://` is added when missing, and a trailing `/` or `/v1` is
   removed. Plain `http://` works only for `localhost` / `127.0.0.1`.
2. Click **Save**. Chrome asks for permission to access **that one site**. This is the only host
   permission Tamber ever requests. Nothing is granted at install time. With the permission
   granted, the extension's requests to your server also don't depend on its CORS settings.
3. If your server sets `TAMBER_API_KEY`, paste the key into **API key** and click **Save**.
   **Test connection** checks `/v1/health` (reachability, version, whether a key is needed) and then
   `/v1/voices` (whether the key is accepted).
4. Pick a voice. You can preview voices, star favourites (they are listed first in the popup and
   the side panel), or blend up to 4 voices.

Settings are stored as follows:

| What | Where | Syncs across your Chromes? |
|---|---|---|
| Server address, voice, speed, format, chunking, highlight, auto-scroll, theme, motion, volume, favourites | `chrome.storage.sync["tamber.settings"]` | yes |
| API key | `chrome.storage.local["tamber.secrets"]` | **no** (this device only) |
| Show mini-player, open side panel on play | `chrome.storage.sync["tamber.extension"]` | yes |
| Voice list cache, mini-player position | `chrome.storage.local` | no |
| Last reading, for resuming after the engine closed | `chrome.storage.session` | no (cleared when Chrome closes) |

Every page (popup, side panel, options) listens to `chrome.storage.onChanged`, so a change in one
place shows up everywhere immediately. The background forwards changes to the audio engine, so a
new voice or speed takes effect from the current sentence.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> | Read the selection (or the whole page when nothing is selected) |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> | Play / pause (also resumes the last reading after the engine closed) |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Stop |

These are the same on macOS (<kbd>Option</kbd>+<kbd>Shift</kbd>). You can change them at
`chrome://extensions/shortcuts` (**Options → Keyboard shortcuts → Change shortcuts**). If another
extension already uses a combination, Chrome leaves Tamber's shortcut unset. The Options page shows
which shortcuts are active.

## How it works

```
page ── right-click / Alt+Shift+R ──▶ background (service worker, stateless relay)
                                        │ scripting.executeScript (activeTab): selection / page HTML
                                        │ /v1/extract (page & link reads)
                                        │ offscreen.createDocument (AUDIO_PLAYBACK, hasDocument guard)
                                        ▼
                         offscreen document (single source of truth)
                           TamberClient.synthesize → NDJSON → decodeAudioData → gapless
                           AudioBufferSourceNodes → TimelineBuilder → wordIndexAt(clock)
                 port "tamber-player" │ snapshot + patches   │ runtime msg {target:'background', type:'state'}
                                      ▼                      ▼
                         popup / side panel          background ── tabs.sendMessage ──▶ mini-player (shadow DOM)
```

| File | Role |
|---|---|
| `src/entrypoints/background.ts` → `src/lib/background.ts` | Context menus, commands, offscreen lifecycle, badge, state relay to the mini-player, session memory. It never fetches NDJSON. |
| `src/entrypoints/offscreen/` | Hosts `ChunkedPlayer`, answers `tamber-player` ports (snapshot on connect, patches on every word / chunk / status change, 4 Hz position ticks), and asks to be closed after 30 s without audio. |
| `src/player/ChunkedPlayer.ts` | Framework-free Web Audio player. Pause = `ctx.suspend()`. Seek reschedules within received audio, or re-requests with `start_chunk` when the target is far ahead. A speed or voice change re-requests from the current chunk. Memory is bounded: the request is stopped once 5 minutes of decoded audio wait ahead of the playhead and re-issued with `start_chunk` when fewer than 2 minutes remain, and audio behind the playhead is evicted beyond 10 minutes in total. After a fatal stream error the decoded audio plays out, and Play retries from there. |
| `src/entrypoints/sidepanel/`, `popup/`, `options/` | React 19 + Mantine 9 UIs. They render only from engine state and never re-derive timing. |
| `src/entrypoints/mini-player.content/` | Runtime-registered content script (no `matches`, no static `content_scripts`), injected on demand. Its CSS is inlined into the shadow root, so it needs no `web_accessible_resources`. |
| `src/lib/messages.ts` | The typed message protocol (`target: 'offscreen' \| 'background' \| 'ui'`) plus type guards. Every listener ignores messages that aren't for it. |
| `src/lib/settings.ts`, `permissions.ts`, `offscreen.ts`, `client.ts`, `theme.ts` | Storage adapter, runtime host permission, offscreen guard, API client and error text, and the Mantine theme (identical to web). |

The **manifest** is generated by WXT from `wxt.config.ts`:

- permissions: `storage, contextMenus, scripting, offscreen, sidePanel, activeTab`
- `optional_host_permissions`: `https://*/*, http://localhost/*, http://127.0.0.1/*`
- no `host_permissions`, no `content_scripts`, no `web_accessible_resources`
- default MV3 CSP: all code and the Inter font are bundled, with no remote code

## Empirical finding: autoplay in the offscreen document

The architecture flagged one open question: does audio in the offscreen document start without a
user gesture, given that the context-menu or shortcut gesture happens in the service worker and not
in the offscreen document?

**Result: yes. No gesture is needed.** This was verified on **2026-09-26** with **Chrome
154.0.8037.57** (Windows 11), both `--headless=new` and headful. The unpacked build was loaded
through the DevTools protocol (`Extensions.loadUnpacked`, because branded Chrome ignores
`--load-extension`), and a mock Tamber server streamed real WAV chunks.

- Creating the offscreen document from the service worker and sending `play`, with **no user
  activation anywhere** (`navigator.userActivation.hasBeenActive === false` in the offscreen
  document), produced a new `AudioContext` whose `state` was **`running`** immediately.
- The engine went `loading` → `playing` within about 350 ms. The active word advanced in step with
  the audio clock (`Hello` → `world.` → `This` → …), `pause` → `paused`, `resume` → `playing`, and
  `stop` closed the offscreen document.
- In the same run, the side panel (opened as a tab) rendered 19 word spans with the highlight pill
  on the spoken word and logged no console errors.

So Chrome treats `AUDIO_PLAYBACK` offscreen documents as allowed to play. The `needs-gesture` state
is kept as a safety net in case a future Chrome tightens this. If the `AudioContext` cannot reach
`running` within 1.5 s, the popup and side panel show **Click to start audio**, which sends `resume`.
Note that a click in the popup does not transfer user activation to the offscreen document, so this
fallback depends on Chrome allowing `resume()` at that point.

## Tests

`pnpm --filter @tamber/extension test` runs 72 tests (4 more are skipped unless a live server is configured):

- settings adapter: split secrets, migration, round trip, serialized writes, quota, change events
- `useSettingsState`: rehydration when a page opens, and following changes made in other contexts
- permission helper: origin pattern, synchronous `permissions.request`
- message type guards and the mini-state projection
- `ChunkedPlayer` with a fake `AudioContext` and a fake NDJSON stream: cumulative start times,
  clock-driven word, far seek → `start_chunk` re-request, near seek waits, seek to character, pause
  and resume, needs-gesture, stop aborts, speed re-request, non-fatal skip, end, fatal error, a clock
  tick during `decodeAudioData` not re-requesting the chunk, the ahead-of-playhead memory bound
  (stop and `start_chunk` refill, counting only gapless audio, evicting the farthest audio first), and
  decoded audio playing out after a fatal error followed by a retry
- background wiring with WXT's fake browser: selection and page reads (`executeScript` + `/v1/extract`),
  the offscreen document created once behind the `hasDocument` guard, `sidePanel.open` called before
  any `await`, mini-player injection, onboarding redirects, commands, resuming the last session, and
  hiding a stale mini-player when reading stops or moves to another tab
- a test that no source file contains `MediaSource` / `SourceBuffer`
- Reader and mini-player render tests

**Against a real server** (opt-in, `src/test/live-server.test.ts`): start the API with the
model-free fake engine and point the tests at it. They drive the extension's own client and
`ChunkedPlayer` with real NDJSON and real WAV chunks (only the `AudioContext` is simulated):

```powershell
# in api/
$env:TAMBER_ENGINE = 'fake'; $env:TAMBER_API_KEY = 'dev-key'
.venv\Scripts\python -m uvicorn tamber_api.main:app --port 8880
# in the repo root
$env:TAMBER_E2E_URL = 'http://127.0.0.1:8880'; $env:TAMBER_E2E_KEY = 'dev-key'
pnpm --filter @tamber/extension test
```

## Toolchain notes

- **WXT 0.21** (Vite 8) with `@wxt-dev/module-react`, **React 19.3**, **Mantine 9.6**,
  **motion 13** (`motion/react`), `@tabler/icons-react`, `@fontsource-variable/inter`.
- **TypeScript split.** `typescript-eslint` 8.x needs the classic TypeScript JS API (peer
  `typescript <6.1`), which TypeScript 7 no longer ships. So this workspace's `typescript`
  devDependency is **6.0.x** (it sits nested in `extension/node_modules` and is used only by the
  ESLint parser), and type checking runs **TypeScript 7** from the `typescript-native` alias
  through `scripts/tsc.mjs`. This is the same approach as `web/`. `eslint.config.js` also points the
  hoisted `ts-api-utils` at the TS 6 instance before loading typescript-eslint.
- There is no `postinstall` script. The Docker web build installs with `--ignore-scripts` and only
  copies `extension/package.json`.

## Brand assets

`public/icons/icon-{16,32,48,128}.png` and `public/icons/glyph.svg` are copies of
`assets/brand/png/*` and `assets/brand/glyph.svg`. `assets/brand/` stays the source of truth. The
mini-player inlines the glyph path so that it needs no web-accessible resources.

## Known limitations

- Chrome does not allow content scripts on `chrome://` pages, the Chrome Web Store or the built-in
  PDF viewer, so the mini-player cannot appear there. Reading still works: the menu gives the
  selection text, and the side panel and popup show playback.
- `sidePanel.open()` must run inside the user gesture. The extension reads the "open side panel on
  play" flag from an in-memory cache so the call is synchronous. On a cold service-worker start the
  cache may still be loading, and then Chrome can refuse to open the panel. The popup's
  **Open reader** button always works.
- Remote servers must use `https://` (`optional_host_permissions`).
- Chrome closes an `AUDIO_PLAYBACK` offscreen document after about 30 s without audio. If the
  server keeps a request queued (or the first sentence takes longer than that on a slow CPU), the
  engine can be closed before audio starts. The last session is remembered, so pressing Play
  (or Alt+Shift+P) starts it again.
- Chrome only (it relies on MV3 offscreen documents and the side panel).
