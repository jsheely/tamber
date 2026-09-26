# @tamber/client

The shared TypeScript surface of the Tamber API, used by `web/`, `extension/` and `mobile/`.

- **Platform-neutral.** ESM, zero runtime dependencies, no DOM or Node APIs. It needs only a WHATWG `fetch`. Streaming uses `response.body.getReader()` when the runtime has it and falls back to `response.text()` when it doesn't. Base64 and UTF-8 decoding are implemented in pure TS, so it runs in browsers, MV3 service workers and offscreen documents, React Native (Expo SDK 57 `expo/fetch`) and Node 22+.
- **The contract in code.** `src/types.ts` mirrors [`docs/API.md`](../../docs/API.md) field for field. If the two disagree, fix both.
- **Built with TypeScript 7** (`tsc`) to `dist/` (JS, `.d.ts`, source maps). Consumers import the built output.

## Commands

```sh
# from the repo root (the package is a pnpm workspace)
pnpm install
pnpm --filter @tamber/client build       # tsc -> dist/ (only needed for dist/ consumers and this package's tests)
pnpm --filter @tamber/client typecheck   # strict typecheck + DOM-compat check
pnpm --filter @tamber/client test        # build + node --test (no extra deps)
pnpm --filter @tamber/client fixtures    # regenerate fixtures/chunking.json after changing src/chunking.ts

# web, extension and mobile resolve this package from src/ through the "source" export condition
# (first in every `exports` entry), so edits here hot-reload in every app without a build.
```

## Public surface

| Module | Exports |
|---|---|
| `types` | Every request, response and event type: `TtsRequest`, `TtsEvent` (`start` / `queued` / `chunk` / `done` / `error` / `ping`), `TtsResult`, `WordTiming`, `ChunkSpan`, `Voice`, `VoicesResponse`, `HealthResponse`, `ExtractResponse`, `OpenAISpeechRequest`, `ModelsResponse`, `ApiErrorBody`, `ErrorCode`, `LangCode`, `AudioFormat`, `ChunkMode` |
| `client` | `TamberClient` (`health`, `getVoices`, `getModels`, `voicePreview`, `extract` / `extractUrl` / `extractHtml` / `extractFile`, `synthesize` (async iterator over NDJSON events), `synthesizeToResult`, `speech`, `testConnection`, `url`, `withOptions`, `fromSettings`), `ttsRequestFromSettings`, `API_VERSION` |
| `errors` | `TamberError`, `TamberApiError` (`status`, `code`, `requestId`, `retryAfter`, `isAuthError`, `isRetryable`), `TamberNetworkError`, `TamberProtocolError`, `TamberStreamError`, `TamberTimeoutError`, `isAbortError` |
| `settings` | `TamberSettings`, `DEFAULT_SETTINGS`, `createDefaultSettings`, `migrateSettings`, `updateSettings`, `splitSecrets`, `normalizeBaseUrl`, `isValidBaseUrl`, `toggleFavoriteVoice`, `SETTINGS_STORAGE_KEY`, `SETTINGS_VERSION`, `SECRET_SETTING_KEYS`, `SPEED_MIN` / `SPEED_MAX` / `SPEED_STEP` |
| `timeline` | `buildTimeline`, `TimelineBuilder`, `wordIndexAt`, `chunkPositionAt`, `wordIndexAtChar`, `chunkPositionAtChar`, `timeForCharOffset`, `toAbsolute` |
| `chunking` | `planChunks` (the reference chunk planner the server must match), `splitParagraphs`, `splitSentences`, `splitLongSentence`, `chunkIndexForOffset`, `CHUNK_TARGET_CHARS_DEFAULT`, `CHUNK_MAX_CHARS_DEFAULT` |
| `voice-spec` | `parseVoiceSpec`, `formatVoiceSpec`, `canonicalVoiceSpec`, `normalizedWeights`, `isBlend`, `VOICE_ID_PATTERN`, `VoiceSpecError` |
| `languages` | `LANGUAGES`, `LANG_ALIASES`, `resolveLang`, `langOfVoiceId`, `genderOfVoiceId`, `displayNameOfVoiceId` |
| `ndjson` | `readNdjson`, `NdjsonLineSplitter`, `parseNdjsonText`, `toTtsEvent` |
| `encoding` | `base64ToBytes`, `bytesToBase64`, `Utf8StreamDecoder` |
| `wav` | `parseWav`, `wavHeader`, `concatWav` (stitch WAV chunks into one downloadable file) |
| `@tamber/client/brand` | `brand`, `violetShades`, `cyanShades`, `darkShades`, `themeSpec` (shared visual tokens) |
| `@tamber/client/fixtures/chunking.json` | Chunk-planner conformance cases (also read by the Python API tests) |

## Usage

```ts
import {
  TamberClient, TimelineBuilder, wordIndexAt, base64ToBytes, isAbortError,
  migrateSettings, ttsRequestFromSettings,
} from '@tamber/client';

const settings = migrateSettings(JSON.parse(localStorage.getItem('tamber.settings') ?? 'null'));
const client = TamberClient.fromSettings(settings); // apiBaseUrl '' = same origin

const ctrl = new AbortController();
const timeline = new TimelineBuilder();
try {
  for await (const ev of client.synthesize(ttsRequestFromSettings(settings, text), { signal: ctrl.signal })) {
    switch (ev.type) {
      case 'start':  /* ev.total_chunks, ev.chunks (full plan), ev.word_timestamps */ break;
      case 'chunk': {
        const bytes = base64ToBytes(ev.audio);            // one complete WAV/MP3 file
        const buffer = await decode(bytes);                // e.g. AudioContext.decodeAudioData
        timeline.add(ev, buffer.duration);                 // prefer the decoded duration
        schedule(buffer);                                  // gapless: start(when = previous end)
        break;
      }
      case 'error':  /* non-fatal: that chunk was skipped */ break;
      case 'done':   break;
    }
  }
} catch (err) {
  if (!isAbortError(err)) throw err;
}

// every animation frame:
const active = wordIndexAt(timeline.timeline, currentPlaybackTime); // -1 = none
```

React Native: pass `headers: { 'Accept-Encoding': 'identity' }` so streamed responses are never compressed-and-buffered, and pass `{ uri, name, type }` as `file` to `extractFile`.

## Rules for consumers

- Render exactly the string you sent as `text`. All offsets are UTF-16 indices into it (`text.slice(char_start, char_end)`).
- Ignore unknown event types and unknown fields. The client already skips unknown event types.
- Schedule chunks back-to-back and advance the timeline with the decoded duration.
- Persist settings under `SETTINGS_STORAGE_KEY` and always run loaded data through `migrateSettings`. Keep `apiKey` in the most private storage the platform offers (`splitSecrets`).
