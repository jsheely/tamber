# Research: Chrome MV3 Extension (Tamber `extension/`)

Fact-finding for the Tamber Chrome extension — Manifest V3, Vite + React + TypeScript + Mantine, sharing Tamber's word-highlighted, NDJSON-streamed TTS playback model with `web/`.

**Research date:** 2026-09-26. Versions below were checked live against the npm registry and official Chrome docs on this date — do not treat them as memorized/cutoff knowledge.

---

## 0. TL;DR Recommendation

**Use WXT (`wxt.dev`), not `@crxjs/vite-plugin` and not a hand-rolled multi-entry Vite config.**

| | Verdict |
|---|---|
| **WXT** | ✅ Recommended. File-based entrypoints (`entrypoints/background.ts`, `entrypoints/popup/`, `entrypoints/sidepanel/`, `entrypoints/offscreen/`, `entrypoints/content.ts`) auto-generate `manifest.json`, including auto-adding permissions like `sidePanel` when it sees a `sidepanel` entrypoint. First-party React module. Official example projects for exactly the two hard parts Tamber needs: an offscreen document and cross-browser targets. Actively released (v0.21.4, Aug 2026 per npm). Pre-1.0 but widely described as production-ready.[^wxt-home][^wxt-entry][^wxt-react][^wxt-offscreen-ex] |
| **@crxjs/vite-plugin** | ⚠️ Usable but riskier right now. It just cut a **breaking major, v3.0.0, two days before this research (2026-09-24)** that drops CommonJS entirely (ESM-only: no `require`, no `.cjs` build, no type shims).[^crxjs-npm-time][^crxjs-changelog] That's a healthy sign of active maintenance, but it means the ecosystem (tutorials, `npm create crxjs@latest` templates, third-party plugins) hasn't caught up yet, and you'd be an early adopter of a 2-day-old major. v2.x is fine and well documented, but there's no reason to start a new project on the version that's about to be superseded. CRXJS's model (you own `manifest.json`, the plugin diffs/patches it and rewires content-script/HMR internals) is also more "vanilla Vite plus magic" than WXT's file-convention model — more familiar if the team already knows Vite, more manual manifest wiring either way. |
| **Plain Vite multi-entry** | ❌ Not recommended as the primary approach. Vite's multi-page build (`rollupOptions.input: {popup: 'popup.html', options: 'options.html', ...}`) works fine for **static HTML pages** (popup, options, side panel), but it has no concept of a Chrome extension: no manifest generation/validation, no CRX-aware HMR (content-script HMR in an MV3 world requires re-injecting scripts and preserving state across service-worker restarts — both CRXJS and WXT solve this with custom middleware; plain Vite does not), and no dev-mode "reload the unpacked extension" loop. You'd end up hand-rolling a thin version of what WXT already ships (`vite-plugin-static-copy` for the manifest + icons, a custom watcher to trigger `chrome.runtime.reload()`). Reasonable only if there's a hard reason to avoid a framework dependency; not recommended here. |

**Why WXT over CRXJS specifically for Tamber:** Tamber's extension needs an **offscreen document** (for Web Audio decode/playback — see §2) *and* a **side panel** (for the rich word-highlighted player) *and* a **content-script floating mini-player** (shadow DOM). WXT treats each of these as a first-class, auto-manifested entrypoint folder with matching official examples;[^wxt-entry][^wxt-offscreen-ex] with CRXJS or plain Vite you hand-write and hand-maintain the `manifest.json` entries (`offscreen`, `side_panel`, `content_scripts`) yourself. WXT also natively supports React via `@wxt-dev/module-react`.[^wxt-module-react]

Package versions relevant to this piece, confirmed via `npm view <pkg> version` / `time` against the live registry on 2026-09-26:

| package | latest | notes |
|---|---|---|
| `wxt` | **0.21.4** (2026-08-11) | pre-1.0, actively released |
| `@crxjs/vite-plugin` | **3.0.0** (2026-09-24, 2 days old) | ESM-only breaking change; `2.7.1` (2026-07-01) is the last CJS-compatible release |
| `vite` | **8.3.1** (2026-09-24) | |
| `react` | **19.3.0** | |
| `@mantine/core` | **9.6.2** (2026-09-21) | note: Mantine's major has moved to 9.x as of this research — verify against `docs/research` for `web/` before assuming "7.x" from memory |
| `typescript` | **7.0.2** (stable) | TS 7 (the Go-ported "tsgo" compiler line) is now the stable tag; `7.1.0-dev.*` nightlies are prerelease only — pin `^7.0.2`, not a dev tag |

---

## 1. Tooling Deep Dive

### 1.1 WXT

- Convention-over-configuration, modeled on Nuxt: drop files into `entrypoints/`, WXT infers the manifest entry from the filename/folder (`entrypoints/background.ts` → `background.service_worker`, `entrypoints/popup/index.html` → `action.default_popup`, `entrypoints/sidepanel/` → `side_panel.default_path` **and auto-adds the `sidePanel` permission**, `entrypoints/offscreen/` → an offscreen HTML page, `entrypoints/content.ts` → `content_scripts`).[^wxt-entry]
- `wxt.config.ts` lets you still hand-edit/extend the generated manifest (`manifest: { permissions: [...] }`) for anything not inferable (e.g. `contextMenus`, `commands`, `optional_host_permissions`).
- React support: `npx wxt@latest init` → pick React, or add `@wxt-dev/module-react` to an existing project's `modules` array in `wxt.config.ts`.[^wxt-module-react]
- Official example repos exist for exactly Tamber's two trickiest entrypoints: `offscreen-document-setup` and `offscreen-document-domparser`.[^wxt-offscreen-ex]
- Dev loop: fast HMR for UI entrypoints, auto-reload for background/content scripts, single command build for Chrome/Firefox/Safari targets from one codebase (Tamber only needs Chrome now, but this removes a future-porting tax for free).
- Status: v0.21.4 as of 2026-08-11, not 1.0 yet, but the project's own docs describe it as "battle-tested and ready for production."[^wxt-home]

### 1.2 @crxjs/vite-plugin

- Model: you write a normal `manifest.json` (with placeholders), the Vite plugin parses it, resolves every referenced file as a Vite entry, and rewrites the on-disk manifest with content hashes / web-accessible-resource entries as needed. Ships **true HMR for content scripts** (a genuinely hard problem — content scripts don't naturally support HMR because they're injected once by the browser) via a runtime shim it injects.[^crxjs-npm-readme]
- Scaffold: `npm create crxjs@latest` (must be `@latest`, the README explicitly warns `npm` can resolve a stale cached version otherwise).[^crxjs-npm-readme]
- **v3.0.0 (2026-09-24) breaking change:** package is now ESM-only — no CommonJS build, no `require()` export condition, no `.cjs` files or type shims. If any tooling in the repo still needs `require('@crxjs/vite-plugin')`, it must switch to dynamic `import()`.[^crxjs-changelog] Feature-wise v3 adds Vite 8.1 experimental bundled-dev-mode support for content scripts and better CSS handling for dynamic content-script chunks as web-accessible resources.[^crxjs-changelog]
- Maintenance: actively maintained (current maintainers per GitHub discussion: @Toumash and @FliPPeDround since mid-2025); as of June 2026 the plugin officially supports Vite 8, with a compatibility range from Vite 3 through 8.[^crxjs-search]
- No first-party offscreen-document or side-panel scaffolding — you declare those manually in `manifest.json` like any hand-rolled MV3 project; CRXJS's value-add is the HMR/dev-server plumbing, not manifest ergonomics.

### 1.3 Plain Vite multi-entry

- `vite.config.ts` → `build.rollupOptions.input: { popup: 'src/popup/index.html', options: 'src/options/index.html', sidepanel: 'src/sidepanel/index.html' }` produces one JS/CSS bundle per HTML entry — fine for the *pages* (popup/options/side panel).
- Gaps you'd have to fill yourself:
  - **Manifest**: no generation/validation; copy a static `manifest.json` via `vite-plugin-static-copy` or `publicDir`, and keep entry filenames in it in sync by hand.
  - **Service worker**: `background.service_worker` must be a single classic-or-module script; a raw Vite multi-entry build can emit it, but you lose Vite's dev-server transform pipeline for it (service workers can't `import` from a dev server over HTTP the way page scripts can — this is exactly the problem CRXJS/WXT dev-mode solve with a custom module loader shim).
  - **Content-script HMR / dev reload**: none out of the box; you'd write a small watcher that calls `chrome.runtime.reload()` (from a dev-only script) on file change.
- Verdict: viable for a **build-only** (no fancy dev HMR) setup, but for a project this size (four coordinated deliverables sharing patterns with `web/`) the framework tax of WXT is worth paying.

---

## 2. MV3 Service Worker Limitations

The background context in MV3 is a **service worker**, not a persistent background page. Key constraints, confirmed against Chrome's own docs and the Chromium issue tracker:[^sw-lifecycle][^sw-issue]

- **No DOM.** `ServiceWorkerGlobalScope` has no `document`, no `<audio>`/`<video>` elements, and critically **no `AudioContext`/Web Audio API** — this is *why* Tamber needs an offscreen document at all; the service worker cannot decode or play the NDJSON audio chunks itself.
- **Idle termination ~30s.** Chrome terminates an idle service worker after ~30 seconds of no activity; receiving an event or calling an extension API resets the timer.[^sw-lifecycle]
- **Hard ceilings even while active:** a single event/API-call handler that runs longer than 5 minutes gets killed; a `fetch()` whose response takes more than 30 seconds to start arriving also triggers termination.[^sw-lifecycle] (NDJSON streaming from Tamber's API is a long-lived response *body* stream, not a slow-to-start one, but see the mitigation below — keep long-lived work out of the service worker regardless.)
- **State does not persist** across worker restarts — no in-memory globals survive; anything that must survive (current settings, in-flight-playback bookkeeping) belongs in `chrome.storage` or lives in a document context (offscreen/side panel) that outlives the worker.
- **Practical implication for Tamber:** the service worker's job should be thin — register `contextMenus`/`commands`, relay short messages, ensure the offscreen document exists — and nothing else. It should not hold the `fetch()` to Tamber's API for the NDJSON stream if that stream needs to live longer than the worker's idle/5-minute ceilings for a very long piece of text; safer to make the *offscreen document* (which has no such idle-termination ceiling — see §3) own the fetch and the decode/playback loop, and have the service worker just orchestrate ("create offscreen doc, tell it to start reading tab X's selection").

---

## 3. `chrome.offscreen` — the audio-playback engine

This is the load-bearing API for Tamber's extension, because it is the only MV3 context that (a) has a DOM + Web Audio and (b) isn't the visible popup/side panel (which the user may close mid-playback).

**Manifest:** requires the `"offscreen"` permission.[^offscreen-docs]

**Core API:**
```ts
// service-worker.ts (or wherever playback is orchestrated)
async function ensureOffscreenDocument() {
  const has = await chrome.offscreen.hasDocument(); // boolean
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',                       // bundled, relative path
    reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Decode and play streamed TTS audio chunks from the Tamber API',
  });
}

await chrome.offscreen.closeDocument(); // explicit teardown
```

**Lifecycle rules that matter for Tamber:**[^offscreen-docs][^offscreen-lifecycle]
- **Only one offscreen document per extension profile** at a time (a second `createDocument()` call while one exists rejects — always guard with `hasDocument()` first, as above).
- **`AUDIO_PLAYBACK` is the *only* reason with an automatic lifetime limit**: Chrome auto-closes the document after **30 seconds with no audio actively playing**. All other `Reason` values (e.g. `DOM_PARSER`, `CLIPBOARD`) have no such auto-close. Practically: as long as Tamber is actively playing (or about to play the next NDJSON chunk within 30s), the document stays alive; if playback is paused/stopped, close it explicitly with `closeDocument()` (don't rely on the 30s timer alone, since re-opening the tab/panel and immediately hitting play could race against a still-alive-but-scheduled-to-die document — call `hasDocument()`/`createDocument()` defensively every time playback starts).
- Offscreen documents **cannot be focused**, `window.opener` is always `null`, and — notably — **only the `chrome.runtime` messaging API is available inside them** (no `chrome.tabs`, no `chrome.contextMenus`, etc.). This confines the offscreen doc's job to: receive "play this NDJSON stream" messages, do the `fetch` + `ReadableStream` read loop, `decodeAudioData()` each chunk, schedule gapless playback on an `AudioContext`, and `chrome.runtime.sendMessage()` word-highlight/progress events back out.
- `hasDocument()` availability: per Chrome's own reference docs (fetched live 2026-09-26) this is listed as available from a recent Chrome version — current stable is **Chrome 153** (Sept 2026, two-week release cadence)[^chrome-version] so it is safely present; still, feature-detect (`'hasDocument' in chrome.offscreen`) rather than trust a hardcoded minimum version, since the exact introduction version reported by tooling was inconsistent across sources during this research.

**Design implication for Tamber's "never MediaSource" rule:** this maps perfectly — the offscreen document does exactly what the `web/` client does (fetch NDJSON → base64-decode each line → `AudioContext.decodeAudioData` → schedule via `AudioBufferSourceNode` for gapless playback), just running inside an extension-owned hidden page instead of a normal tab. The **AudioContext user-gesture unlock** requirement still applies: the *first* `AudioContext.resume()` (or construction) must be triggered synchronously from a user gesture. In the extension, the user gesture is the context-menu click or the `chrome.commands` shortcut — but that gesture happens in the **service worker's event handler**, not inside the offscreen document itself, so the unlock has to happen as the *first thing* the offscreen document does when it receives the "start playback" message triggered by that gesture-originated flow. In practice this has worked reliably for offscreen-audio extensions because Chrome treats the offscreen document's audio API calls as gesture-adjacent when triggered synchronously off the extension's own gesture-initiated message chain; verify empirically early in implementation and keep a fallback "tap to enable audio" affordance in the side panel/popup UI if any Chrome version tightens this.

---

## 4. `chrome.contextMenus` — "selection" context

Requires the `"contextMenus"` permission.[^ctxmenu-docs]

```ts
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'tamber-read-selection',
    title: 'Read “%s” aloud — Tamber',   // %s is replaced with the (truncated) selection text
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'tamber-read-selection' || !tab?.id) return;
  // info.selectionText is provided directly by Chrome — no injection needed for this path.
  startPlayback(info.selectionText ?? '', tab.id);
});
```

Two things worth calling out precisely:
- **MV3 has no inline `onclick` on the menu item** — you must always wire a separate `chrome.contextMenus.onClicked` listener (the old MV2 pattern of passing an `onclick` function to `create()` doesn't work with a non-persistent service worker).[^ctxmenu-docs]
- **`info.selectionText` is handed to you by Chrome for free** when `contexts` includes `'selection'` — this is the easy path and needs no `scripting.executeScript` call at all. Contrast this with the keyboard-shortcut path in §6, which does *not* get this for free.

---

## 5. `chrome.commands` — keyboard shortcut

Declared in `manifest.json`, not purely at runtime:

```json
"commands": {
  "read-selection": {
    "suggested_key": { "default": "Ctrl+Shift+Y", "mac": "Command+Shift+Y" },
    "description": "Read the selected text aloud with Tamber"
  }
}
```

- Shortcuts **must include `Ctrl` or `Alt`** (or `Command`/`MacCtrl` on Mac); modifier+MediaKey combos are disallowed.[^commands-docs]
- The special key `_execute_action` is reserved for triggering the toolbar action click itself, and — important distinction — **`_execute_action` commands do NOT fire `chrome.commands.onCommand`**; they fire `chrome.action.onClicked` instead. Only *your own named commands* (like `read-selection` above) fire `onCommand`.[^commands-docs]
- Listener:
```ts
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'read-selection' || !tab?.id) return;
  // Unlike contextMenus, onCommand gives you NO selection text — you must fetch it yourself.
  const [{ result: selectedText }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.getSelection()?.toString() ?? '',
  });
  startPlayback(selectedText, tab.id);
});
```

---

## 6. Getting the selected text: `chrome.scripting.executeScript` vs. a persistent content script

Two real options, and Tamber's two trigger paths (context menu vs. shortcut) actually want **different** ones:

| Trigger | Selection text available how | Extra permissions |
|---|---|---|
| Context menu (`contexts: ['selection']`) | **Free**, via `info.selectionText` in `onClicked` | none beyond `contextMenus` |
| Keyboard shortcut (`chrome.commands`) | **Not provided** — must call `chrome.scripting.executeScript({ func: () => window.getSelection().toString() })` against the active tab | `"scripting"` permission + `"activeTab"` (the shortcut press itself counts as the user gesture that activates `activeTab` for that tab) |

- `chrome.scripting.executeScript` injects and runs a function/file in a target context (default `document_idle`) and returns its result to the caller — this is the MV3-only, no-persistent-content-script way to reach into a page on demand.[^scripting-docs] It requires the `"scripting"` permission *and* permission for the target's URL — satisfied here by `"activeTab"` because the shortcut/menu click is itself the qualifying user gesture, so **no broad `host_permissions`/`<all_urls>` grant is needed just to read a selection**.
- The alternative — a **persistent** `content_scripts` entry matching `<all_urls>` that keeps `window.getSelection()` cached and answers `chrome.runtime.onMessage` — works too, but costs a broader install-time permission warning and a script running on every page load for a feature only needed on-demand. **Recommendation for Tamber: use `scripting.executeScript` + `activeTab` for selection capture; reserve a real (declarative or programmatically-injected) content script only for the floating mini-player UI (§9), and inject *that* on demand as well** (`chrome.scripting.executeScript` can also inject a whole content-script *file*, not just an inline function, so the same on-demand-injection approach covers the mini-player).
- Messaging directions, for completeness: content script → extension = `chrome.runtime.sendMessage(...)`; extension → a specific tab's content script = `chrome.tabs.sendMessage(tabId, ...)` (not `runtime.sendMessage`, which has no tab-targeting concept and would otherwise fan out to *every* tab's content script).[^scripting-docs]

---

## 7. `chrome.storage.sync` — settings persistence

Confirmed limits (2026-09-26, from Chrome's own storage reference):[^storage-docs]

| Limit | Value |
|---|---|
| `QUOTA_BYTES` (total) | 102,400 bytes (100 KB) — measured as JSON-stringified value + key length, summed |
| `QUOTA_BYTES_PER_ITEM` | 8,192 bytes (8 KB) per item |
| `MAX_ITEMS` | 512 items |
| Failure mode | A write that would exceed any limit **fails immediately** and sets `chrome.runtime.lastError` — it does not silently truncate |

Tamber's settings payload (voice, speed, format, API base URL, API key, theme, maybe a handful of UI toggles) is comfortably under all three limits as a single JSON blob in one key — no need to shard across multiple `storage.sync` keys unless the settings object grows to include large lists. Recommended shape:

```ts
type TamberExtensionSettings = {
  apiBaseUrl: string;
  apiKey?: string;
  voice: string;
  speed: number;
  format: 'wav' | 'mp3';
  theme: 'light' | 'dark' | 'system';
};

await chrome.storage.sync.set({ tamberSettings: settingsObj });
const { tamberSettings } = await chrome.storage.sync.get('tamberSettings');
```

`chrome.storage.sync` also syncs across the user's signed-in Chrome instances — a nice free win matching the cross-client "remembers settings" requirement, though note it's **best-effort and eventually-consistent**, not instant, and per-item write-rate throttling exists (not itemized above since Tamber's write frequency — settings changes, not per-second — is far under it). Consider `chrome.storage.local` as a fallback/mirror only if the extension ever needs to store something above the 8 KB/item or 100 KB/total ceiling (e.g., a cache), since `local` has a much higher quota (`chrome.storage.local` doc bytes limit is effectively unlimited with the `"unlimitedStorage"` permission) — not needed for settings alone.

---

## 8. Calling a user-configured API URL: `optional_host_permissions` + runtime `chrome.permissions.request`

Tamber's API base URL is user-set (it's behind a NetBird reverse proxy at whatever HTTPS URL the user configures) — so the extension **cannot hardcode a `host_permissions` origin at build time.** The documented pattern:[^permissions-docs]

**Manifest:**
```json
"optional_host_permissions": ["https://*/*"],
"permissions": ["storage", "contextMenus", "scripting", "offscreen", "sidePanel", "activeTab"]
```

**At runtime (e.g., when the user saves the API URL in Options/Popup settings):**
```ts
async function grantApiHostPermission(apiBaseUrl: string): Promise<boolean> {
  const origin = new URL(apiBaseUrl).origin + '/*';
  const already = await chrome.permissions.contains({ origins: [origin] });
  if (already) return true;
  // MUST be called synchronously within a user gesture handler (e.g. a "Save" button's onClick)
  return chrome.permissions.request({ origins: [origin] });
}
```

Key rules, confirmed against the live docs:
- Anything passed to `permissions.request()` must already be listed in `optional_permissions`/`optional_host_permissions` in the manifest (or be a *required* permission the user had previously withheld) — you can't request arbitrary origins outside that declared superset.[^permissions-docs] `"https://*/*"` as the declared optional superset is exactly the documented pattern for "I don't know the origin until runtime."
- `permissions.request()` **requires an active user gesture** — call it directly inside the click handler for the Options page's "Save" button, not after an intervening `await` to some other async work, or Chrome will reject it.
- Practical UX for Tamber: on first save of a new/changed API URL in the extension's Options page, call `grantApiHostPermission()` and surface a clear "Tamber needs permission to talk to `https://tts.yourdomain.example`" prompt if it returns `false`; block the "test connection" / enable-in-popup UI until granted.
- Why host permission matters beyond just "not blocked by the browser": granting host permission is also what lets the extension's `fetch()` calls to that origin bypass ordinary page-level CORS enforcement for extension-initiated requests — relevant since Tamber's API CORS config is described as "configurable" but the extension shouldn't be *dependent* on the user getting CORS headers exactly right if host permission is already granted.

---

## 9. `chrome.sidePanel` — the rich word-highlighting player

Requires the `"sidePanel"` permission and (if a single default UI is desired for every site) a `"side_panel": { "default_path": "sidepanel.html" }` manifest key. Chrome 114+.[^sidepanel-docs]

Relevant methods:

| Method | Purpose | Constraint |
|---|---|---|
| `chrome.sidePanel.open({ tabId })` | Opens the panel | **Must be called in direct response to a user action** (e.g. inside the `contextMenus.onClicked` or `commands.onCommand` handler chain) |
| `chrome.sidePanel.setOptions({ tabId, path, enabled })` | Per-tab (or global, omit `tabId`) panel config | none |
| `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` | Makes the toolbar icon toggle the panel open/closed instead of a popup | Upsert semantics — safe to call on every startup |
| `chrome.sidePanel.getOptions` / `getPanelBehavior` | Read back current config | |

Model for Tamber: **one active side panel per window**, either global or scoped per-tab via `tabId`. Since the offscreen document (§3) is the actual audio engine and single source of truth for playback position, the side panel is a *thin, reactive UI*: on open, it does `chrome.runtime.connect({ name: 'sidepanel' })` (a long-lived Port — preferable to repeated one-off `sendMessage` calls for a high-frequency stream of "current word index" ticks) and renders the Mantine/motion word-highlight UI purely from messages the offscreen document broadcasts. This lets the panel be closed and reopened mid-playback without losing sync — it just resubscribes and the offscreen document (or the service worker, if it's tracking last-known state) replies with current position.

Design note specific to Tamber: since `sidePanel.open()` needs a user gesture, and the *shortcut*/*context-menu* gesture is what starts playback, it's natural to have the same handler both (a) kick off playback (ensure offscreen doc exists, send it the text) and (b) open the side panel — one gesture, two effects — rather than requiring a second click just to see the player.

---

## 10. In-page floating mini-player: content script + Shadow DOM

For a lighter-weight "now playing" affordance directly on the page being read (no side panel required), inject a content script that builds its UI inside a **Shadow DOM** root:

```ts
function mountMiniPlayer() {
  const host = document.createElement('div');
  host.id = 'tamber-mini-player-host';
  Object.assign(host.style, { position: 'fixed', zIndex: '2147483647', bottom: '16px', right: '16px' });
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' }); // or 'closed' to fully hide from page scripts
  const style = document.createElement('style');
  style.textContent = /* scoped CSS for the mini-player, e.g. Mantine-flavored tokens re-declared here since
                          Mantine's global CSS variables on <html>/<body> won't cross the shadow boundary */ `...`;
  shadow.append(style, playerRoot);
  // React-render (createRoot) into playerRoot, same component used for the word-highlight caption.
}
```

Why Shadow DOM specifically: it fully isolates both directions — the host page's CSS cannot leak in and restyle Tamber's mini-player, and Tamber's own styles/scripts cannot leak out and disturb the host page.[^shadow-dom-1][^shadow-dom-2] `attachShadow` and `adoptedStyleSheets` are supported everywhere Chromium runs, so constructable stylesheets are a clean way to ship the mini-player's CSS without an extra `<style>` fetch.[^shadow-dom-1]

Practical gotchas surfaced in the research (worth flagging, not just theory):
- **Mantine's theme relies on CSS variables set on `:root`/`<body>`**, which do **not** inherit across a shadow boundary by default (custom properties *do* actually pierce shadow DOM per the CSS spec, but Mantine's injected `<style>` tags and any `MantineProvider` portal targets do not automatically follow into the shadow root) — plan to mount a second, scoped `MantineProvider` whose CSS is injected *inside* the shadow root (Mantine supports a custom `getRootElement`/style-injection target for exactly this "shadow DOM host" scenario), rather than assuming the page-level Mantine setup reaches in.
- **Content scripts cannot make cross-origin `fetch()` calls to the Tamber API directly** in the general case — cross-origin requests from a content script run in the *page's* security context for CORS purposes, so the practical pattern is: content script never fetches the API itself; it only renders UI state and sends/receives short messages to the service worker / offscreen document, which own the actual network calls (this is also just a re-statement of the architecture in §3 — the mini-player is a *view*, not a network client).[^shadow-dom-2]
- Inject this content script **on demand** via `chrome.scripting.executeScript({ target: { tabId }, files: ['mini-player.js'] })` at the moment playback starts, rather than as a static `content_scripts` manifest entry running on every page load — consistent with the activeTab-only, no-broad-permission approach from §6.

---

## 11. CSP for MV3 (no remote code)

MV3 tightens `content_security_policy.extension_pages` specifically to forbid remote code execution — this applies to background/popup/options/side-panel/offscreen HTML pages (not to arbitrary content scripts' interaction with the host page, and not to the separate `content_scripts` CSP surface, which is a different, narrower knob):[^csp-docs]

- The **only permitted values for `script-src`** are `'self'` and `'wasm-unsafe-eval'`. `'unsafe-eval'` and `'unsafe-inline'` are **not** allowed — this is the actual remote-code-execution guard.
- `'wasm-unsafe-eval'` is required only if the extension compiles/runs **WebAssembly**; it does **not** re-enable `eval()` for JavaScript — it's WASM-only.
- No remote `script-src` origins are allowed at all in `extension_pages` — every script must ship inside the packaged extension. (This is a hard blocker if any dependency tries to lazy-load a script from a CDN at runtime — don't; bundle everything through the Vite/WXT build instead.)
- Default MV3 CSP (if you don't override it) is already `script-src 'self'; object-src 'self'` — Tamber only needs to touch this at all if it ends up depending on a WASM module somewhere in the audio pipeline, in which case add:
```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

---

## 12. `manifest.json` skeleton

Written as the *logical* manifest — under WXT this is what `wxt.config.ts`'s `manifest` field plus auto-inferred entrypoints will produce; under CRXJS you'd author this file directly.

```json
{
  "manifest_version": 3,
  "name": "Tamber",
  "version": "0.1.0",
  "description": "Read any page's selected text aloud with Tamber TTS.",
  "icons": {
    "16": "assets/brand/png/icon-16.png",
    "32": "assets/brand/png/icon-32.png",
    "48": "assets/brand/png/icon-48.png",
    "128": "assets/brand/png/icon-128.png"
  },
  "action": {
    "default_icon": {
      "16": "assets/brand/png/icon-16.png",
      "32": "assets/brand/png/icon-32.png"
    },
    "default_title": "Tamber"
    // NOTE: no default_popup here if setPanelBehavior({openPanelOnActionClick:true})
    // is used to make the toolbar icon open the side panel instead of a popup.
    // If Tamber wants BOTH a quick popup AND a side panel, keep default_popup
    // and open the side panel only from the context-menu/command flow.
  },
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "permissions": [
    "storage",
    "contextMenus",
    "scripting",
    "offscreen",
    "sidePanel",
    "activeTab"
  ],
  "optional_host_permissions": ["https://*/*"],
  "commands": {
    "read-selection": {
      "suggested_key": { "default": "Ctrl+Shift+Y", "mac": "Command+Shift+Y" },
      "description": "Read the selected text aloud with Tamber"
    }
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  },
  "web_accessible_resources": [
    {
      "resources": ["mini-player.js", "mini-player.css"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

Notes:
- `assets/brand/...` paths above point at the concurrently-produced brand assets (per the shared brand-asset convention for this project). **As of this research those files did not yet exist** in `assets/brand/` — the icon paths above are a placeholder wiring; leave a `// TODO: verify assets/brand/png/icon-*.png exist` comment at integration time rather than assuming they're present.
- `content_scripts` is deliberately **absent** — the mini-player and selection-capture scripts are injected on demand via `chrome.scripting.executeScript` (§6, §10), which avoids needing a static `matches: ["<all_urls>"]` content-script registration (and its associated install-time permission prompt) for a feature that's opt-in per read-aloud action.
- `host_permissions` (required, not optional) is intentionally omitted — Tamber has no origin it needs access to at install time; the API origin is entirely runtime-configured via `optional_host_permissions` + `chrome.permissions.request` (§8).

---

## 13. Message-passing architecture

Four contexts, one shared "now playing" state, no single context guaranteed to be alive the whole time (side panel/popup can close; service worker idles out):

```
┌─────────────┐   contextMenus.onClicked (has selectionText)   ┌──────────────────┐
│  Any web page│ ───────────────────────────────────────────▶ │                  │
│ (user selects │   commands.onCommand → scripting.executeScript│  Service Worker  │
│  text)        │ ───────────────────────────────────────────▶ │  (background.ts) │
└─────────────┘                                                 │  - contextMenus  │
       ▲                                                        │  - commands      │
       │ chrome.tabs.sendMessage(tabId, ...)                    │  - offscreen     │
       │ (targeted: highlight/mini-player updates for THIS tab) │    lifecycle     │
       │                                                        │  - permissions   │
┌─────────────────┐   chrome.runtime.connect('sidepanel')       │  - relay only,   │
│  Content script  │◀────────────────────────────────────────── │    thin & stateless│
│  (mini-player,   │   chrome.runtime.sendMessage (broadcast)   └────────┬─────────┘
│  shadow DOM)     │                                                     │ chrome.runtime.sendMessage
└─────────────────┘                                                     │ ({type:'PLAY', text, settings})
       ▲                                                                ▼
       │ chrome.runtime.sendMessage (broadcast: word-index ticks) ┌──────────────────┐
       │◀──────────────────────────────────────────────────────── │ Offscreen doc    │
┌─────────────────┐                                              │ (offscreen.html) │
│  Side panel /    │◀──────────────────────────────────────────── │ - fetch NDJSON   │
│  Popup (React +  │   chrome.runtime.connect Port, same ticks    │ - decodeAudioData│
│  Mantine)         │                                             │ - AudioContext   │
└─────────────────┘                                               │   scheduling     │
                                                                   │ - broadcasts     │
                                                                   │   playback ticks │
                                                                   └──────────────────┘
```

Concrete rules used above:
- **Content-script–targeted** messages (e.g. "highlight word 7 in the mini-player on tab 42") go through `chrome.tabs.sendMessage(tabId, msg)` from whichever context needs to target that tab — never `chrome.runtime.sendMessage`, which has no tab-targeting concept and would otherwise be received by *every* tab's injected content script simultaneously.[^scripting-docs]
- **Extension-context-to-extension-context** broadcasts (offscreen doc → side panel/popup, both of which may or may not currently exist) go through `chrome.runtime.sendMessage` for one-off events, or a `chrome.runtime.connect()` **Port** for the high-frequency word-tick stream — a Port avoids the overhead/GC churn of firing a discrete message per word and gives the receiving UI a natural "disconnect" event to detect the panel closing.
- The **offscreen document is the single source of truth** for "what word are we on" (it owns the `AudioContext` and thus the real playback clock) — the side panel, popup, and mini-player are all just subscribers rendering that stream; none of them independently re-derive timing from timestamps, which would drift.
- The **service worker never touches audio** and ideally never holds the long-lived NDJSON fetch either (§2) — its only job is: wire up `contextMenus`/`commands`, ensure the offscreen document exists, and forward the initial "play this text with these settings" message to it. This keeps it within the idle/5-minute ceilings even for very long reads.

---

## Sources

[^wxt-home]: [WXT — Next-gen Web Extension Framework](https://wxt.dev/)
[^wxt-entry]: [WXT — Entrypoints](https://wxt.dev/guide/essentials/entrypoints)
[^wxt-react]: [WXT — Frontend Frameworks](https://wxt.dev/guide/essentials/frontend-frameworks)
[^wxt-module-react]: [@wxt-dev/module-react — npm](https://www.npmjs.com/package/@wxt-dev/module-react)
[^wxt-offscreen-ex]: [wxt-dev/examples — offscreen-document-setup](https://github.com/wxt-dev/examples/tree/main/examples/offscreen-document-setup), [offscreen-document-domparser](https://github.com/wxt-dev/examples/tree/main/examples/offscreen-document-domparser)
[^crxjs-npm-readme]: [@crxjs/vite-plugin — npm](https://www.npmjs.com/package/@crxjs/vite-plugin) and package README (fetched via `npm view @crxjs/vite-plugin readme`, 2026-09-26)
[^crxjs-npm-time]: npm registry `time` metadata for `@crxjs/vite-plugin` (fetched via `npm view @crxjs/vite-plugin time --json`, 2026-09-26) — confirms `3.0.0` published 2026-09-24T11:45:12Z
[^crxjs-changelog]: `packages/vite-plugin/CHANGELOG.md` at [crxjs/chrome-extension-tools](https://github.com/crxjs/chrome-extension-tools) (fetched 2026-09-26) — v3.0.0 breaking-change entry (ESM-only)
[^crxjs-search]: [crxjs/chrome-extension-tools Discussion #872 — "Unmaintained?"](https://github.com/crxjs/chrome-extension-tools/discussions/872); [CRXJS Vite Plugin docs](https://crxjs.dev/vite-plugin/)
[^sw-lifecycle]: [The extension service worker lifecycle — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
[^sw-issue]: [Chromium issue 40733525 — ServiceWorker shut down every 5 minutes for MV3 extension](https://issues.chromium.org/issues/40733525)
[^offscreen-docs]: [chrome.offscreen — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
[^offscreen-lifecycle]: [Lifecycle of offscreen documents — chromium-extensions group](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/sDNbgeVHEEw); [Offscreen Documents in Manifest V3 — Chrome blog](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3)
[^chrome-version]: [Chrome Releases blog, September 2026](https://chromereleases.googleblog.com/2026/09/) — Chrome 153 stable, 2026-09-08; two-week release cadence starting Chrome 153
[^ctxmenu-docs]: [chrome.contextMenus — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/contextMenus); [Build a context menu — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/ui/context-menu)
[^commands-docs]: [chrome.commands — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/commands)
[^scripting-docs]: [chrome.scripting.executeScript — MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript); [chrome.tabs.sendMessage / chrome.runtime.sendMessage — MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/sendMessage)
[^storage-docs]: [chrome.storage — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/storage) (QUOTA_BYTES=102400, QUOTA_BYTES_PER_ITEM=8192, MAX_ITEMS=512 for `sync`)
[^permissions-docs]: [chrome.permissions — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/permissions); [Declare permissions — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
[^sidepanel-docs]: [chrome.sidePanel — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/sidePanel); [Design a superior UX with the new Side Panel API — Chrome blog](https://developer.chrome.com/blog/extension-side-panel-launch)
[^shadow-dom-1]: [The secrets of Chrome Extensions and Shadow DOM — Railwaymen](https://blog.railwaymen.org/chrome-extensions-shadow-dom)
[^shadow-dom-2]: [How to use the Shadow DOM to isolate styles on a DOM that isn't yours — Courier/DEV](https://dev.to/courier/how-to-use-the-shadow-dom-to-isolate-styles-on-a-dom-that-isn-t-yours-7ad)
[^csp-docs]: [Improve extension security — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security); [content_security_policy — MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_security_policy)

---

## Open items to revisit during implementation

1. **Verify `assets/brand/` exists** before wiring real icon paths into the manifest (see §12) — placeholder + TODO used here per the shared brand-asset convention.
2. **Empirically test the AudioContext user-gesture unlock** through the actual gesture → service-worker-message → offscreen-document chain described in §3 on real Chrome (not just in theory) before committing to "no fallback needed" — this is the single riskiest cross-context assumption in this architecture.
3. **Decide CRXJS v3 vs. WXT with the rest of the team** if there's a strong existing-Vite-config reason to prefer CRXJS's model over WXT's file conventions — this doc's recommendation (WXT) is based on feature fit for offscreen+sidepanel+content-script, not a hard requirement.
4. **Confirm Mantine's current major** (registry showed `9.6.2` today) against whatever `web/` actually pins, and account for the shadow-DOM CSS-variable-inheritance nuance (§10) when sharing Mantine theme tokens into the mini-player.
