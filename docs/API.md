# Tamber HTTP API, v1

This is the contract between `api/` and every client (`web/`, `extension/`, `mobile/`, third-party tools). [`packages/client/src/types.ts`](../packages/client/src/types.ts) is its TypeScript mirror. If you change one, change the other in the same commit.

Contents: [Conventions](#1-conventions) · [Authentication](#2-authentication) · [CORS](#3-cors) · [Errors](#4-errors) · [Limits and rate limiting](#5-limits-and-rate-limiting) · [Text, offsets and chunking](#6-text-offsets-and-chunking) · [Audio and timestamps](#7-audio-and-timestamps) · [Endpoints](#8-endpoints) · [OpenAI compatibility](#9-openai-compatible-endpoints) · [Static web UI](#10-static-web-ui) · [Examples](#11-curl-examples)

---

## 1. Conventions

| Item | Rule |
|---|---|
| Base URL | `https://<your-host>`. All API routes live under `/v1`. Clients store the base URL **without** `/v1` (`TamberSettings.apiBaseUrl`) and append `/v1/...`. |
| Versioning | `/v1` is the contract major version. `GET /v1/health` returns `api_version: 1`. Additive changes (new optional fields, new event types, new endpoints) do not bump it. |
| Forward compatibility | Clients MUST ignore unknown JSON fields and unknown NDJSON event `type`s. Servers MUST ignore unknown request fields (log at debug). |
| Encoding | UTF-8 everywhere. JSON bodies use `Content-Type: application/json`. Field names are `snake_case`. |
| Numbers | Times are seconds as JSON numbers, rounded to 3 decimals (ms precision). Offsets are integers. |
| Request id | Every response carries `X-Request-ID`. The server echoes a client-sent `X-Request-ID` if it matches `^[A-Za-z0-9._-]{1,64}$`, else it generates a UUID4 hex string. Error bodies and the TTS `start` event include the same id. |
| Server version | Every response carries `X-Tamber-Version: <semver>`. |
| Compression | The server applies **no** response compression to `/v1/tts` and `/v1/audio/speech`, so streamed lines are never held in a compressor buffer (the Android Brotli issue). A reverse proxy in front MUST NOT buffer or compress `application/x-ndjson` either (see ARCHITECTURE.md §4). Static assets may be compressed. |
| Methods | `HEAD` is accepted wherever `GET` is. `OPTIONS` is answered by the CORS layer. |
| OpenAPI | `GET /openapi.json` and Swagger UI at `/docs` when `TAMBER_DOCS_ENABLED=true` (default). They are not behind auth. They describe the schema only; this document is normative. |

---

## 2. Authentication

- Auth is **off** when `TAMBER_API_KEY` is empty or unset. Every route is then open.
- Auth is **on** when `TAMBER_API_KEY` holds one or more comma-separated keys (whitespace around each key is ignored; empty entries are dropped). Every `/v1/*` route except `GET|HEAD /v1/health` then requires one of:
  - `Authorization: Bearer <key>` (primary; this is what OpenAI SDKs send), or
  - `X-API-Key: <key>` (for tools that cannot set `Authorization`).
- Keys are compared in constant time (`hmac.compare_digest`).
- On failure the server returns `401` with `WWW-Authenticate: Bearer realm="tamber"` and error code `unauthorized`. A missing header and a wrong key produce the same response.
- Never exempt: `POST /v1/tts`, `/v1/extract`, `/v1/audio/speech`, `GET /v1/voices`, `/v1/voices/{id}/preview`, `/v1/models`, `/v1/audio/voices`.
- Always exempt: `GET /v1/health`, CORS preflight `OPTIONS`, the static web UI (`/`, `/assets/*`, and so on), `/docs`, `/openapi.json`. The web UI is a public static bundle. It asks the user for the key and sends it on API calls.
- `GET /v1/health` reports `auth_required: true|false`, so clients can ask for a key before they make a failing call.
- Keys travel in headers only, never in query strings, and are never logged.

---

## 3. CORS

Configured with `TAMBER_CORS_ORIGINS`:

| Value | Behaviour |
|---|---|
| `*` (default) | `Access-Control-Allow-Origin: *`. Safe here: auth is a bearer header, not a cookie, and credentials are never allowed. |
| `https://a.example,chrome-extension://abcdef...` | Exact-match allow-list. The server reflects the matching `Origin` and adds `Vary: Origin`. |
| empty string | CORS middleware disabled (same-origin use only: the bundled web UI, mobile apps and extensions with host permission don't need CORS). |

Fixed settings: `allow_methods = GET, HEAD, POST, OPTIONS`; `allow_headers = Authorization, Content-Type, Accept, X-API-Key, X-Request-ID`; `expose_headers = X-Request-ID, X-Tamber-Version, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining`; `allow_credentials = false`; `max_age = 600`.

Clients: the bundled web UI is same-origin, so it needs no CORS. The Chrome extension gets host permission for the API origin at runtime, which bypasses CORS. React Native does not enforce CORS. CORS matters only for other web origins that call the API.

---

## 4. Errors

Every non-2xx response (all routes, including the OpenAI-compatible ones) has this body. It is a superset of OpenAI's error object, so OpenAI SDKs parse it:

```json
{
  "error": {
    "code": "unknown_voice",
    "message": "Unknown voice 'af_nope'. GET /v1/voices lists the available voices.",
    "type": "invalid_request_error",
    "param": "voice",
    "request_id": "6f1c0a2e9b8d4c7e8f00112233445566",
    "details": null
  }
}
```

| HTTP | `code` | `type` | When |
|---|---|---|---|
| 400 | `invalid_request` | invalid_request_error | Body is not valid JSON, schema or range violation, bad `start_chunk`. `details` holds the list of validation errors (`[{ "loc": ["body","speed"], "msg": "...", "type": "..." }]`). **FastAPI's default 422 is remapped to 400.** |
| 400 | `empty_text` | invalid_request_error | `text` has no speakable characters (the chunk plan is empty). |
| 400 | `unknown_voice` | invalid_request_error | A voice id in the spec does not exist, or the spec is malformed or has too many voices. `param: "voice"`. |
| 400 | `unsupported_language` | invalid_request_error | `lang` (or the voice's language) is unknown or not enabled on this server. |
| 400 | `unsupported_format` | invalid_request_error | `format` / `response_format` is not supported by that route. |
| 400 | `url_not_allowed` | invalid_request_error | Extract URL is not http(s), or it resolves to a private, loopback or link-local address while `TAMBER_EXTRACT_ALLOW_PRIVATE=false`. |
| 401 | `unauthorized` | authentication_error | Missing or wrong API key. |
| 404 | `not_found` | invalid_request_error | Unknown `/v1` route, or unknown voice in `/v1/voices/{id}/preview`. (Non-`/v1` paths fall through to the web UI.) |
| 405 | `method_not_allowed` | invalid_request_error | Wrong method on a known route. |
| 413 | `text_too_long` | invalid_request_error | `text` / `input` is longer than `TAMBER_MAX_TEXT_CHARS`. `details: {"max": 100000, "actual": 123456}`. |
| 413 | `file_too_large` | invalid_request_error | Upload over `TAMBER_MAX_UPLOAD_MB`, or remote document over `TAMBER_EXTRACT_MAX_DOWNLOAD_MB`. |
| 415 | `unsupported_media_type` | invalid_request_error | Extract got a file type it can't read, or a request `Content-Type` the route doesn't accept. |
| 422 | `extract_failed` | invalid_request_error | The document or page contained no extractable text (for example a scanned PDF or an empty page). |
| 429 | `rate_limited` | rate_limit_error | Per-client rate limit exceeded. `Retry-After` header set. |
| 500 | `internal_error` | server_error | Unexpected failure. The message is generic and the details are in the server log under `request_id`. |
| 500 | `synthesis_failed` | server_error | Non-streaming TTS or speech failed. |
| 502 | `fetch_failed` | server_error | Extract could not download the URL (DNS, TLS, timeout, remote 4xx/5xx). `details: {"status": 403}` when known. |
| 503 | `model_loading` | server_error | Model still warming up after start. `Retry-After: 5`. |
| 503 | `server_busy` | server_error | Synthesis queue is full (`TAMBER_MAX_QUEUE`). `Retry-After` set. |

Inside a TTS **stream** (after `200` was sent), errors are NDJSON lines instead (see §8.4.4).

---

## 5. Limits and rate limiting

| Env var | Default | Applies to |
|---|---|---|
| `TAMBER_MAX_TEXT_CHARS` | `100000` | `text` (`/v1/tts`) and `input` (`/v1/audio/speech`), measured in UTF-16 code units → 413 `text_too_long` |
| `TAMBER_MAX_UPLOAD_MB` | `25` | Multipart upload body and `html` field size on `/v1/extract` → 413 `file_too_large` |
| `TAMBER_EXTRACT_MAX_DOWNLOAD_MB` | `10` | Bytes downloaded when extracting from a URL → 413 `file_too_large` |
| `TAMBER_MAX_EXTRACT_CHARS` | `500000` | Extracted text longer than this is truncated at the last paragraph or sentence boundary, with `truncated: true` |
| `TAMBER_EXTRACT_TIMEOUT_S` | `15` | Total time for fetching an extract URL (connect + read), up to 5 redirects |
| `TAMBER_CHUNK_TARGET_CHARS` | `280` | Chunk packing target (§6.3). Reported in health. |
| `TAMBER_CHUNK_MAX_CHARS` | `400` | Hard maximum chunk length (§6.3), min 50. Reported in health. |
| `TAMBER_MAX_BLEND_VOICES` | `4` | Voices per blend spec |
| `TAMBER_RATE_LIMIT_PER_MINUTE` | `60` | Requests per rolling minute per client on `POST /v1/tts`, `POST /v1/audio/speech`, `POST /v1/extract` and uncached voice previews. `0` disables. |
| `TAMBER_MAX_CONCURRENT_SYNTH` | `1` | Concurrent synthesis jobs (the model is shared; CPU inference is effectively serial) |
| `TAMBER_MAX_QUEUE` | `16` | Jobs waiting for a slot. Beyond that: 503 `server_busy`. |

**Rate-limit key.** It is the presented API key when auth is on, otherwise the client IP. The client IP comes from `X-Forwarded-For` only when the direct peer matches `TAMBER_FORWARDED_ALLOW_IPS`. Rate-limited responses carry `Retry-After: <seconds>`. Every rate-limited route also returns `X-RateLimit-Limit` and `X-RateLimit-Remaining`. The implementation is an in-process sliding window, with no external store.

**Speed.** `0.25 <= speed <= 4.0` (API). Client UIs offer `0.5-2.0` in steps of `0.05`.

---

## 6. Text, offsets and chunking

### 6.1 Offsets: exact definition

- The server **never rewrites the submitted text for offset purposes.** Every `char_start` / `char_end` indexes into the exact `text` string the client sent, so `text.slice(char_start, char_end)` in JS is the referenced span.
- Units are **UTF-16 code units**, which are JavaScript string indices. An emoji outside the BMP counts as 2. The Python server works in code points internally and converts through a prefix-sum table (`utf16_offset[i]` = UTF-16 length of `text[:i]`). A span never starts or ends inside a surrogate pair.
- Spans are half-open `[start, end)`. `0 <= start < end <= text_length`.
- **Whitespace normalization is positional only; it is length-preserving.** For chunking and synthesis the server treats these code units as whitespace: `U+0009-U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF`. "Line breaks" are `\n`, `\r`, `U+000B`, `U+000C`, `U+0085`, `U+2028` (each counts 1, and `\r\n` counts 1) and `U+2029` (counts 2). Nothing is removed, inserted or reordered, so the normalized text equals the original index for index. The spoken form sent to the model (whitespace runs collapsed to one space) is internal. The server keeps a map from spoken-string index to original index, so offsets always refer to the original.
- Every chunk and every word span is **trimmed**: it neither starts nor ends with whitespace.
- The client MUST render exactly the string it sent (don't trim or reflow it before sending unless you render the trimmed version). `/v1/extract` returns text that is already clean.

### 6.2 Language and voices

Text is spoken in the request's `lang`, or in the language of the first voice of the blend when `lang` is absent (§8.2).

### 6.3 Chunking algorithm (deterministic)

The server splits `text` into a **chunk plan** before it synthesizes anything, and sends the whole plan in the `start` event. Every chunk becomes exactly one NDJSON `chunk` line with one self-contained audio file. The algorithm uses characters, not model tokens, so every client can predict it. The reference implementation is `planChunks()` in [`packages/client/src/chunking.ts`](../packages/client/src/chunking.ts). The conformance suite is [`packages/client/fixtures/chunking.json`](../packages/client/fixtures/chunking.json), and the Python implementation MUST reproduce every case byte for byte. Parameters: `mode` (`chunk_mode`), `T` = `TAMBER_CHUNK_TARGET_CHARS` (default 280), `M` = `TAMBER_CHUNK_MAX_CHARS` (default 400, minimum 50). `T` is clamped to `[1, M]`.

1. **Paragraphs.** Scan whitespace runs. A run containing **2 or more line breaks** is a paragraph boundary. Paragraphs are the spans between boundaries, trimmed. Empty spans are dropped. A single line break is ordinary whitespace, so hard-wrapped text flows.
2. **Sentences** (per paragraph). Find each maximal run of terminators `. ! ? … ‼ ⁇ ⁈ ⁉ 。 ！ ？ ｡`, then extend it over any closers `" ' ” ’ ) ] } » › 」 』 ） 】`. Let `end` be the index after the closers. A sentence boundary is placed at `end` when `end` is inside the paragraph and either the character at `end` is whitespace or the run contains a CJK terminator (`。！？｡`). The boundary is **suppressed** when either of these holds:
   - (a) the run is exactly one `.` and the word before it (the maximal non-whitespace run before the `.`, with leading openers `" ' “ ‘ ( [ { « ‹ 「 『 （ 【` stripped) is a single ASCII letter (an initial such as "J.") or case-insensitively one of: `mr mrs ms mx dr prof sr jr st mt ft vs etc al cf approx dept est fig figs inc ltd co corp no nos vol vols pp ed eds rev gen gov sen rep lt col capt sgt cpl jan feb mar apr jun jul aug sep sept oct nov dec mon tue tues wed thu thur thurs fri sat sun e.g i.e a.m p.m u.s u.k e.u ph.d m.d b.a m.a ave blvd rd hwy`;
   - (b) the next non-whitespace character after `end` is a lowercase letter (Unicode category `Ll`).

   Sentences are the trimmed spans between boundaries.
3. **Over-long sentences.** While a sentence span `[a, b)` is longer than `M`, cut it at position `c`, the first rule that matches within the window `(a, a+M]`:
   - the **largest** `c` where `text[c-1]` is one of `, ; : — –` and `text[c]` is whitespace, or `text[c-1]` is one of `， ； ： 、`; otherwise
   - the largest `c` where `text[c]` is whitespace; otherwise
   - `c = a+M`, stepping back by 1 if that would split a surrogate pair.

   The piece is `[a, c)` trimmed. Continue from `c` after skipping whitespace.
4. **Drop unspeakable pieces**, meaning pieces with no letter or digit (Unicode `L*` / `N*`), such as `***` or `---`.
5. **Pack.**
   - `chunk_mode: "sentence"`: one piece per chunk.
   - `chunk_mode: "balanced"` (default): the **first piece of the whole text is always a chunk on its own**, so the first audio arrives fast. After that, within one paragraph, consecutive pieces are merged while `(last_piece.end - chunk.start) <= T`. Chunks never cross paragraph boundaries.
6. Chunks are numbered `0..n-1` in text order. If `n == 0` the request fails with 400 `empty_text`.

Chunks are therefore at most `M` UTF-16 units long, and in balanced mode usually `T` or less. If a chunk's phonemes exceed Kokoro's 510-token context, the server lets `KPipeline` split it internally and **concatenates** the resulting segments into one audio file. The chunk stays one NDJSON line, and word times are offset so they are continuous.

---

## 7. Audio and timestamps

### 7.1 Chunk audio

- Every `chunk` line carries **one complete, independently decodable audio file** in `audio`: standard base64 with padding. The server builds a fresh encoder or container for every chunk and finalizes it before emitting the line. This is what `decodeAudioData()` on iOS Safari requires. Clients must never assume that bytes from different chunks form one stream.
- Sample rate is 24000 Hz, mono.
- **`wav` (default, recommended):** RIFF/WAVE, PCM s16le, mono, 24000 Hz, canonical 44-byte header (`fmt ` chunk of 16 bytes, then one `data` chunk) with correct RIFF and data sizes (never `0xFFFFFFFF`). `duration = samples / 24000` exactly. WAV chunks join sample-exactly, and `concatWav()` in the client package can stitch them into one file.
- **`mp3`:** one complete MPEG Layer III file per chunk (CBR 128 kbps, 24000 Hz mono, no ID3; at 24 kHz this is technically MPEG-2 Layer III, frame sync `0xFFF3`, which every browser decoder accepts). `duration` is nominal. Encoder priming and padding add a few ms per chunk, so joins may have audible micro-gaps. Use MP3 only when bandwidth matters more than seamlessness. Clients MUST use the decoded buffer duration for scheduling.
- **Silence trimming:** before encoding, the server trims each chunk's leading silence to at most 30 ms. It sets trailing silence to a pause that depends on how the chunk ends: 600 ms at a paragraph end; 350 ms after a sentence terminator; 180 ms after `, ; : — –`; 100 ms otherwise. At speed `s` these are divided by `s`. "Silence" means |sample| < 1e-3 (about -60 dBFS). Chunks played back to back with no added gap therefore sound natural. Word times are shifted by the amount of leading silence removed.

### 7.2 Word timestamps

- `words[]` holds the spoken words of the chunk, in order. Each word has:
  - `text`: exactly `text.slice(char_start, char_end)` of the submitted text;
  - `start`, `end`: seconds **relative to the start of this chunk's audio** (chunk-relative, not absolute). They satisfy `0 <= start <= end <= duration`, and words do not overlap (`words[i].end <= words[i+1].start`, clamped by the server if needed).
- **Why chunk-relative:** each chunk is decoded and scheduled independently, it can be skipped (non-fatal error), and it can be requested out of order through `start_chunk`. The absolute position is `sum(durations of chunks placed before it) + word.start`. `TimelineBuilder` and `buildTimeline()` in `@tamber/client` compute this, using the decoded duration when you have it.
- **Source:** for English (`a`, `b`) timings come from Kokoro's own `KPipeline` result tokens (`MToken.start_ts` / `end_ts`, derived from the model's predicted durations), not from a separate aligner. Tokens without timings, and punctuation-only tokens, are skipped. Each remaining token is located in the chunk's original text by a forward scan that treats curly and straight quotes and apostrophes as equal. Tokens that can't be located are omitted, never guessed. If the pipeline split a chunk into several segments, later segments' times are offset by the preceding audio length.
- **Languages without word timings** (every non-English language in v1, and always `j` and `z`): `words` is `[]`, the `start` event says `word_timestamps: false`, and voices report `word_timestamps: false`. Clients then highlight the whole chunk (sentence-level) and hide or disable the word-highlight toggle. A server MAY later add espeak-duration-based timings for `e f h i p` and flip the flag. Clients must key off the flag and never off the language.

---

## 8. Endpoints

### 8.1 `GET /v1/health`

No auth. Cheap, never touches the model. Use it for "test connection", capability discovery and the Docker healthcheck.

```json
{
  "status": "ok",
  "version": "0.1.0",
  "api_version": 1,
  "engine": "kokoro",
  "model": "hexgrad/Kokoro-82M",
  "device": "cpu",
  "model_loaded": true,
  "auth_required": true,
  "sample_rate": 24000,
  "formats": ["wav", "mp3"],
  "default_voice": "af_heart",
  "default_format": "wav",
  "languages": [
    { "code": "a", "tag": "en-US", "name": "American English", "word_timestamps": true },
    { "code": "b", "tag": "en-GB", "name": "British English", "word_timestamps": true }
  ],
  "limits": {
    "max_text_chars": 100000,
    "max_upload_bytes": 26214400,
    "max_extract_chars": 500000,
    "chunk_target_chars": 280,
    "chunk_max_chars": 400,
    "rate_limit_per_minute": 60,
    "speed_min": 0.25,
    "speed_max": 4.0,
    "max_blend_voices": 4
  },
  "features": {
    "extract_url": true,
    "extract_file": true,
    "extract_html": true,
    "openai_compat": true,
    "voice_blending": true,
    "voice_preview": true
  }
}
```

`status` is `"loading"` while the model loads or warms up. It is still HTTP 200, and TTS routes return 503 `model_loading` in the meantime. It is `"degraded"` if warm-up failed but the process is alive. `engine: "fake"` marks the model-free development engine (§8.4.7).

### 8.2 `GET /v1/voices`

Auth required. Lists the voices of **enabled** languages only (`TAMBER_LANGUAGES`), sorted by language, then grade (best first), then name.

```json
{
  "default_voice": "af_heart",
  "languages": [
    { "code": "a", "tag": "en-US", "name": "American English", "word_timestamps": true },
    { "code": "b", "tag": "en-GB", "name": "British English", "word_timestamps": true }
  ],
  "voices": [
    {
      "id": "af_heart",
      "name": "Heart",
      "language": "en-US",
      "language_name": "American English",
      "lang_code": "a",
      "gender": "female",
      "grade": "A",
      "word_timestamps": true,
      "preview_text": "Hi, I'm Heart. Tamber can read anything to you, one word at a time.",
      "tags": ["default", "recommended"]
    },
    {
      "id": "bm_george",
      "name": "George",
      "language": "en-GB",
      "language_name": "British English",
      "lang_code": "b",
      "gender": "male",
      "grade": "C",
      "word_timestamps": true,
      "preview_text": "Hi, I'm George. Tamber can read anything to you, one word at a time.",
      "tags": []
    }
  ]
}
```

- `id` convention: first letter is the language code, second letter is `f`/`m`, then `_name`.
- `name` is the id after the underscore, title-cased (`af_heart` → `Heart`).
- `grade` comes from Kokoro's VOICES.md (overall grade) or is `null`. `tags` includes `"default"` for the default voice and `"recommended"` for grade `B-` or better.
- `preview_text` is a short sentence in the voice's language.

**Voices and blends.** Wherever a voice is accepted (`voice` in `/v1/tts`, `/v1/audio/speech`), a **blend spec** is also accepted:

```
spec      := component ( "+" component )*        at most TAMBER_MAX_BLEND_VOICES (4)
component := voice_id [ "(" weight ")" ]
voice_id  := [a-z]{2}_[a-z0-9]+(_[a-z0-9]+)*      must be an available voice
weight    := decimal, 0 < weight <= 100            default 1
```

Whitespace around tokens is ignored. A repeated id has its weights summed. The server loads each voice's style tensor and computes the weighted mean, with weights normalized to sum to 1: `af_bella(2)+af_sky(1)` gives 2/3 Bella and 1/3 Sky. The blend's language is its **first** component's, unless `lang` is given. The canonical spec (ids joined by `+`; weights omitted when all equal, otherwise `(w)` rounded to 3 decimals) is echoed as `voice` in the `start` event. Blended tensors are cached (LRU, 32 entries). Subtraction (`-`) is not supported. `parseVoiceSpec()` in the client package implements the same grammar.

### 8.3 `GET /v1/voices/{voice_id}/preview?format=wav|mp3`

Auth required. Rate-limited only when not cached. Returns the voice's `preview_text` spoken by that voice as one complete audio file (`Content-Type: audio/wav` or `audio/mpeg`). `voice_id` must be a single voice (not a blend). The result is cached in memory (LRU) and sent with `Cache-Control: private, max-age=86400` and an `ETag`. 404 `not_found` for an unknown voice.

### 8.4 `POST /v1/tts`: synthesis with word timings

Auth required. Rate-limited.

#### 8.4.1 Request

`Content-Type: application/json`

```json
{
  "text": "Hello world. This is Tamber.",
  "voice": "af_bella(2)+af_sky(1)",
  "speed": 1.0,
  "format": "wav",
  "lang": null,
  "stream": true,
  "chunk_mode": "balanced",
  "start_chunk": 0
}
```

| Field | Type | Default | Rules |
|---|---|---|---|
| `text` | string | required | 1 to `max_text_chars` UTF-16 units. Must produce at least 1 chunk (else 400 `empty_text`). |
| `voice` | string | `TAMBER_DEFAULT_VOICE` | Voice id or blend spec (§8.2). |
| `speed` | number | `1.0` | `0.25-4.0`. |
| `format` | `"wav"` \| `"mp3"` | `TAMBER_DEFAULT_FORMAT` (`wav`) | Per-chunk audio encoding. |
| `lang` | string \| null | from voice | Letter code or alias: `a`/`en-us`/`en`, `b`/`en-gb`, `e`/`es`, `f`/`fr-fr`/`fr`, `h`/`hi`, `i`/`it`, `p`/`pt-br`/`pt`, `j`/`ja`, `z`/`zh` (case-insensitive). It must be an enabled language. |
| `stream` | boolean | `true` | `true` → NDJSON stream (§8.4.2). `false` → one JSON body (§8.4.5). |
| `chunk_mode` | `"balanced"` \| `"sentence"` | `"balanced"` | §6.3. |
| `start_chunk` | integer | `0` | `0 <= start_chunk < total_chunks`. Chunks before it are neither synthesized nor sent. Indices and offsets stay relative to the full text. Used for seeking or resuming far ahead without re-synthesizing earlier audio. |

All validation (auth, rate limit, schema, voice, language, length, plan) happens **before** any response bytes are sent, so a bad request always gets a normal HTTP error (§4), never a stream.

#### 8.4.2 Streaming response

```
HTTP/1.1 200 OK
Content-Type: application/x-ndjson; charset=utf-8
Cache-Control: no-store
X-Accel-Buffering: no
X-Request-ID: 6f1c0a2e9b8d4c7e8f00112233445566
Transfer-Encoding: chunked
```

The body is a sequence of UTF-8 JSON objects, **one per line**, each terminated by `\n`. No line contains a raw newline, and each line is written and flushed as soon as it is ready. Grammar:

```
stream := start ( queued | chunk | error(fatal=false) | ping )* ( done | error(fatal=true) )
```

- `start` is always the first line and is sent right after validation, before waiting for a synthesis slot.
- `chunk` lines arrive in increasing `index` order, from `start_chunk` to `total_chunks-1`, except for indices skipped by a non-fatal `error`.
- The stream ends with exactly one `done` (success, possibly with some chunks failed) or one fatal `error`, and then the connection closes.
- A response that ends without either (for example a proxy cut the connection) must be treated by clients as a failure. `TamberClient.synthesize` throws `TamberProtocolError`.

#### 8.4.3 Event reference

**`start`**

```json
{"type":"start","request_id":"6f1c0a2e9b8d4c7e8f00112233445566","sample_rate":24000,"format":"wav","voice":"af_bella(2)+af_sky(1)","lang":"a","speed":1.0,"chunk_mode":"balanced","total_chunks":2,"start_chunk":0,"word_timestamps":true,"text_length":28,"chunks":[{"index":0,"char_start":0,"char_end":12},{"index":1,"char_start":13,"char_end":28}]}
```

`chunks` is the **full** plan (all indices, even those before `start_chunk`), so clients can lay out the text, show real progress (`received / (total_chunks - start_chunk)`) and map a tap to a chunk index for seeking.

**`queued`** (optional, 0 or more): sent only while the job waits for a synthesis slot, at most every 2 s. `position` is 1 when the job is next in line.

```json
{"type":"queued","position":2}
```

**`chunk`**

```json
{"type":"chunk","index":0,"text":"Hello world.","char_start":0,"char_end":12,"audio":"UklGRiQ4AQBXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQA4AQA...","format":"wav","sample_rate":24000,"duration":1.184,"words":[{"text":"Hello","start":0.03,"end":0.412,"char_start":0,"char_end":5},{"text":"world","start":0.412,"end":0.861,"char_start":6,"char_end":11}]}
```

| Field | Meaning |
|---|---|
| `index` | Plan index. |
| `text` | `text.slice(char_start, char_end)` of the submitted text. |
| `char_start`, `char_end` | Span of this chunk (§6.1). |
| `audio` | base64 of one complete audio file (§7.1). |
| `format`, `sample_rate` | Echo of the encoding. |
| `duration` | Seconds of audio in this file. |
| `words` | Chunk-relative word timings (§7.2). `[]` when there are none. |
| `words_estimated` | Optional, only present as `true`: the language normally has word timings but the pipeline returned no tokens for this chunk, so the server spread the chunk's words proportionally over its audio. Clients may treat these like real timings (they are still ordered, non-overlapping and in-range) or show a softer highlight. Absent means the timings are the model's own. |

**`done`**

```json
{"type":"done","total_duration":2.771,"chunks_sent":2,"chunks_failed":0,"elapsed_ms":1893}
```

`total_duration` is the sum of `duration` over the chunks sent in this response.

**`error`**

```json
{"type":"error","code":"synthesis_failed","message":"Chunk 7 could not be synthesized.","index":7,"fatal":false}
{"type":"error","code":"internal_error","message":"The TTS engine crashed.","index":null,"fatal":true}
```

- `fatal: false`: that chunk was skipped and the stream continues. Clients should show a subtle notice and play on. Chunk-level failures are non-fatal by default.
- `fatal: true`: the last line of the stream, with no `done`. Examples: engine crash, or 3 consecutive chunk failures (then the server gives up).
- `code` is one of the codes in §4 (usually `synthesis_failed` or `internal_error`).

**`ping`**: `{"type":"ping"}`, sent after 15 s without any other line, so proxies with idle timeouts don't cut a stream that is queued or synthesizing a slow chunk on CPU. Ignore it.

#### 8.4.4 Cancellation, concurrency, order

- Closing the connection (for example `AbortController.abort()`) cancels the job. The server checks for disconnects before each chunk and while queued, stops synthesis, and frees the slot. Cancelling costs at most one chunk of wasted synthesis.
- At most `TAMBER_MAX_CONCURRENT_SYNTH` jobs synthesize at once; the rest wait in a FIFO queue (up to `TAMBER_MAX_QUEUE`, else 503 `server_busy` before the stream starts). A job holds its slot from its first chunk to its last. With the default of 1 this gives predictable latency for a single user.
- Each chunk is synthesized in a worker thread, so the event loop never blocks and pings and disconnect checks keep working.

#### 8.4.5 Non-streaming response (`"stream": false`)

`200 application/json`. Same data as the stream, gathered into one object:

```json
{
  "request_id": "6f1c0a2e9b8d4c7e8f00112233445566",
  "sample_rate": 24000,
  "format": "wav",
  "voice": "af_heart",
  "lang": "a",
  "speed": 1.0,
  "chunk_mode": "balanced",
  "total_chunks": 2,
  "start_chunk": 0,
  "word_timestamps": true,
  "text_length": 28,
  "plan": [{"index":0,"char_start":0,"char_end":12},{"index":1,"char_start":13,"char_end":28}],
  "chunks": [
    {"type":"chunk","index":0,"text":"Hello world.","char_start":0,"char_end":12,"audio":"UklGR...","format":"wav","sample_rate":24000,"duration":1.184,"words":[...]},
    {"type":"chunk","index":1,"text":"This is Tamber.","char_start":13,"char_end":28,"audio":"UklGR...","format":"wav","sample_rate":24000,"duration":1.587,"words":[...]}
  ],
  "errors": [],
  "total_duration": 2.771,
  "elapsed_ms": 1893
}
```

`errors` lists non-fatal chunk errors (same shape as stream `error` events). A fatal failure returns HTTP 500 `synthesis_failed` instead. Clients should prefer streaming for anything longer than a sentence.

#### 8.4.6 Errors before streaming

400 (`invalid_request`, `empty_text`, `unknown_voice`, `unsupported_language`, `unsupported_format`), 401, 413 `text_too_long`, 429, 503 `model_loading` / `server_busy`. See §4.

#### 8.4.7 Fake engine (development)

With `TAMBER_ENGINE=fake`, the server loads no model and needs neither torch nor kokoro. Each chunk is a soft tone of about 0.33 s per word, plus the normal trailing pause (§7.1), with evenly spaced word timings covering every whitespace-separated word of the chunk. Everything else (auth, chunk plan, offsets, WAV/MP3 encoding, errors, pings, cancellation) behaves exactly like production. Client builders develop and test against this engine. `health.engine` is `"fake"` and all enabled languages report `word_timestamps: true`.

### 8.5 `POST /v1/extract`: get readable text from a URL, HTML or document

Auth required. Rate-limited. Three input forms:

**a) URL**: `Content-Type: application/json`

```json
{ "url": "https://example.com/articles/why-voices-matter" }
```

The server downloads the URL: http(s) only; at most 5 redirects; `TAMBER_EXTRACT_TIMEOUT_S`; `TAMBER_EXTRACT_MAX_DOWNLOAD_MB`; User-Agent `Tamber/<version> (+self-hosted text-to-speech)`. Every hop's resolved IP is checked, and private, loopback, link-local, multicast and reserved ranges are refused (400 `url_not_allowed`) unless `TAMBER_EXTRACT_ALLOW_PRIVATE=true`. HTML goes through trafilatura (main content, `with_metadata=True`). If the response is a PDF, DOCX, EPUB, Markdown or plain-text document (by `Content-Type`, then by extension and magic bytes), it goes through the file extractors in (c).

**b) HTML the client already has**: `Content-Type: application/json`

```json
{ "html": "<!doctype html><html>...</html>", "url": "https://example.com/page" }
```

This is used by the extension ("read this page", including pages behind a login) and by the mobile share sheet. The same trafilatura path runs with no network fetch. `url` is optional and is used for metadata and `source`. The `html` size limit is `TAMBER_MAX_UPLOAD_MB`.

**c) File upload**: `Content-Type: multipart/form-data`

| Part | Required | Notes |
|---|---|---|
| `file` | yes | The document. |
| `filename` | no | Overrides the part's filename (React Native sometimes loses it). |

| Type | Detected by | Extractor |
|---|---|---|
| PDF | `.pdf`, `application/pdf`, magic `%PDF-` | pypdf (BSD). pymupdf (AGPL) is not used. |
| DOCX | `.docx`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, zip containing `word/document.xml` | python-docx (paragraphs, headings; table cells as paragraphs) |
| EPUB | `.epub`, `application/epub+zip`, zip with `mimetype` = `application/epub+zip` | ebooklib + BeautifulSoup, spine order |
| HTML | `.html`, `.htm`, `text/html` | trafilatura, with a BeautifulSoup text fallback |
| Markdown | `.md`, `.markdown`, `text/markdown` | markdown-it-py rendered to HTML, then block text; code blocks are dropped and link text is kept |
| Text | `.txt`, `text/plain` | UTF-8 first, then charset-normalizer detection |

Anything else gets 415 `unsupported_media_type`.

**Response** (`200 application/json`), the same for all three forms:

```json
{
  "title": "Why Voices Matter",
  "text": "Why Voices Matter\n\nThe first paragraph of the article, with single spaces.\n\nThe second paragraph.",
  "source": "https://example.com/articles/why-voices-matter",
  "source_type": "url",
  "mime_type": "text/html",
  "word_count": 17,
  "char_count": 96,
  "truncated": false,
  "language": "en"
}
```

Output rules, which clients can rely on:

- `text` is plain text with no markup. Paragraphs, headings and list items are separate paragraphs joined by exactly `"\n\n"`. Inside a paragraph, whitespace runs are collapsed to one space. There is no leading or trailing whitespace, no soft hyphens (`U+00AD`) and no zero-width characters. This makes it directly suitable for `/v1/tts`, and its paragraphs map one to one onto chunk-plan paragraphs.
- `title`: the document or page title (metadata), else the first heading, else the file name without extension, else `null`. The title is **not** automatically prepended to `text`; clients may prepend `title + "\n\n"` before synthesis if they want it read aloud (web and mobile do by default).
- `source`: the URL (`url` / `html` with url), `""` (html without url), or the file name (`file`).
- `word_count` is the number of whitespace-separated tokens. `char_count` is `text.length` in UTF-16 units.
- `truncated: true` when the text was cut at `TAMBER_MAX_EXTRACT_CHARS`, at the last `"\n\n"` (else the last sentence end, else the last whitespace) before the limit.
- `language`: `html lang` or document metadata, else `null`. It is informational; the server does not auto-select voices.

Errors: 400 `invalid_request` (neither or both of `url`/`html`, or bad JSON), 400 `url_not_allowed`, 413 `file_too_large`, 415 `unsupported_media_type`, 422 `extract_failed` (no text), 502 `fetch_failed`.

---

## 9. OpenAI-compatible endpoints

These let existing tools (Open WebUI, OpenAI SDKs, Home Assistant integrations, anything pointed at Kokoro-FastAPI) use Tamber as a drop-in. The default port **8880** matches Kokoro-FastAPI.

### 9.1 `POST /v1/audio/speech`

Auth required. Rate-limited.

```json
{ "model": "tts-1", "input": "Hello from Tamber.", "voice": "af_heart", "response_format": "mp3", "speed": 1.0 }
```

| Field | Rules |
|---|---|
| `model` | Any string is accepted (`kokoro`, `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`...). All use the one Kokoro model. |
| `input` | Required, 1 to `max_text_chars` UTF-16 units. |
| `voice` | Kokoro id or blend spec, **or** an OpenAI voice name mapped as: `alloy→af_alloy`, `ash→am_adam`, `ballad→bm_fable`, `coral→af_heart`, `echo→am_echo`, `fable→bm_fable`, `nova→af_nova`, `onyx→am_onyx`, `sage→af_sarah`, `shimmer→af_bella`, `verse→am_michael`. A mapped voice missing from the enabled languages falls back to the default voice. |
| `response_format` | `mp3` (default), `opus` (Ogg/Opus), `aac` (ADTS), `flac`, `wav`, `pcm` (raw s16le, 24000 Hz, mono, no header). |
| `speed` | `0.25-4.0`, default 1.0. |
| `instructions`, `stream_format`, any other field | Accepted and ignored. |

Response: `200` with the audio bytes and `Content-Type` of `audio/mpeg`, `audio/ogg`, `audio/aac`, `audio/flac`, `audio/wav` or `audio/pcm`. Also `Content-Disposition: inline; filename="speech.<ext>"`. The text is chunked in `balanced` mode and synthesized chunk by chunk. For `mp3`, `opus`, `aac` and `pcm`, bytes stream progressively from **one continuous encoder** (chunked transfer; a normal single audio file, not per-chunk files). `wav` and `flac` are sent complete with `Content-Length`. No word timings: use `/v1/tts` for those. Errors use §4, which is OpenAI-shaped.

### 9.2 `GET /v1/models`, `GET /v1/models/{id}`

Auth required.

```json
{
  "object": "list",
  "data": [
    { "id": "kokoro", "object": "model", "created": 1735689600, "owned_by": "tamber" },
    { "id": "tts-1", "object": "model", "created": 1735689600, "owned_by": "tamber" },
    { "id": "tts-1-hd", "object": "model", "created": 1735689600, "owned_by": "tamber" },
    { "id": "gpt-4o-mini-tts", "object": "model", "created": 1735689600, "owned_by": "tamber" }
  ]
}
```

`/v1/models/{id}` returns one entry or 404 `not_found`.

### 9.3 `GET /v1/audio/voices`

Auth required. Kokoro-FastAPI-compatible voice list, for tools that probe it:

```json
{ "voices": [{ "id": "af_heart", "name": "af_heart" }, { "id": "af_bella", "name": "af_bella" }], "default_voice": "af_heart" }
```

---

## 10. Static web UI

When `TAMBER_WEB_DIR` points at a built `web/dist` (in the image: `/app/web`), the server also serves the web UI from `/`:

- Registered **after** all API routes. Unknown `/v1/*` paths are a JSON 404, never the SPA.
- An existing file under the dir is served as is. Any other `GET`/`HEAD` whose `Accept` includes `text/html` gets `index.html` (SPA fallback). Otherwise 404.
- Caching: files under `/assets/` (Vite's hashed output) get `Cache-Control: public, max-age=31536000, immutable`. `index.html`, `sw.js`, `registerSW.js`, `workbox-*.js` and `manifest.webmanifest` get `Cache-Control: no-cache`. Other files get `public, max-age=3600`.
- `manifest.webmanifest` is served as `application/manifest+json`.
- No auth on static files. The UI talks to `/v1/*` with the user's key.
- When `TAMBER_WEB_DIR` is empty or missing, `/` returns a small JSON banner `{"name":"Tamber","api":"/v1","docs":"/docs"}`.

---

## 11. curl examples

```sh
BASE=https://tts.example.com
KEY=change-me

curl -s $BASE/v1/health | jq .

curl -s -H "Authorization: Bearer $KEY" $BASE/v1/voices | jq '.voices[].id'

# Stream NDJSON (each line printed as it arrives; audio truncated for readability)
curl -sN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"Hello world. This is Tamber.","voice":"af_heart"}' \
  $BASE/v1/tts | jq -c '.audio |= (if . then .[0:16]+"..." else . end)'

# Resume at chunk 5
curl -sN -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"text\":$(jq -Rs . < article.txt),\"start_chunk\":5}" $BASE/v1/tts > out.ndjson

# Extract
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/post"}' $BASE/v1/extract | jq '{title, word_count}'
curl -s -H "Authorization: Bearer $KEY" -F file=@paper.pdf $BASE/v1/extract | jq .title

# OpenAI-compatible
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"tts-1","input":"Drop-in replacement.","voice":"alloy"}' \
  $BASE/v1/audio/speech -o speech.mp3
```
