# Mobile (React Native / Expo) — Research for Tamber

Researched 2026-09-26 against live registries and official docs. All version numbers below were verified against npm/Expo sources on this date (see inline citations) — **do not hand-pin these numbers in `package.json`; always resolve via `npx expo install <pkg>`**, which selects the exact patch Expo's dependency-validation service has certified for the installed SDK. A raw `npm view <pkg> version` (or `npm install`) can return a newer build that is *not* what the SDK expects — this bit the React version check below (npm's global `react` latest is 19.3.0, but Expo SDK 57 is built and validated against 19.2.x; `expo install` gets this right automatically).

---

## 1. Executive summary / recommendation

- **Expo SDK 57** (React Native 0.86, React 19.2.x), file-based routing via **expo-router**, all built with a **custom dev client** from day one — Tamber cannot use Expo Go because share-intent handling requires custom native code. This means there is no loss in choosing `react-native-mmkv` over `AsyncStorage` either — both require a rebuild anyway.
- **Audio playback**: `expo-audio`'s new **`AudioPlaylist`** class is the right primitive for gapless sequential chunk playback — it is a native queue (add/insert/remove/next) rather than something we hand-roll with multiple `AudioPlayer` instances.
- **Streaming the NDJSON body**: SDK 57's `expo/fetch` (installed globally) supports real `response.body.getReader()` streaming on both platforms — this is the load-bearing fact that makes the "stream chunks, don't wait for the whole response" design possible on RN, mirroring the web client. There is one Android-only gotcha (Brotli buffering) with a one-line fix (force `Accept-Encoding: identity`).
- **Word highlighting**: poll `AudioPlaylist.currentIndex` / `currentTime` (synchronous JSI properties) on a `requestAnimationFrame` or short `setInterval` loop rather than relying on the default 500 ms `playbackStatusUpdate` event; `useAudioPlayer`'s `updateInterval` option can go as low as you want but a manual RAF loop reading the synchronous property is smoother for karaoke-style highlighting.
- **Sharing in**: `expo-share-intent` (config plugin, v8.x) is the only actively-maintained, Expo-native option; `react-native-share-menu` is stale (last publish ~4 years ago); `react-native-receive-sharing-intent` is a viable non-Expo fallback but expo-share-intent is purpose-built for this stack and is what should be used.
- **Settings persistence**: `react-native-mmkv` v4 (Nitro module, New-Architecture-only — fine, New Arch is mandatory since SDK 55) + `zustand` `persist`/`createJSONStorage`, matching the web client's zustand-persist pattern conceptually.
- **Windows host**: Android dev-client builds run fully locally on Windows (`npx expo run:android`). iOS dev-client/device builds **must** go through EAS Build's macOS cloud runners — there is no way around a Mac/cloud-Mac for iOS native compilation. A brand-new (Sept 14, 2026) **EAS Simulator** preview streams a cloud iOS Simulator into a browser tab for hot-reload testing from Windows, but it's a waitlisted preview and does not confirm Share-Extension support.

---

## 2. Core Expo/React Native versions (verified 2026-09-26)

| Package | Latest verified version | Notes / source |
|---|---|---|
| `expo` | **57.0.25** | npm dist-tags `latest`. SDK 57 is the current stable train (SDK 57 GA'd 2026-06-30; no SDK 58 beta announced yet, though the SDK 57 changelog already telegraphs an SDK 58 change re: iOS scene-based lifecycle). [Expo SDK 57 changelog](https://expo.dev/changelog/sdk-57), [docs.expo.dev/versions/latest](https://docs.expo.dev/versions/latest/) |
| `react-native` | **0.86.x** | Bundled by SDK 57. |
| `react` | **19.2.x** (not raw npm `latest` 19.3.0) | Expo SDK 57 is built/validated against React 19.2; `expo install` will pin the correct 19.2.x patch, don't take npm's `react@latest`. |
| `expo-router` | **57.0.22** | Now version-aliased to the SDK number (this is Expo's new package-versioning scheme — most first-party `expo-*` packages version-track the SDK major as of SDK 54+). [npm](https://www.npmjs.com/package/expo-router) |
| `expo-audio` | **57.0.5** | SDK-aliased version. |
| `expo-file-system` | **57.0.7** | SDK-aliased version. |
| `expo-clipboard` | **57.0.2** | SDK-aliased version. |
| `expo-document-picker` | **57.0.0** | SDK-aliased version. |
| `expo-dev-client` | **57.0.19** | SDK-aliased version. |
| `expo-share-intent` | **8.0.1** | Third-party, independently versioned; its own compat table maps SDK 57 → v8.0+, SDK 56 → v7.0+, SDK 55 → v6.0+, SDK 54 → v5.0+. [GitHub](https://github.com/achorein/expo-share-intent) |
| `react-native-reanimated` | **4.7.0** | Supports RN 0.86–0.88, pairs with `react-native-worklets` 0.13.x. New-Architecture only (v4.x line). [npm](https://www.npmjs.com/package/react-native-reanimated) |
| `react-native-worklets` | (peer of reanimated 4.x) | Separate package now — the babel plugin moved from `react-native-reanimated/plugin` to **`react-native-worklets/plugin`**. |
| `react-native-mmkv` | **4.3.2** | Nitro Module; New-Architecture only. |
| `@react-native-async-storage/async-storage` | **3.1.1** | Published 2026-05-29; still fine for Expo Go-compatible projects, but Tamber doesn't need Expo Go compatibility. |
| `zustand` | **5.0.15** | |

**New Architecture is mandatory** as of SDK 55 (RN 0.83) — the legacy architecture opt-out flag was removed from the config schema entirely; `newArchEnabled: false` is now silently ignored. SDK 57 has no old-architecture path. This matters because it's *why* `react-native-mmkv` v4 (Nitro-only) and `react-native-reanimated` v4 (New-Arch-only) are both safe defaults for Tamber — there's no legacy-arch app to support. [Expo blog: "Out with the old, in with the New Architecture"](https://expo.dev/blog/out-with-the-old-in-with-the-new-architecture)

---

## 3. expo-router

Latest version tracks the SDK (57.0.22). File-based routing, works the same conceptually as before — `app/` directory, `_layout.tsx` files, typed routes. The one Tamber-specific wrinkle is the **share-intent + expo-router interaction** (see §5): because native share events arrive as a deep-link URL, the router's root `_layout.tsx` is the only place that reliably observes them, so the share-intent-consuming screen/logic has to live there (or be driven by a Provider mounted above the router), not in a leaf screen.

---

## 4. Audio playback: `expo-audio`

`expo-audio` is the maintained successor to the deprecated `expo-av`; `expo-av`'s audio module is fully removed from Expo Go and unpatched as of SDK 55+. Install via `npx expo install expo-audio`.

### 4.1 Player hooks and imperative API

```ts
import { useAudioPlayer, useAudioPlayerStatus, createAudioPlayer } from 'expo-audio';

// Managed — disposes automatically on unmount
const player = useAudioPlayer(source, options);
const status = useAudioPlayerStatus(player); // AudioStatus: currentTime, duration, playing, isLoaded, isBuffering...

// Unmanaged — you must call player.release() yourself; only for advanced cases
const player2 = createAudioPlayer(source, options);
```

`AudioPlayer` surface (properties): `currentTime`, `duration`, `playing`, `paused`, `isLoaded`, `isBuffering`, `volume`, `muted`, `loop`, `playbackRate`, `shouldCorrectPitch`, `isAudioSamplingSupported`.
Methods: `play()`, `pause()`, `seekTo(seconds, toleranceMillisBefore?, toleranceMillisAfter?)`, `replace(source)`, `setActiveForLockScreen(active, metadata?, options?)`, `updateLockScreenMetadata(metadata)`, `clearLockScreenControls()`, `setPlaybackRate(rate, pitchCorrectionQuality?)`, `remove()`.

`AudioSource` accepts: a `require()` asset, an http(s) URL string, or `{ uri, headers?, name? }` / `{ assetId }`.

### 4.2 `AudioPlayerOptions` — the polling-rate knob

```ts
type AudioPlayerOptions = {
  updateInterval?: number;              // ms between playbackStatusUpdate events; default 500
  downloadFirst?: boolean;
  preferredForwardBufferDuration?: number; // seconds to buffer ahead
  keepAudioSessionActive?: boolean;     // iOS: don't deactivate session on pause/finish
  crossOrigin?: 'anonymous' | 'use-credentials'; // web only
};

const player = useAudioPlayer(source, { updateInterval: 100 });
```

`updateInterval` defaults to **500 ms**, far too coarse for karaoke-style word highlighting. It *can* be set low (e.g. 100 ms via the event), but for smooth per-word sync the better pattern is: don't wait on the event at all — read `player.currentTime` (or `playlist.currentTime`) **synchronously** off the JSI shared object inside a `requestAnimationFrame` loop, matching the web client's `requestAnimationFrame` timestamp-highlighting approach. This avoids event-bridge overhead entirely and gives sub-frame-accurate reads.

### 4.3 `AudioPlaylist` — the gapless-queue primitive Tamber needs

This is the single most important finding for the mobile architecture. `expo-audio` now ships a native **`AudioPlaylist`** class (extends `SharedObject`) purpose-built for gapless multi-track queueing — it removes the need to hand-roll double-buffered `AudioPlayer` instances (which the community was doing before this API existed; see the now-superseded [gapless-playback discussion #35019](https://github.com/expo/expo/discussions/35019), where developers reported memory leaks from manually juggling multiple players).

```ts
import { useAudioPlaylist } from 'expo-audio';

const playlist = useAudioPlaylist({ sources: [], loop: 'none' });

// As each NDJSON line arrives and its audio chunk is decoded/written to a local file:
playlist.add({ uri: chunkFileUri });   // appended to the tail; plays gaplessly after the current track
playlist.play();
```

Properties: `currentIndex` (read-only), `currentTime`, `duration` (of current track), `isBuffering`, `isLoaded`, `loop` (`AudioPlaylistLoopMode`), `muted`, `playbackRate`, `playing`, `sources` (read-only `AudioSourceInfo[]`), `trackCount` (read-only), `volume`.
Methods: `play()`, `pause()`, `next()`, `previous()`, `skipTo(index)`, `seekTo(seconds)`, `add(source)`, `insert(source, index)`, `remove(index)`, `clear()`, `destroy()`.

**Recommended mapping to Tamber's NDJSON design:** for each NDJSON line received, decode/write its base64 audio chunk to a local cache file (see §6), then `playlist.add({ uri })`. Word-timestamp/char-offset metadata for that chunk is kept in a parallel JS array indexed the same way `sources` grows, so on every animation frame you read `playlist.currentIndex` + `playlist.currentTime` and binary-search that chunk's word-timestamp array — exactly the same algorithm the web client runs against its own decoded-buffer queue, just fed by native gapless playback instead of Web Audio scheduling.

### 4.4 Base64 / data-URI audio sources — historical bug, now fixed, but write-to-file is still the safer default

- **[Issue #37018](https://github.com/expo/expo/issues/37018)**: `useAudioPlayer("data:audio/mp3;base64,...")` silently did nothing on iOS because `AVURLAsset` does not support `data:` URIs (a recurrence of an identical old `expo-av` bug, #24711).
- **Fixed** by [PR #37031](https://github.com/expo/expo/pull/37031) (merged 2025-05-23, i.e. before SDK 54 GA'd): the native module itself now writes the base64 payload to a temporary file and points `AVURLAsset` at that file URL. This fix is present in every SDK 57 `expo-audio` release.
- **Recommendation for Tamber anyway**: still write each chunk to a real file via `expo-file-system` and pass a `file://` URI into `AudioPlaylist.add()`/`AudioPlayer.replace()`, rather than relying on the internal data-URI shim. Reasons: (1) it's the one code path exercised identically on iOS *and* Android *and* matches what you'd do to persist a chunk for retry/seek-back anyway; (2) it sidesteps relying on undocumented internal behavior of a fix that was only validated for the single-`AudioPlayer` case, not (as far as the docs/GitHub history show) explicitly re-tested against `AudioPlaylist.add()`. Treat "pass a data: URI directly" as unverified for the playlist API specifically.

### 4.5 Background audio

Config plugin (`app.config.ts` plugins array):

```json
["expo-audio", {
  "enableBackgroundPlayback": true,
  "enableBackgroundRecording": false,
  "microphonePermission": false
}]
```

- **iOS**: `enableBackgroundPlayback: true` adds `UIBackgroundModes: ["audio"]` to `Info.plist` automatically — no manual Info.plist edit needed under Continuous Native Generation (CNG)/prebuild.
- **Android**: adds `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permissions and a Media3-session-backed foreground service (`expo.modules.audio.service.AudioControlsService`) automatically.
- **Important Android caveat from the docs**: sustained background playback on Android **requires** calling `player.setActiveForLockScreen(true, metadata)` (or the playlist equivalent) — without an active lock-screen/media-session registration, Android kills background audio after roughly 3 minutes. Given Tamber's spoken-article use case (potentially long articles), this call must be wired up, not treated as optional lock-screen decoration.
- Android's Media3/ExoPlayer backend (used by `expo-audio` instead of the legacy `MediaPlayer`) is also why gapless playback, HLS, and lock-screen metadata "work out of the box" on that platform per the docs.

---

## 5. Receiving shared content

### 5.1 `expo-share-intent` (recommended)

Latest **8.0.1**, an Expo native module + config plugin. Compat: SDK57→8.0+, SDK56→7.0+, SDK55→6.0+, SDK54→5.0+. Peer deps historically included `expo-linking` (>=6.3.1, i.e. Expo 52+) and `expo-constants`.

**Payload shape** delivered via the hook:

```ts
type ShareIntent = {
  text?: string;        // raw shared text, or a URL as text
  webUrl?: string;       // extracted link, when the shared payload is/contains a URL
  files?: {               // shared files (docs, images, videos)
    path: string;
    mimeType: string;
    fileName: string;
    size: number;
    width?: number; height?: number; duration?: number; // for images/video
  }[];
  meta?: { title?: string; [ogTag: string]: string }; // webpage metadata (iOS, needs NSExtensionActivationSupportsWebPageWithMaxCount)
};
```

**Hook API**:

```ts
const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent();
// or, for multi-screen apps: <ShareIntentProvider> + useShareIntentContext()
```

**Config plugin** (`app.config.ts`):

```json
["expo-share-intent", {
  "iosActivationRules": {
    "NSExtensionActivationSupportsText": true,
    "NSExtensionActivationSupportsWebURLWithMaxCount": 1,
    "NSExtensionActivationSupportsWebPageWithMaxCount": 1
  },
  "androidIntentFilters": ["text/*"],
  "androidMultiIntentFilters": [],
  "iosAppGroupIdentifier": "group.com.yourorg.tamber"
}]
```
Other options: `iosShareExtensionName`, `disableAndroid`/`disableIOS`, `preprocessorInjectJS` (inject JS into a shared webpage before extracting text/meta — potentially useful for Tamber's "share a webpage → read it aloud" flow, since it lets you run a readability-style extraction script inside the share extension's webview before handing text back to the app).

**Expo Router integration**: because the share event arrives as a deep link, expo-router needs a mapping function wired into its linking config (or the load logic placed in the root `_layout.tsx`) — this is *not* automatic the way a normal route param would be. The package's example repo includes a worked `example/expo-router` reference implementation.

**Hard limitation — confirmed**: **Expo Go cannot run this package.** It requires native code (an iOS Share Extension target + Android intent-filter activity), so the workflow is `expo prebuild --no-install --clean` then `expo run:ios` / `expo run:android`, or an EAS dev-client build. There is no way to preview share-intent behavior in Expo Go, full stop — this is exactly the "iOS Share Extensions cannot be tested in Expo Go" constraint called out in the task brief, confirmed at the package level.

### 5.2 Alternatives (why `expo-share-intent` still wins)

| Package | Status | Verdict |
|---|---|---|
| `react-native-share-menu` | Latest **6.0.0**, last published **~4 years ago** (2,020 weekly downloads, 677 stars) | Stale; avoid. |
| `react-native-receive-sharing-intent` | More recent activity than share-menu (1,490 weekly downloads, 326 stars); supports iOS Share Extension + Android `ACTION_SEND`, and is the acknowledged inspiration behind `expo-share-intent` | Viable if you need to eject from Expo's config-plugin model entirely, but offers no advantage over `expo-share-intent` for a managed/CNG Expo workflow — extra manual native wiring for no functional gain here. |

**Recommendation**: `expo-share-intent`. It's Expo-config-plugin-native (fits Tamber's CNG-based prebuild workflow used everywhere else), is the most actively-tracked against current SDKs (explicit SDK57 compat entry), and its `files`/`webUrl`/`meta` payload shape already covers Tamber's three input modes (shared text, shared URL/webpage, shared document file).

### 5.3 Paste and file-import fallbacks

- **`expo-clipboard`** (v57.0.2): `Clipboard.getStringAsync()` / `hasStringAsync()` for the "paste text" flow — simple, stable API, no config plugin needed.
- **`expo-document-picker`** (v57.0.0): `getDocumentAsync({ type: '*/*' | 'application/pdf' | ..., multiple: false, copyToCacheDirectory: true })` for "import a document" as a manual fallback to the share-sheet flow. Returns `{ canceled, assets: [{ uri, name, mimeType, size, ... }] }`; files are copied into the app's cache dir by default so they're immediately usable with `expo-file-system`/upload.

---

## 6. `expo-file-system` for writing streamed chunks

SDK 54+ ships a **new class-based API** (`File`, `Directory`, `Paths`) alongside a `expo-file-system/legacy` import for the old function-based API (which now throws at runtime if you import the *new* package's default export path incorrectly — use the explicit `/legacy` subpath if you need the old surface during migration).

```ts
import { File, Directory, Paths, FileMode } from 'expo-file-system';

// One-shot write of a base64 chunk to a cache file (simplest, fine for sentence-sized chunks)
const chunkFile = new File(Paths.cache, `chunk-${index}.wav`);
chunkFile.write(base64Chunk, { encoding: 'base64' });
// chunkFile.uri -> pass straight into playlist.add({ uri: chunkFile.uri })

// Incremental / handle-based writes, if you ever need to append across ticks
const handle = chunkFile.open(FileMode.ReadWrite);
handle.writeBytes(new Uint8Array([...]));
handle.close();

// Or a WHATWG WritableStream
const writable = chunkFile.writableStream();
```

For Tamber's chunk sizes (sentence-length audio, base64-decoded to a WAV/MP3 blob), the simple one-shot `file.write(base64, { encoding: 'base64' })` per chunk is sufficient — no need for the `FileHandle`/`writableStream` incremental APIs unless a single chunk itself needs to be written across multiple ticks (it won't be, since NDJSON already delivers one complete chunk per line).

---

## 7. Reading the NDJSON stream on React Native

This is the load-bearing technical risk for the mobile client, because it's the one place RN's platform behavior most diverges from web/browser fetch — flagged explicitly because it directly threatens the "never use MediaSource, stream NDJSON instead" design if it turns out RN can't stream at all.

- **Bare Hermes + RN's historic fetch polyfill cannot stream**: Hermes does not implement `ReadableStream`, and RN's built-in `fetch` (built on top of `XMLHttpRequest`) does not expose a real `response.body.getReader()` — this silently breaks any code (LLM SDKs, etc.) that assumes standard `fetch` streaming semantics. This is the mechanism, not just a version gap: even on the latest RN, the *bare* polyfill still doesn't stream.
- **The fix, and what Tamber should actually use**: since **SDK 57, `expo/fetch` is installed as the global `fetch`** on both Android and iOS — i.e. plain `fetch(...)` calls in an SDK 57 Expo app already get Expo's WinterCG-compliant implementation, not RN's old XHR-backed polyfill. Downloads/streamed responses work correctly with `response.body.getReader()` on `expo/fetch`.
- **Known caveat (Android only)**: as of `expo` 57.0.18, Brotli-compressed streamed responses were held in a native `BrotliInputStream` buffer until either 8 KiB accumulated or the stream ended — defeating incremental delivery. Confirmed **fixed** upstream, but the safe, zero-risk mitigation (works regardless of patch version) is to have the mobile client explicitly send `Accept-Encoding: identity` (or `gzip`) on the request to Tamber's streaming TTS endpoint, so Brotli is never negotiated for that route in the first place. This should also just be a server-side decision: **don't enable Brotli on the NDJSON streaming route at all** — Brotli buys nothing for a low-latency chunked stream and this Android edge case is reason enough to keep that route on `identity`/`gzip` (or chunked transfer with no compression) universally.
- **Request-body streaming is still buffered** in `expo/fetch` (an uploaded/streamed request body is drained into one buffer before the request starts) — irrelevant here since Tamber's client only ever *downloads* the NDJSON stream; the outbound request is a small JSON/form body.

**Practical NDJSON-parsing pattern** (same shape as the web client's, just RN's `TextDecoder`/`fetch` instead of the browser's):

```ts
const response = await fetch(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
  body: JSON.stringify({ text, voice, speed }),
});
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIdx);
    buffer = buffer.slice(newlineIdx + 1);
    if (line.trim()) handleChunk(JSON.parse(line)); // { audioBase64, words: [...], charStart, charEnd }
  }
}
```

`handleChunk` is where you write the chunk's base64 audio to a cache file (§6) and `playlist.add({ uri })` (§4.3), plus stash the chunk's word/offset metadata indexed by the playlist position it was just added at.

---

## 8. Settings persistence

**Recommendation: `react-native-mmkv` v4 + `zustand` `persist`.** Rationale: Tamber's app already requires a custom dev client (share-intent forces this — see §5.1), so MMKV's loss of Expo Go compatibility costs nothing, and it's ~30x faster / synchronous vs. `AsyncStorage`, which matters for settings read on every render (voice, speed, format, API URL, theme) rather than only at startup.

```ts
// mmkvZustandStorage.ts
import { MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

const storage = new MMKV({ id: 'tamber-settings' });

export const mmkvStorage: StateStorage = {
  setItem: (key, value) => storage.set(key, value),
  getItem: (key) => storage.getString(key) ?? null,
  removeItem: (key) => storage.delete(key),
};
```

```ts
// settingsStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from './mmkvZustandStorage';

export const useSettingsStore = create(
  persist(
    (set) => ({
      voice: 'af_heart',
      speed: 1.0,
      format: 'wav',
      apiBaseUrl: '',
      apiKey: '',
      theme: 'system',
      // ...setters
    }),
    { name: 'tamber-settings', storage: createJSONStorage(() => mmkvStorage) }
  )
);
```

This is the direct RN analogue of the web client's `zustand`+`persist`+`localStorage` pattern and the extension's `chrome.storage.sync`-backed store — same store shape, different storage adapter per platform, which is the right way to share the settings *schema* across all three clients even though the underlying persistence primitive differs.

If MMKV's native-module requirement were ever a blocker, `@react-native-async-storage/async-storage` (v3.1.1) + the same `createJSONStorage` pattern is a drop-in fallback — but given the dev-client requirement is unavoidable anyway, there's no reason to take the AsyncStorage performance hit.

---

## 9. `react-native-reanimated` for animation

Latest **4.7.0**. Supports RN 0.86–0.88 (matches SDK 57's RN 0.86), pairs with **`react-native-worklets` 0.13.x** (now a separate peer package). **New Architecture only** — fine, since New Arch is mandatory on SDK 55+ anyway.

Setup:
```
npx expo install react-native-reanimated react-native-worklets
```
`babel.config.js` — the worklets plugin **must be listed last**:
```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'], // was react-native-reanimated/plugin in v3
  };
};
```
Per Expo's own docs, Expo's starter template has included the worklets Babel plugin by default since SDK 50, but Tamber should not rely on that silently being present — declare it explicitly in `babel.config.js`. No `app.config.ts` plugin entry is required (it's a Babel-level integration, not a native config plugin); `npx expo prebuild` still needs to run once to link the native module.

---

## 10. Uploading files to the API with `FormData`

Two supported patterns, both fine on SDK 57:

**Classic RN pattern** (works with any HTTP client, including plain fetch pre/post Expo's fetch swap):
```ts
const formData = new FormData();
formData.append('file', {
  uri: pickedAsset.uri,     // file:// URI from expo-document-picker / expo-share-intent
  type: pickedAsset.mimeType ?? 'application/octet-stream',
  name: pickedAsset.name ?? pickedAsset.fileName ?? 'upload.bin',
} as any);
await fetch(`${apiBaseUrl}/ingest`, { method: 'POST', body: formData, headers: { Authorization: `Bearer ${apiKey}` } });
```
React Native's networking layer natively understands the `{ uri, type, name }` shape appended to `FormData` and streams the file off disk — you don't base64-encode it yourself.

**SDK 57 `expo/fetch`-native pattern** (using the new `File` class from §6):
```ts
import { File } from 'expo-file-system';
const file = new File(pickedAsset.uri);
const formData = new FormData();
formData.append('file', file); // File subclasses Blob; expo/fetch's multipart encoder accepts Blob-likes with a bytes() method
await fetch(`${apiBaseUrl}/ingest`, { method: 'POST', body: formData });
```
Either works; the classic `{uri,type,name}` object form is the more battle-tested/portable one and is what most third-party SDKs (Appwrite, PocketBase, etc.) generate for RN targets, so prefer it for Tamber unless there's a reason to lean on the newer `File`/Blob path.

---

## 11. What can run on Windows vs. what needs macOS/cloud

| Task | Windows-native? | Notes |
|---|---|---|
| Write/edit RN + Expo code | Yes | Standard Node/VS Code workflow. |
| `npx expo start` (Metro, JS-only iteration in an already-installed dev client) | Yes | |
| Android dev-client build (`npx expo run:android`) | **Yes, fully local** | Needs Android SDK/emulator or a device; no Mac needed at all. |
| Android EAS cloud build | Yes (trivially — it's cloud regardless of host OS) | EAS's Android builds run on Linux (GCP) runners. |
| iOS dev-client build (`npx expo run:ios`) | **No** | Requires Xcode/macOS toolchain; not available on Windows under any config. |
| iOS EAS cloud build (dev client, simulator build, or store build) | Yes, via cloud | EAS Build's iOS builds always run on Expo's macOS cloud runners — this is *the* way Windows developers get an iOS build at all. |
| `eas build --local` | **Officially unsupported on Windows** | Docs explicitly scope local builds to macOS/Linux; WSL is the closest workaround, not an official path. |
| Interactive iOS Simulator testing from Windows | **New, limited preview** | **EAS Simulator**, announced 2026-09-14: streams a cloud iOS Simulator (or Android Emulator) into a browser tab; supports hot reload against a development build (`eas simulator:start --platform ios --type agent-device --build-id <id> ...`). Currently in **limited-access preview with a waitlist** (expo.dev/services/simulators) — treat as not-yet-generally-available for planning purposes. The source material does **not** confirm Share Extension / OS share-sheet testing works inside this cloud simulator; flag this as an open question to verify empirically once the app reaches that stage, rather than assuming it. |
| TestFlight / physical-device iOS testing | Yes, indirectly | Once an EAS-cloud-built binary exists, distributing to a physical iPhone (ad hoc/internal distribution or TestFlight) works fine from a Windows-driven `eas submit`; only the *compile* step needs macOS. |

**Bottom line for Tamber's iOS Share Extension work specifically**: development can happen entirely from Windows, but *every* iOS build that exercises the Share Extension (which cannot run in Expo Go per §5.1) has to round-trip through EAS Build's cloud macOS runners, and verifying the actual OS share-sheet → extension → app handoff will need a build installed on a real iPhone (or possibly the new EAS Simulator, once confirmed) — a Windows-only, no-real-device-and-no-simulator-access loop cannot validate that specific flow.

---

## 12. Recommended package set

```
npx expo install expo-router expo-audio expo-file-system expo-clipboard expo-document-picker expo-dev-client
npx expo install expo-share-intent
npx expo install react-native-reanimated react-native-worklets
npx expo install react-native-mmkv
npm install zustand
```

(`expo install`, not `npm install`, for every `expo-*` and RN-ecosystem package with native code — it resolves the SDK-57-certified version, which is the whole point of the versioning caveat at the top of this doc. Plain `npm install` is fine only for pure-JS packages like `zustand` that have no native/SDK coupling.)

## 13. Recommended `app.config.ts` skeleton

```ts
import type { ExpoConfig } from 'expo/config';

// TODO(brand): assets/brand/icon.svg, glyph.svg, png/icon-{...}.png, favicon.ico, and
// BRAND.md are being produced by a separate agent. Reference them once they exist —
// e.g. icon: "../assets/brand/png/icon-1024.png", adaptive-icon foreground, splash image.
// Do not write into assets/brand/ from this app; only read/reference it.

const config: ExpoConfig = {
  name: 'Tamber',
  slug: 'tamber',
  scheme: 'tamber',
  newArchEnabled: true, // mandatory since SDK 55; kept explicit for clarity
  icon: './assets/icon-placeholder.png', // TODO(brand): swap for assets/brand/png/icon-1024.png
  ios: {
    bundleIdentifier: 'net.thirtytech.tamber',
    supportsTablet: true,
    infoPlist: {
      // UIBackgroundModes: ["audio"] is injected automatically by the expo-audio
      // plugin below when enableBackgroundPlayback is true — no manual entry needed.
    },
  },
  android: {
    package: 'net.thirtytech.tamber',
    // FOREGROUND_SERVICE / FOREGROUND_SERVICE_MEDIA_PLAYBACK permissions and the
    // media-session foreground service are also injected by the expo-audio plugin.
  },
  plugins: [
    'expo-router',
    [
      'expo-audio',
      {
        enableBackgroundPlayback: true,
        enableBackgroundRecording: false,
        microphonePermission: false, // Tamber doesn't record audio
      },
    ],
    [
      'expo-share-intent',
      {
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
        },
        androidIntentFilters: ['text/*'],
        iosAppGroupIdentifier: 'group.net.thirtytech.tamber',
      },
    ],
    'expo-document-picker',
    'expo-dev-client',
  ],
};

export default config;
```

`babel.config.js`:
```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'], // must be last
  };
};
```

---

## 14. Open questions / things to verify empirically (not resolvable from docs alone)

1. **`AudioPlaylist.add({ uri: dataUri })` with a base64 `data:` URI** — the underlying iOS fix (PR #37031) was demonstrated for single-`AudioPlayer` sources; whether it's equally applied inside `AudioPlaylist`'s native implementation isn't confirmed in the docs. Recommendation stands regardless: always write to a file first (§4.3/§6), which sidesteps the question.
2. **EAS Simulator + iOS Share Extension** — not confirmed either way whether a cloud-streamed iOS Simulator session can exercise the system share sheet → Tamber's Share Extension. Needs a hands-on check once a dev-client build exists; don't plan the QA process around it working until verified.
3. **Brotli-buffering fix version pin** — confirmed closed/fixed upstream but the exact `expo`/`expo-file-system`/networking-layer patch version that ships the fix wasn't stated in the issue thread as fetched. The `Accept-Encoding: identity` mitigation (§7) is version-independent and costs nothing, so apply it regardless of which exact patch you land on.
