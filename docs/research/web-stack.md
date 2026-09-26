# Tamber — Web Front-End Stack Research

**Scope:** `web/` — the Vite + React + TypeScript + Mantine SPA, served as static files by `api/`.
**Date verified:** 2026-09-26, against live npm registry `dist-tags.latest` and primary docs (registry queried directly via `registry.npmjs.org`, not memory — see version table for exact timestamps).
**Companion research:** this doc also covers the iOS Safari audio investigation needed for `ChunkedPlayer`, since the player is a `web/` concern (and shared conceptually with `mobile/`).

---

## 1. Verified current versions (as of 2026-09-26)

| Package | Latest | Published | Notes |
|---|---|---|---|
| `vite` | **8.3.1** | 2026-09-24 | Vite 8 line; 8.3.x is the newest minor |
| `react` / `react-dom` | **19.3.0** | 2026-09-09 | React 19 line |
| `typescript` | **7.0.2** | 2026-07-08 (7.0 GA) | ⚠️ See §1.1 — this is the native Go-ported compiler, not "6.x+1" |
| `@mantine/core` / `hooks` / `notifications` / `dropzone` | **9.6.2** | 2026-09-21 | All four packages are version-locked together |
| `postcss-preset-mantine` | **1.18.0** | — | Independent versioning from Mantine core |
| `postcss-simple-vars` | **7.0.1** | — | Used for Mantine breakpoint variables in PostCSS |
| `motion` | **13.4.4** | 2026-09-25 | This **is** the framer-motion successor package (see §4) |
| `zustand` | **5.0.15** | — | v5 line, persist middleware API unchanged from v4 in shape |
| `vite-plugin-pwa` | **1.3.0** | — | |
| `workbox-window` | **7.4.1** | — | Pulled in transitively by vite-plugin-pwa |
| `eslint` | **10.11.0** | — | Flat config only; no `.eslintrc` support |
| `typescript-eslint` | **8.70.1** | — | Unified `typescript-eslint` meta-package (not `@typescript-eslint/*` separately) |
| `@vitejs/plugin-react` | **6.1.1** | — | Required Vite React plugin |
| `eslint-plugin-react-hooks` | **7.1.1** | 2026-04-17 | ⚠️ Jumped from the long-lived 4.6.x line to a v7 rewrite — see §6.2 |
| `eslint-plugin-react-refresh` | **0.5.7** | — | |
| `globals` | **17.12.0** | — | For flat-config `languageOptions.globals` |
| `@eslint/js` | **10.0.1** | — | |

**How this was verified:** `curl https://registry.npmjs.org/<pkg>` and read `dist-tags.latest` + `time[<version>]` directly — not `npm view` from a cached local npm, and not model memory. Two things surprised the assumptions going in, both confirmed against primary sources:

### 1.1 TypeScript 7.0 is a from-scratch native (Go) compiler, GA since July 2026

This is **not** an incremental bump. Microsoft rewrote the compiler and language service in Go for a native binary (codename "Corsa"); GA shipped 2026-07-08, and `npm install -D typescript` now installs 7.0 under the normal `latest` tag. Reported gains are 8–12x faster full builds (VS Code's own build: 125.7s → 10.6s). The CLI binary is still invoked as `tsc`. It was previously distributed as a preview under `@typescript/native-preview` (8.5M+ weekly downloads before merging into mainline `typescript`).

**Practical implication for `web/`:** pin `typescript": "^7.0.2"` and don't assume old `tsconfig.json` compiler-option edge cases behave identically — the native port has near-total but not 100% feature parity at GA (see the TS 7.0 announcement's compatibility notes before relying on obscure/legacy compiler flags). Editor tooling (VS Code's built-in TS server) needs a version that matches, so keep the workspace TS version pinned rather than "use VS Code's bundled TS."

Sources: [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [InfoQ: TypeScript 7 Released](https://www.infoq.com/news/2026/08/typescript-7-released/)

### 1.2 Mantine 9 requires React ≥ 19.2

Mantine jumped 8→9 and the v9 line **requires React 19.2+**. Since Tamber is starting fresh on React 19.3, this is satisfied automatically, but it rules out ever using an older React 19.0/19.1 pin with Mantine 9. Also note for `9.x`:
- `Grid`'s `gutter` prop renamed to `gap`.
- `positionDependencies` prop removed (handled automatically).
- Light-variant CSS variables now resolve to solid colors instead of alpha/transparency; a `v8CssVariablesResolver` compat shim exists if any copied v8-era snippet assumes the old resolver.
- `@mantine/form`'s Standard Schema support (Zod v4/Valibot/ArkType) means dedicated `mantine-form-zod-resolver`-style packages are no longer needed (not directly relevant unless `web/` adds `@mantine/form` for the settings panel).

Sources: [Mantine 9.0.0 changelog](https://mantine.dev/changelog/9-0-0/), [8.x → 9.x migration guide](https://mantine.dev/guides/8x-to-9x/)

### 1.3 `create-vite`'s official `react-ts` template now defaults to **Oxlint**, not ESLint

Pulled directly from `vitejs/vite` `main` today: the `template-react-ts` package.json's `lint` script is `oxlint`, and there is an `_oxlintrc.json` (not `eslint.config.js`) in the template. `devDependencies` include `oxlint": "^1.85.0"` with no `eslint` package at all.

```json
// packages/create-vite/template-react-ts/_oxlintrc.json (verbatim, fetched today)
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

The modern `npm create vite@latest` CLI now interactively prompts "ESLint or Oxlint?" — Vite's own docs/discussion threads confirm this is a deliberate, recent default-template change (Oxlint is a Rust-based linter claiming 50–100x ESLint's speed, with built-in React/TS/import rule coverage).

**Recommendation for Tamber:** the computed research brief asked specifically for "eslint flat config," so §6 below gives that in full — ESLint remains the right choice for `web/` because `extension/` and `mobile/` will want consistent lint tooling and ESLint's plugin ecosystem is still deeper (a11y, i18n, etc., if ever needed). But be aware the upstream default has moved, and re-evaluate Oxlint (or `eslint-plugin-oxlint` running both side-by-side) later if lint speed becomes a pain point in CI.

Sources: [vitejs/vite `template-react-ts` on GitHub](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) (fetched via GitHub API today), [Oxlint usage in create-vite templates #22025](https://github.com/vitejs/vite/issues/22025), [oxc.rs Oxlint guide](https://oxc.rs/docs/guide/usage/linter)

---

## 2. Vite + React + TypeScript baseline

Standard `npm create vite@latest web -- --template react-ts` gives the scaffold; swap the lint script for ESLint per §6. Key `package.json` shape (versions per §1 table):

```json
{
  "devDependencies": {
    "vite": "^8.3.1",
    "@vitejs/plugin-react": "^6.1.1",
    "typescript": "^7.0.2",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0"
  },
  "dependencies": {
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
  }
}
```

`vite.config.ts` needs nothing exotic for this project beyond the React plugin, PWA plugin (§5), and — since the API will be reverse-proxied at a separate HTTPS URL — a dev-time proxy so local dev doesn't fight CORS:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({ /* see §5 */ }),
  ],
  server: {
    proxy: {
      '/api': {
        target: process.env.TAMBER_API_URL ?? 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
```

Since the brief requires the client to let the user **configure** the API base URL at runtime (not just build time — this is a single static bundle served by `api/` but also usable against other deployments), the app should default to `window.location.origin` (same-origin, since `api/` serves the built UI) but let the settings store override it, sent as an absolute URL on every `fetch`.

---

## 3. Mantine (`@mantine/core`, `hooks`, `notifications`, `dropzone`) + Vite/PostCSS setup

All four packages are on **9.6.2** and version-locked — install them together and bump together.

### 3.1 Install

```bash
npm install @mantine/core @mantine/hooks @mantine/notifications @mantine/dropzone
npm install -D postcss postcss-preset-mantine postcss-simple-vars
```

(`@mantine/dropzone` is listed in the brief's package list; it's not obviously needed for a TTS reader UI unless Tamber adds "drop a document/EPUB/PDF to read aloud" — worth flagging to the integration step as a maybe-unused dependency rather than assuming it's load-bearing.)

### 3.2 `postcss.config.cjs`

```js
module.exports = {
  plugins: {
    'postcss-preset-mantine': {},
    'postcss-simple-vars': {
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    },
  },
}
```

This is Mantine's own documented config, unchanged in shape from earlier versions — `postcss-preset-mantine` handles Mantine's custom at-rules (`light-dark()`, nested selectors, etc.) and `postcss-simple-vars` supplies the breakpoint variables the preset expects.

### 3.3 Root styles import + theming + `ColorSchemeScript`

```tsx
// main.tsx
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/dropzone/styles.css'
import { createRoot } from 'react-dom/client'
import { MantineProvider, ColorSchemeScript, mantineHtmlProps } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import App from './App'

// index.html <html {...mantineHtmlProps}> and <head><ColorSchemeScript defaultColorScheme="auto" /></head>
// — ColorSchemeScript renders an inline <script> that sets data-mantine-color-scheme on <html>
// BEFORE React hydrates, reading the same localStorage key MantineProvider's color scheme
// manager writes to. This is what avoids a flash-of-wrong-theme on reload; both
// ColorSchemeScript and MantineProvider must be given the same defaultColorScheme.

createRoot(document.getElementById('root')!).render(
  <MantineProvider defaultColorScheme="auto" theme={theme}>
    <Notifications />
    <App />
  </MantineProvider>,
)
```

Since this is a plain client-rendered SPA (not SSR), `ColorSchemeScript` is still worth using exactly the same way — it prevents the one-frame flash between Mantine's default light theme and the user's actually-persisted dark/auto preference while the JS bundle boots, which matters more on this app than most because the brief calls for heavy motion/visual polish where a flash is very noticeable.

`theme` is a plain `createTheme({...})` object — nothing unusual for v9; define brand colors there once `assets/brand/BRAND.md` exists (currently a TODO — see §8 note on brand asset dependency).

---

## 4. `motion` (the framer-motion successor)

`framer-motion` was renamed to **`motion`** in late 2024; the API is unchanged, only the import path moved. For React:

```bash
npm install motion
```

```tsx
import { motion, AnimatePresence } from 'motion/react'

<motion.div
  initial={{ opacity: 0, y: 12 }}
  animate={{ opacity: 1, y: 0 }}
  exit={{ opacity: 0 }}
  transition={{ duration: 0.3, ease: 'easeOut' }}
/>
```

Registry-confirmed latest is **13.4.4** (published 2026-09-25 — i.e., yesterday relative to this research, so treat it as a fast-moving package and pin loosely with `^`). If any old reference code or a copied snippet still says `import { motion } from 'framer-motion'`, it will still resolve (the old package is kept as a redirecting shim) but new code in this repo should use `motion/react` directly per the maintainers' own migration guidance.

For the "waveform/orb visuals" requirement, `motion`'s `useAnimationFrame`/`useMotionValue`/`useTransform` hooks are the right primitives to drive a canvas or SVG orb off the `ChunkedPlayer`'s playback-position signal (see §9) without re-rendering React on every frame — critical for the "fast and responsive" requirement on mobile Safari, where React state churn at 60fps is exactly what tanks performance.

---

## 5. `vite-plugin-pwa` — installable PWA + iOS icon requirements

Current: **1.3.0**, bundling `workbox-window` **7.4.1**.

### 5.1 Minimal manifest + icons

Manifest must include `name`, `short_name`, `description`, `theme_color` (must match the `<meta name="theme-color">` in `index.html`), `scope`, and an `icons` array. Mandatory PWA icon sizes are **192×192** and **512×512** (with `any` and `maskable` purpose variants recommended); everything else the plugin can auto-generate from a source SVG via `@vite-pwa/assets-generator` if desired.

```ts
VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
  manifest: {
    name: 'Tamber',
    short_name: 'Tamber',
    description: 'Self-hosted text-to-speech, powered by Kokoro',
    theme_color: '#000000', // TODO: replace with brand color once assets/brand/BRAND.md exists
    icons: [
      { src: 'png/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'png/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'png/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
})
```

### 5.2 iOS-specific requirement (this is the one iOS actually reads)

iOS Safari does **not** read the manifest's `icons` array for its home-screen icon — it wants an explicit link tag in `index.html`:

```html
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
```

The brief's brand-assets spec already produces `png/icon-180.png`; wire it in as `/apple-touch-icon.png` (a copy or a build step alias) since that exact filename/rel convention is what iOS's "Add to Home Screen" looks for, independent of manifest `icons`. List it in `includeAssets` so Workbox precaches it too. This is a concrete, easy-to-miss gap: get the manifest icons perfect and iOS home-screen add-to-homescreen will still show a screenshot-of-the-page icon if this one `<link>` tag is missing.

Also required for a credible iOS "installed" feel: `<meta name="apple-mobile-web-app-capable" content="yes">` and `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` (standard, undeprecated despite Apple's own naming inconsistency — `mobile-web-app-capable` without `apple-` prefix is the now-standardized version other browsers use, but Safari still keys off the `apple-` prefixed one).

Manifest must be served with `application/manifest+json`, and the whole PWA (including the reverse-proxied production deployment through NetBird) must be HTTPS — already satisfied by the brief's NetBird HTTPS requirement.

Sources: [Vite PWA — PWA minimal requirements](https://vite-pwa-org.netlify.app/guide/pwa-minimal-requirements.html), [Vite PWA assets generator](https://vite-pwa-org.netlify.app/assets-generator/)

---

## 6. ESLint flat config for React + TypeScript

(See §1.3 for the important caveat that upstream `create-vite` no longer defaults to this.)

### 6.1 Base flat config

`eslint` 10.11.0 is flat-config-only. `typescript-eslint` 8.70.1 ships as one unified package (import `tseslint` from `'typescript-eslint'`, not the old scoped `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` pair, though those still work if pinned separately):

```js
// eslint.config.js
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended, // or recommendedTypeChecked for type-aware rules
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.browser,
    },
  },
])
```

Notes:
- `reactHooks.configs.flat.recommended` is the current (v7) flat-config entry point, confirmed against the `facebook/react` monorepo's `eslint-plugin-react-hooks` package today.
- `eslint/config`'s own `defineConfig`/`globalIgnores` helpers (not a third-party package) are ESLint's now-standard way to compose flat configs; prefer them over hand-rolled arrays for readability.
- For stricter type-aware linting (worth it given how much this app juggles async streaming state), swap in `tseslint.configs.recommendedTypeChecked` and add `languageOptions.parserOptions.projectService: true`.

### 6.2 `eslint-plugin-react-hooks` v7 — not a small bump

The plugin jumped from the long-stable 4.6.x line straight to a v7 rewrite (7.1.1, published 2026-04-17). Relevant for Tamber specifically because this app will lean on hooks heavily for the audio player:
- v7 adds ESLint v10 support and skips compiling non-React files (faster CI).
- v7 replaces the old single catch-all `react-compiler` rule with **individual** compiler-lint rules (better `set-state-in-effect` detection, better ref-validation, more precise messages) — useful given `ChunkedPlayer`'s effects will manage refs to `AudioContext`/`AudioBufferSourceNode` instances that must not trigger re-renders.
- 7.1.0 briefly (accidentally) dropped `component-hook-factories`; 7.1.1 restored it as a deprecated no-op. Pin `^7.1.1`, not `^7.1.0`.

Sources: [eslint-plugin-react-hooks npm](https://www.npmjs.com/package/eslint-plugin-react-hooks), [eslint-plugin-react-hooks CHANGELOG](https://github.com/facebook/react/blob/main/packages/eslint-plugin-react-hooks/CHANGELOG.md)

---

## 7. iOS Safari audio — deep dive

This is the load-bearing research for Tamber's entire player architecture, because the brief has already ruled out MSE. Everything below explains **why** that ruling is correct and what constraints it leaves in place.

### 7.1 MediaSource / ManagedMediaSource status — confirms the "never use MSE" rule

- `window.MediaSource` **does not exist** on iOS Safari. There is no unprefixed MSE on iPhone, full stop.
- Apple's answer is **`ManagedMediaSource`**, shipped iOS/iPadOS Safari **17.1** (Nov 2023). It's API-compatible with MSE but adds OS-driven memory-pressure hooks (the OS can force-evict buffered data; the app can advertise a memory budget) and a `disableRemotePlayback` flag to stop AirPlay from grabbing the managed buffer.
- **Critically, `ManagedMediaSource` only attaches to an `HTMLMediaElement`** (`<video>`/`<audio>.srcObject`), the same as classic MSE — it is not usable as an input to the Web Audio API (`AudioContext`/`AudioBufferSourceNode`). Since Tamber's whole design (word-timestamp-synced, gaplessly-scheduled playback with programmatic seek-by-chunk) is Web-Audio-native, `ManagedMediaSource` wouldn't even be an option here even ignoring iOS-version-gating concerns — it solves a different problem (adaptive HLS/DASH-style `<video>` streaming), not "decode discrete chunks and schedule them precisely." This is a second, independent confirmation (beyond the brief's own stated MSE-is-broken rationale) that the NDJSON-chunk + `decodeAudioData` approach is the only architecture that fits both iOS's constraints and Tamber's karaoke-highlighting requirement.

Sources: [ManagedMediaSource — Fora Soft glossary](https://www.forasoft.com/learn/video-streaming/glossary/terms-streaming/managed-media-source), [MSE in Safari on iOS — caniuse issue #1783](https://github.com/Fyrd/caniuse/issues/1783)

### 7.2 Autoplay policy / user-gesture requirement for `AudioContext`

- Safari (and every WebKit browser on iOS) creates a **new `AudioContext` in the `suspended` state** unless resumed from inside a user gesture's synchronous call stack.
- The gesture requirement is about the **call stack**, not just "some click happened recently": calling `audioCtx.resume()` (or constructing the context) from inside a `setTimeout`, a resolved-later `Promise.then()` after an `await`, or any other deferred callback **breaks the gesture chain** and iOS will silently refuse to unlock audio. The resume call must be synchronous within the `click`/`touchend` handler (or the first `await` in that handler must be *after* the resume call, not before it).
- Standard unlock pattern, run once, referenced from multiple independent sources:

```ts
function useAudioUnlock(ctx: AudioContext) {
  useEffect(() => {
    const unlock = () => {
      if (ctx.state === 'suspended') ctx.resume()
      // See §7.5 for the silent-switch companion call that must happen here too.
    }
    document.addEventListener('pointerdown', unlock, { once: true })
    return () => document.removeEventListener('pointerdown', unlock)
  }, [ctx])
}
```

- **`interrupted` state (Safari-specific extra state beyond the spec's `suspended`/`running`/`closed`):** when the user leaves the tab, locks the screen, or another app takes audio focus, Safari transitions the context to a fourth state, `"interrupted"` (implemented in WebKit, tied to the Audio Session API). Code must listen for `statechange` and call `resume()` again when returning to `"interrupted"` contexts — but per §7.4, resuming from background often silently fails until the *next* user gesture, so treat "interrupted" as "will need a fresh gesture to fully recover," not "auto-heals."

Sources: [WebKit — New `<video>` Policies for iOS](https://webkit.org/blog/6784/new-video-policies-for-ios/), [Matt Montag — Unlock Web Audio in Safari](https://www.mattmontag.com/web/unlock-web-audio-in-safari-for-ios-and-macos), [MSEdgeExplainers — AudioContext Interrupted State](https://microsoftedge.github.io/MSEdgeExplainers/AudioContextInterruptedState/explainer.html), [WebKit bug 231105](https://bugs.webkit.org/show_bug.cgi?id=231105)

### 7.3 `decodeAudioData`: WAV vs MP3 — **prefer WAV**

- `decodeAudioData()` is broadly available (Baseline since 2021) and Safari supports both the Promise-returning form and the legacy two-callback form.
- **Safari's MP3 decoding is stricter/buggier than Chrome/Firefox's**: some otherwise-valid MP3s (VBR-encoded, or with non-standard headers — exactly the kind of thing a TTS pipeline's chunked encoder might emit) fail to decode on Safari specifically, and there are reports of the Promise form rejecting on files the legacy-callback form decodes successfully.
- **Recommendation for Tamber: emit WAV (PCM) chunks from the API by default**, not MP3, for the reasons above — WAV decoding is deterministic and gapless on Safari with no header-quirk failure mode, at the cost of more bytes over the wire per chunk. Given chunks are sentence-sized (a few seconds of audio each), the bandwidth cost of WAV vs MP3 is small in absolute terms and reliability matters far more than the last few KB, especially on iOS where a decode failure has no graceful fallback path. If bandwidth ever becomes a real constraint (e.g., cellular), make it a server-side, per-request negotiable format — but default to WAV and treat MP3 as an opt-in, not the baseline.
- Practical implementation note: implement a Promise-form-first, legacy-callback-form-fallback wrapper around every `decodeAudioData` call regardless of format, since the failure mode above is specifically "Promise form rejects, callback form succeeds" on Safari.

Sources: [MDN — `decodeAudioData()`](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData), [Bugnet — Fix: WebAudio decodeAudioData Rejects MP3 on Safari](https://bugnet.io/blog/fix-webaudio-decodeaudiodata-rejects-mp3-on-safari)

### 7.4 Silent switch / ringer behavior — needs the Audio Session API

- By default, Safari routes **any page that creates an `AudioContext`** into the **`"ambient"`** audio session category, which **obeys the hardware silent/ring switch** — meaning Web Audio output goes silent on speaker when the phone is muted, even though `<audio>`/`<video>` elements do not (they use a different, non-ambient session by default). This asymmetry is the single most-reported iOS Web Audio gotcha.
- Fix: the **Audio Session API** (`navigator.audioSession`, part of the W3C Audio Session spec, shipped Safari **16.4**, refined in 17+): set `navigator.audioSession.type = 'playback'` (feature-detected) **before** the `AudioContext` is created/resumed, once per session — flipping it mid-session is reported to confuse iOS.

```ts
if ('audioSession' in navigator) {
  ;(navigator as any).audioSession.type = 'playback'
}
// then create/resume the AudioContext, inside the same gesture
```

  `'playback'` is the correct category for "video/music/podcast-style playback that should not mix with other playback audio" — exactly TTS narration.
- `navigator.audioSession` is Safari-only as of this writing (an Editor's Draft at W3C; wrap every access in the `'audioSession' in navigator` guard so it's a no-op elsewhere).
- A still-relevant fallback for the general "Web Audio ignores the switch" class of bugs, used before the Audio Session API existed and still cited as a belt-and-suspenders measure: a looping, effectively-silent (near-zero, not literally zero — literally-silent files are sometimes optimized away) `<audio>` element with `playsinline`, started inside the same gesture, keeps the page's overall audio session "hot." Not required if `navigator.audioSession.type = 'playback'` is set correctly, but cheap insurance given it's an Editor's-Draft API that could regress.

Sources: [W3C Audio Session — Editor's Draft](https://www.w3.org/TR/audio-session/), [MDN — `AudioSession: type`](https://developer.mozilla.org/en-US/docs/Web/API/AudioSession/type), [nattog.dev — Avoiding unmuting iOS devices for Web Audio](https://nattog.dev/blog/web-audio-ios-unmute)

### 7.5 Playing through screen lock / backgrounding

- iOS Safari **suspends Web Audio rendering as soon as the page backgrounds or the screen locks**, *unless* the page also holds an actively-playing `HTMLMediaElement` (a real `<audio>`/`<video>` tag) — a pure `AudioContext`-only page loses its audio session the moment the screen turns off.
- A WebKit bug where `AudioContext` was suspended on backgrounding *even with* `navigator.audioSession.type = 'playback'` set was fixed in WebKit main 2024-03-01 and confirmed shipped in **iOS 17.5**. Given the brief's environment note (today is 2026-09-26, and iOS versions in the field are well past 17.5), this should no longer be an issue on any realistically-current iOS — but it's worth a defensive runtime check/telemetry hook rather than assuming, since PWA-mode (added-to-home-screen, standalone `display: standalone`) has its own separate history of audio-session bugs distinct from in-Safari-tab bugs.
- **Practical pattern that both keeps the session alive and satisfies "plays through lock screen":** pair the `AudioContext`-based `ChunkedPlayer` with one real, always-present `<audio>` element (`playsinline`, muted or playing a silent/near-silent loop) purely as an anchor that keeps iOS's media/audio session open, and drive the **Media Session API** (`navigator.mediaSession.metadata`, `setActionHandler('play'|'pause'|'seekto'|...)`) off that same session so the lock screen shows title/controls and hardware media-key/AirPods taps route back into `ChunkedPlayer`'s own play/pause/seek methods. `navigator.mediaSession` artwork was buggy on iPhone pre-16.4 (fixed in Safari 16.4) — again, not a concern for any current iOS.
- One more PWA-specific gotcha worth flagging for the integration step: reports that a standalone-mode PWA which sits **paused** for ~30 seconds in the background has its audio silently die until the app returns to foreground — reinforcing that `ChunkedPlayer` should treat "resume after backgrounding" as "may require the next user tap to actually re-unlock," not something to paper over with a background timer retry loop (which would just be more deferred-callback resume calls hitting the same gesture-chain wall from §7.2).

Sources: [iOS: re-test background/lock-screen audio on iOS 17.5+ (WebKit bug is fixed)](https://github.com/fischnall3r/sadiss/issues/134), [Apple Developer Forums — WKWebView Web Audio can't play after locking screen](https://developer.apple.com/forums/thread/658375), [dbushell — iOS Web Apps and Media Session API](https://dbushell.com/2023/03/20/ios-pwa-media-session-api/), [web.dev — Media Session](https://web.dev/articles/media-session)

### 7.6 Position tracking for karaoke highlighting — don't rely on `requestAnimationFrame` timing, rely on `AudioContext.currentTime`

- `requestAnimationFrame` **stops firing entirely** when the tab is backgrounded or the screen is locked — which is actually fine for word-highlighting specifically, since there's no visible UI to update in that state anyway. The real hazard is using rAF's own timestamp (or `Date.now()`) as the source of playback position: rAF cadence is not sample-accurate and drifts under load.
- Correct pattern: track playback position as `audioCtx.currentTime - playbackStartTime + accumulatedOffset` (i.e., derived from the audio clock, which is what actually advances the speaker), and use rAF purely as the **UI tick** that reads that derived value each frame to decide which word/character-offset is "current" — never as the clock itself. This is what makes seek/pause/resume (§7.7) trivial to keep in sync: position is always a pure function of `AudioContext.currentTime` plus a small amount of bookkeeping, not an accumulating rAF-delta.

### 7.7 Pause / resume / seek with Web Audio

`AudioBufferSourceNode` has no native pause/resume/seek — once `start()`ed it can only be `stop()`ped once, and creating a new node is required to resume. The standard pattern (and what §9's `ChunkedPlayer` formalizes):
- **Pause:** record `elapsed = audioCtx.currentTime - startedAt`, call `source.stop()` on the currently-playing node (and any already-scheduled future nodes), then either call `audioCtx.suspend()` (freezes the whole context clock, cheaper, fine as long as nothing else needs the context running) or just stop scheduling new nodes.
- **Resume:** create a fresh `AudioBufferSourceNode` from the same decoded `AudioBuffer`, call `source.start(0, elapsed)` (the second argument is the in-buffer offset to start from), and re-derive `startedAt = audioCtx.currentTime - elapsed` so position tracking (§7.6) keeps working unchanged.
- **Seek:** identical to resume, but `elapsed` is set to the requested offset instead of the paused offset. Because Tamber's chunks are sentence-sized with known character offsets (per the brief), "seek by chunk" (jump to sentence N) is the natural seek granularity — sub-chunk seeking is a `start(0, offsetWithinChunk)` call away if ever needed, using the per-word timestamps already available to compute the offset.

### 7.8 Gapless scheduling of sequential chunks

The core Web Audio pattern for back-to-back buffers with **zero gap**, independent of network/decode timing:

```ts
let nextStartTime = audioCtx.currentTime // first chunk starts "now"
for (const buffer of decodedChunksInOrder) {
  const source = audioCtx.createBufferSource()
  source.buffer = buffer
  source.connect(audioCtx.destination)
  source.start(nextStartTime)          // scheduled precisely on the audio clock, not "whenever this line runs"
  nextStartTime += buffer.duration      // next chunk's start = this chunk's end, exactly
}
```

Because scheduling is done via `start(when)` against the audio clock rather than "call `.play()` when the previous one's `onended` fires," there is no JS-timer jitter between chunks — this is exactly what "gapless" requires, and it works whether the next chunk was decoded a second ago or a millisecond ago (as long as it's decoded *before* its scheduled `nextStartTime` arrives — see §9 for the queue depth this implies).

---

## 8. NDJSON over `fetch` + `ReadableStream` on Safari

- Safari **does** support consuming a streamed response body via `response.body` as a `ReadableStream` (download direction) — this is the direction Tamber needs (client reading the server's NDJSON stream), so no polyfill is required for it.
- The **separate, well-known Safari limitation** is on the **upload/request-body-streaming** direction: Safari accepts constructing a `Request` with a `ReadableStream` body but rejects passing that request to `fetch()`. This does not affect Tamber's player (which only ever streams a *response* down, and sends the TTS request as a normal buffered JSON body up), but is worth remembering if any future feature (e.g., client streams audio *up* for some reason) is considered.
- Standard NDJSON consumption pattern — buffer across chunk boundaries, since a single `Uint8Array` chunk from the reader has no guaranteed relationship to line boundaries (a chunk may end mid-line, or contain several complete lines):

```ts
async function* readNDJSON(response: Response): AsyncGenerator<unknown> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // last element may be an incomplete line; keep it for next chunk
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line)
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) // flush any trailing complete line with no final \n
}
```

  (`decoder.decode(value, { stream: true })` matters — without `{ stream: true }`, a multi-byte UTF-8 character split across two chunks gets corrupted instead of buffered correctly across the call.)

Sources: [Pamela Fox — Fetching JSON over streaming HTTP](http://blog.pamelafox.org/2023/08/fetching-json-over-streaming-http.html), [MDN — `ReadableStream`](https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream)

---

## 9. Recommended `ChunkedPlayer` architecture

Putting §7–8 together into one class. This is a design recommendation with pseudocode, not final production code — the integration step should adapt names/error-handling to the rest of `web/`'s conventions (and reuse the same core logic, minus DOM bits, for `extension/` and `mobile/`, per the brief's "same persisted settings model" / shared visual language across clients).

```
class ChunkedPlayer {
  // --- state ---
  audioCtx: AudioContext | null = null      // created lazily, inside a user gesture
  queue: DecodedChunk[] = []                 // decoded, not-yet-scheduled chunks, in order
  scheduled: ScheduledNode[] = []            // currently-playing/upcoming AudioBufferSourceNodes
  nextStartTime: number = 0                  // audio-clock time the next chunk should start at
  chunkIndex: number = 0                     // index into the full ordered chunk list (for seek-by-chunk)
  isPlaying: boolean = false
  pausedOffsetInChunk: number = 0            // for resume/seek within the currently-paused chunk

  // DecodedChunk = { index, buffer: AudioBuffer, words: WordTimestamp[], charStart, charEnd }
  // WordTimestamp = { word, startTs, endTs }   // seconds, relative to the START of this chunk's buffer

  // --- ingest: runs concurrently with playback ---
  async ingest(ndjsonStream: AsyncGenerator<RawChunk>) {
    for await (const raw of ndjsonStream) {
      const audioBytes = base64Decode(raw.audioBase64)
      const buffer = await decodeWithFallback(this.audioCtx, audioBytes)   // §7.3: Promise-first, callback-fallback
      this.queue.push({ index: raw.index, buffer, words: raw.words, charStart: raw.charStart, charEnd: raw.charEnd })
      this.maybeScheduleAhead()   // opportunistically schedule as soon as decode finishes, don't wait for ingest to finish
    }
  }

  // --- unlock + start: MUST be called synchronously from a user-gesture handler (§7.2, §7.4) ---
  unlockAndPlay() {
    if (!this.audioCtx) {
      if ('audioSession' in navigator) navigator.audioSession.type = 'playback'   // §7.4 — before context creation
      this.audioCtx = new AudioContext()
    }
    if (this.audioCtx.state === 'suspended' || this.audioCtx.state === 'interrupted') {
      this.audioCtx.resume()   // §7.2 / §7.5 — synchronous, same gesture, no awaits before this line
    }
    this.isPlaying = true
    this.nextStartTime = this.audioCtx.currentTime
    this.maybeScheduleAhead()
  }

  // --- gapless scheduling (§7.8), keeps a lookahead window of decoded-but-not-yet-played chunks scheduled ---
  maybeScheduleAhead() {
    if (!this.isPlaying) return
    while (this.queue.length > 0 && this.scheduled.length < LOOKAHEAD_CHUNKS) {
      const chunk = this.queue.shift()!
      const source = this.audioCtx.createBufferSource()
      source.buffer = chunk.buffer
      source.connect(this.audioCtx.destination)
      const startAt = this.nextStartTime
      source.start(startAt, chunk === resumingChunk ? this.pausedOffsetInChunk : 0)
      source.onended = () => this.onChunkEnded(chunk)
      this.scheduled.push({ chunk, source, startAt })
      this.nextStartTime += chunk.buffer.duration   // exact end-to-end, no gap
    }
  }

  // --- position tracking (§7.6): derive from audio clock, never from rAF's own timestamp ---
  getCurrentWord(): WordTimestamp | null {
    if (!this.isPlaying) return null
    const playing = this.scheduled[0]
    if (!playing) return null
    const elapsedInChunk = this.audioCtx.currentTime - playing.startAt
    return playing.chunk.words.find(w => elapsedInChunk >= w.startTs && elapsedInChunk < w.endTs) ?? null
  }
  // UI layer calls getCurrentWord() once per rAF tick to update the karaoke highlight —
  // rAF is just the tick source, the clock is always audioCtx.currentTime.

  // --- pause / resume (§7.7) ---
  pause() {
    const playing = this.scheduled[0]
    if (playing) this.pausedOffsetInChunk = this.audioCtx.currentTime - playing.startAt
    for (const { source } of this.scheduled) source.stop()
    this.scheduled = []
    this.isPlaying = false
    // requeue the interrupted chunk (and anything after it) back onto `queue` at the front,
    // so unlockAndPlay()'s next maybeScheduleAhead() restarts it at pausedOffsetInChunk.
  }

  resume() { this.unlockAndPlay() }   // re-runs the same gesture-safe unlock path; must be called from a gesture too,
                                       // since a backgrounded/interrupted context may need a fresh gesture (§7.5)

  // --- seek-by-chunk (§7.7): jump to a specific sentence, e.g. from a tap on that sentence in the transcript ---
  seekToChunk(index: number, offsetWithinChunk = 0) {
    for (const { source } of this.scheduled) source.stop()
    this.scheduled = []
    this.chunkIndex = index
    this.pausedOffsetInChunk = offsetWithinChunk
    // drop any buffered chunks before `index` from `queue`, or re-fetch from the server
    // starting at chunk `index` if it's already scrolled out of the client-side queue —
    // this is why the server protocol should support "start streaming from chunk N",
    // not just "from the beginning," if seek-far-ahead is a required UX (worth flagging to api/).
    this.unlockAndPlay()
  }
}
```

Key design decisions this encodes:
1. **`AudioContext` creation and every `resume()` call are gesture-gated**, never called from inside `ingest()`'s async loop or any `.then()`/`await`-continuation — only from a handler directly wired to a `click`/`pointerdown` event.
2. **Decoding runs ahead of playback** (`ingest()` is a separate concurrent loop from scheduling), decoupling "how fast the network/server produces chunks" from "how precisely chunks are scheduled" — a slow chunk 6 doesn't stall chunk 5's gapless start as long as chunk 6 finishes decoding before chunk 5 ends.
3. **A bounded lookahead window** (`LOOKAHEAD_CHUNKS`, e.g. 2–3) avoids scheduling the entire response at once (unbounded memory for a long article) while keeping enough buffer that normal network jitter never causes an audible gap.
4. **Position is always derived from `audioCtx.currentTime`**, so pause/resume/seek only ever need to manage *which chunk* and *what offset*, not a separately-tracked "elapsed time" that could drift from what's actually audible.
5. **Seek-by-chunk assumes the server can resume a stream from an arbitrary chunk index** — this is a `api/` protocol requirement this research surfaces for the integration step, not something `web/` can solve alone if the current NDJSON protocol only supports "stream from the start."

---

## Summary of concrete recommendations for the integration step

- Pin `typescript@^7.0.2` (native compiler) — verify the CI/build image has this actually installed rather than a cached older `typescript`, since the perf/behavior difference is large.
- Pin all four `@mantine/*` packages together at `^9.6.2`; confirm brand theme colors go into a `createTheme()` object once `assets/brand/BRAND.md` lands (currently a TODO — brand assets weren't present at research time; leave a `// TODO: brand theme colors` marker in the theme file).
- Import animation from `motion/react`, not `framer-motion`.
- Default TTS audio chunk format to **WAV**, not MP3, given Safari's documented MP3 decode fragility — make it configurable server-side but WAV-by-default.
- Ship both the manifest `icons` array **and** the explicit `<link rel="apple-touch-icon" sizes="180x180">` tag — iOS ignores the manifest for its home-screen icon.
- Set `navigator.audioSession.type = 'playback'` (feature-detected) before every `AudioContext` creation/resume — without it, TTS narration goes silent on speaker whenever the phone's silent switch is on, which will look like a total playback failure to users.
- Use ESLint flat config with `typescript-eslint` 8.x + `eslint-plugin-react-hooks` 7.1.1's `configs.flat.recommended` + `eslint-plugin-react-refresh`'s `configs.vite`; revisit Oxlint later given it's now upstream Vite's own default.
- Surface to `api/`'s design: does the NDJSON protocol need to support "resume streaming from chunk N" for a good seek-far-ahead UX? (§9, point 5)
