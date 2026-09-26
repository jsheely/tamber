# Kokoro-FastAPI — deep-dive research for Tamber

Source: [github.com/remsky/Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), cloned fresh (shallow, `master`) on 2026-09-26. All line numbers/paths below refer to that checkout. Default branch is `master` (active dev); `release` is what images actually build from; `:latest` images build from `release`, not `master`.

Versions confirmed live in the repo today: `VERSION` = `0.9.1-rc1`. Pinned deps of note in `pyproject.toml`: `kokoro==0.9.4`, `misaki[en,ja,ko,zh]==0.9.4`, `fastapi>=0.128.8`, `uvicorn==0.34.0`, `pydantic==2.10.4`, `torch==2.8.0` (+cu126/cu128/cu129/rocm6.4 variants), `av>=14.2.0`, `espeakng-loader==0.2.4`, `pyopenjtalk-plus` (Windows only), `spacy==3.8.5`. I checked PyPI directly: **`kokoro` 0.9.4 and `misaki` 0.9.4 are each still the latest published release** (last shipped ~April 2025) — the pins are current, not stale.

---

## 1. Architecture at a glance

One FastAPI app (`api/src/main.py`) that:
- mounts an OpenAI-compatible router at `/v1`, a set of `/dev/*` "extended" endpoints, `/dev/ssml`, `/dev/tune`, `/debug/*`, and (if enabled) serves the static `web/` folder at `/web` — **exactly** the "one container, API + static UI" shape Tamber wants.
- loads Kokoro-82M once at startup (lifespan hook), warms it up, and keeps a small set of long-lived managers: `ModelManager` (device/model lifecycle, optional idle auto-unload), `VoiceManager` (voice file listing/loading + a "transient" registry for tuned/combined voices that aren't on disk), `TTSService` (orchestrates chunking → per-chunk generation → encoding → streaming).
- has **no authentication of any kind**. I grepped the whole `api/src` tree for `authorization`/`api_key`/`bearer` — zero hits. Only `cors_origins`/`cors_enabled` exist. Tamber's bearer-token requirement is something to add from scratch, not adapt.

---

## 2. HTTP endpoints (exact shapes)

All routers are plain FastAPI/Pydantic; request/response models live in `api/src/structures/schemas.py` and `text_schemas.py`.

### 2.1 OpenAI-compatible (`/v1`, `api/src/routers/openai_compatible.py`)

**`POST /v1/audio/speech`** — the core TTS endpoint, modeled on OpenAI's `/audio/speech`.

Request (`OpenAISpeechRequest`):
```jsonc
{
  "model": "kokoro",                 // tts-1 / tts-1-hd / kokoro all map the same
  "input": "text, up to max_input_length (1,000,000 chars)",
  "voice": "af_heart",                // base voice, "a+b", or "a(2)+b(1)" weighted mix
  "response_format": "mp3",           // mp3 | opus | aac | flac | wav | pcm
  "download_format": null,            // optional different format for the final file
  "speed": 1.0,                       // 0.25–4.0
  "stream": true,                     // default true
  "return_download_link": false,      // temp-file download link via header
  "return_timing": false,             // needs return_download_link too; sentence-chunk timing sidecar
  "lang_code": null,                  // else derived from voice[0]
  "volume_multiplier": 1.0,           // 0–10
  "normalization_options": { "normalize": true, "unit_normalization": false, "url_normalization": true,
                              "email_normalization": true, "optional_pluralization_normalization": true,
                              "phone_normalization": true, "caps_normalization": true,
                              "replace_remaining_symbols": true, "remove_emoji": false },
  "allow_voice_tags": false,          // gates [voice:...]/[rate:...] inline tags
  "ssml": false,                      // requires allow_voice_tags:true
  "voice_aliases": null               // {"name": "af_bella(2)+af_sky"} or {"name": {"voice": "...", "rate": 0.8}}
}
```
Response: raw audio bytes, `Content-Type` per format, `Content-Disposition: attachment`. If `stream:true` (default), it's a chunked `StreamingResponse` — **but see §5, the bytes are one continuous encoded stream, not independent chunks**. If `return_download_link:true`, headers carry `X-Download-Path` (and `X-Timing-Path` if `return_timing`); the file is written server-side as the stream plays out and must be fetched with `GET /v1/download/{filename}` *after* the stream ends (404 before that).

**`GET /v1/download/{filename}?name=...`** — serves a temp file by name; `name` query param sets the client-visible download filename (sanitized), the server keeps the real extension.

**`GET /v1/models`** / **`GET /v1/models/{model}`** — static OpenAI-shaped model list (`tts-1`, `tts-1-hd`, `kokoro`, `gpt-4o-mini-tts`), cosmetic only, all resolve to the one Kokoro model.

**`GET /v1/audio/voices?legacy=false`** — lists voices:
```jsonc
{ "voices": [{"id":"af_bella","name":"af_bella","target_quality":"...","training_duration":"...","overall_grade":"..."}, ...],
  "default_voice": "af_heart" }
```
Grade fields come from `core/voice_grades.json` (scraped from the model card) and are only present for graded voices (English mainly); Spanish/Portuguese/custom `.pt` voices omit them. `?legacy=true` returns the old `{"voices": ["af_bella", ...]}` shape for older clients.

**`POST /v1/audio/voices/combine`** — body is a voice-combo string or list of names; returns the combined `.pt` file as `application/octet-stream`. 403 unless `ALLOW_LOCAL_VOICE_SAVING=true`.

### 2.2 Extended / dev (`api/src/routers/development.py`, no `/v1` prefix)

**`POST /dev/phonemize`** → `{phonemes, tokens}` — text→IPA via a quiet (`model=False`) `KPipeline`, no synthesis.

**`POST /dev/generate_from_phonemes`** — synth directly from an IPA phoneme string (`{"phonemes": "...", "voice": "af_bella"}`), always WAV, non-streaming-friendly single chunk.

**`POST /dev/dialogue`** — structured multi-speaker turns:
```jsonc
{ "turns": [{"voice":"af_bella","text":"..."}, {"voice":"am_michael","text":"..."}],
  "pause_between_turns": 0.4, "response_format": "mp3", ... }
```
This is a thin wrapper: `DialogueRequest.to_tagged_input()` renders turns to `"[voice:x] ... [pause:0.4s] [voice:y] ..."` and calls the *same* `create_speech()` used by `/v1/audio/speech`, with `allow_voice_tags` forced on. Consecutive same-voice turns are merged before rendering.

**`POST /dev/captioned_speech`** — **this is the one Tamber should study hardest.** Same request shape as `OpenAISpeechRequest` plus `return_timestamps: true` (default). Non-streaming response:
```jsonc
{ "audio": "<base64>", "audio_format": "audio/mpeg",
  "timestamps": [{"word":"Hello","start_time":0.0,"end_time":0.32}, {"word":"world!","start_time":0.32,"end_time":0.61,"voice":"af_bella"}] }
```
(`voice` per-word only appears when `allow_voice_tags:true` was used.) **Streaming response** (`stream:true`, the default) is `application/json` with `JSONStreamingResponse` (`api/src/structures/custom_responses.py`) — **this is literally newline-delimited JSON**: one `CaptionedSpeechResponse` JSON object per line, each carrying `audio` (base64 of that chunk's encoded bytes), `audio_format`, and that chunk's `timestamps`. **This is functionally identical to Tamber's planned NDJSON chunk protocol** — the shape already exists upstream, just not surfaced through the bundled web UI (see §6). The one structural gap: as built, each line's `audio` bytes are *not* independently decodable (see §5) — Tamber must fix that at the encoder level, not just copy the endpoint.

**`POST /dev/unload`**, **`POST /dev/reload`**, **`GET /dev/model`** — VRAM lifecycle, all 403 unless `ALLOW_DEV_UNLOAD=true`.

### 2.3 SSML (`api/src/routers/ssml.py`)

**`GET /dev/ssml`** → `SsmlCapabilities` (which elements translate vs. get ignored, break-strength table, prosody-rate table, rate bounds). **`POST /dev/ssml`** → `{"text": "..."}`, translates SSML to the native `[voice:]`/`[rate:]`/`[pause:Ns]`/`[Word](/ipa/)` tag language without synthesizing. Both routes 403 when `ENABLE_SSML=false`. On the speech endpoints, `ssml:true` requires `allow_voice_tags:true` (translation emits those tags) and is applied server-side via `apply_ssml()` before the normal pipeline runs.

### 2.4 Voice tuning (`api/src/routers/tune.py`)

**`POST /dev/tune`** (multipart) — `audio` file (3–30s reference clip, one speaker), optional `request` (JSON body identical to `/v1/audio/speech` minus `voice`), `prosody_head` (bool, default true), `fmax` (60–1000 Hz), `return_voice_pack` (bool), `save_voice` (name, must match `^[ab][a-z]?_[a-z0-9]+(_[a-z0-9]+)*$`, gets `_tuned` suffix). Uses the separate `inno-kokoro` package. 403 unless `ENABLE_INNO_TUNER=true` (and `save_voice` additionally needs `ALLOW_LOCAL_VOICE_SAVING=true`). The resulting pack is registered as a *transient* voice (in-memory, via `VoiceManager.register_transient`) and garbage-collected via `BackgroundTask`/generator-wrapping after the response finishes, unless `save_voice` persisted it to `VOICES_DIR`. Not a priority for Tamber v1, but the transient-voice pattern (a voice usable by name for the lifetime of one response without touching disk) is a clean pattern if Tamber ever adds custom voice upload.

### 2.5 Debug (`api/src/routers/debug.py`)

`/debug/threads`, `/debug/storage`, `/debug/system` — psutil/GPUtil/torch introspection, JSON dumps of thread stacks, disk usage, CPU/mem/GPU. All 403 unless `ENABLE_DEBUG_ENDPOINTS=true`. Not something Tamber needs to replicate; if anything a smaller `/healthz`-style GPU/queue-depth endpoint behind the same bearer key is enough.

### 2.6 Web player support (`api/src/routers/web_player.py`)

**`GET /web/config`** → `{"root_path": "", "version": "...", "tuner": bool, "voice_saving": bool}` — lets the static JS detect a reverse-proxy path prefix (`UVICORN_ROOT_PATH`) and feature-flags at runtime. **Worth stealing for Tamber**: the web/extension/mobile clients configuring against a NetBird-fronted URL will want a tiny `/web/config`-equivalent (or reuse the existing OpenAPI/health surface) to learn capabilities without hardcoding them.

**`GET /web/{filename:path}`** — serves any file under `web/` by reading bytes off disk and sniffing content-type from extension; falls back to `index.html` for the root. No caching (`Cache-Control: no-cache` always) — fine for a small SPA, but Tamber's Vite-built assets should get long-cache + hashed filenames instead (see §8).

### 2.7 Everything else

`GET /health` → `{"status":"healthy"}`. `GET /v1/test` → `{"status":"ok"}`. `GET /openapi.json`/`/docs` — full FastAPI-generated OpenAPI + Swagger UI, no auth guard on it either.

---

## 3. Voices: listing, combination, aliases, dialogue

- **Storage**: voices are `.pt` PyTorch tensors, one per file, committed straight into the git repo at `api/src/voices/v1_0/*.pt` (I counted 78 files in the clone: `af_*`, `am_*`, `bf_*`, `bm_*` for US/UK English, plus `ef_/em_` Spanish, `ff_` French, `hf_/hm_` Hindi, `if_/im_` Italian, `jf_/jm_` Japanese, `pf_/pm_` Portuguese, `zf_/zm_` Chinese, and a handful of `*_inno` — pre-baked Inno-tuned voices). They ship inside the image; nothing is downloaded at runtime for voices.
- **Naming convention**: first letter = language (`a`=American English, `b`=British English, `e`=Spanish, `f`=French, `h`=Hindi, `i`=Italian, `j`=Japanese, `p`=Portuguese, `z`=Chinese), second letter = `f`/`m` gender. `lang_code` for the pipeline defaults to `voice_name[0].lower()` unless overridden by request `lang_code` or the `DEFAULT_VOICE_CODE` setting.
- **Weighted combination syntax** — this is the one from Tamber's brief: `"af_bella(2)+af_sky(1)"` → 2:1 ratio → 67%/33% after normalization (`voice_weight_normalization: true` by default; set false to keep raw weights, e.g. for building up a combo across repeated `+`). Grammar, from `openai_compatible.py`:
  - Split on `+`/`-` while keeping the separators: `re.split(r"([-+])", voice_input)`.
  - Each token matches `(?P<name>[^()]+)(?:\((?P<weight>[^()]*)\))?` — a bare name or `name(weight)`, weight must parse as a positive finite float.
  - Leading/trailing `+`/`-` or doubled operators (`++`, `+-`) are rejected before parsing.
  - Actual combination (`TTSService.get_voices_path`) **loads each `.pt` tensor and does linear arithmetic on the tensors themselves** (`torch.load(...) * weight`, then `+=`/`-=` across the split), saves the result to a temp `.pt`, and that becomes the "voice" fed to the pipeline. So voice mixing is literally averaging/blending the style tensors, not any kind of runtime crossfade of audio. `-` support means you can subtract a voice's tensor too (used for style ablation, not documented as a headline feature).
  - Combined voices can be persisted via `POST /v1/audio/voices/combine` → downloadable `.pt`, or referenced directly and re-derived on the fly every request (default) if you don't need the file.
- **Voice aliases** (`voice_aliases` field, `VoiceAliasesMixin` in schemas.py) — short names mapped to either a plain string (`"narrator": "af_bella(2)+af_sky"`) or an object carrying a per-alias **rate**: `"grandpa": {"voice": "am_michael", "rate": 0.8}`. Alias resolution is case-insensitive, happens both for the top-level `voice` field and for `[voice:...]` tags, and an alias pointing at an unknown voice is a 400. The rate semantics are non-trivial and worth copying: a `[rate:x]` tag *scales* the speaking voice's own calibrated rate rather than replacing it, and any `[voice:...]` tag resets both the base and tag rate — so a "reads slow" alias can't leak its pace onto the next speaker. Useful pattern for Tamber if it ever wants named voice presets with baked-in pacing.
- **Multi-speaker / dialogue via inline tags**: `[voice:am_michael]` switches speaker for everything that follows, gated by `allow_voice_tags:true` per-request AND `ENABLE_VOICE_TAGS=true` server-wide (on by default; off makes the tag literal text and 403s `/dev/dialogue`). Implementation: `split_by_voice()` in `text_processor.py` splits the raw text on a combined regex for `[voice:]`/`[rate:]`/`[baserate:]` tags, tracks running voice/rate state, merges consecutive same-(voice,rate) runs, and each resulting segment gets its own `smart_split()` pass (so voice switches don't break sentence-level chunking within a segment). Each segment resolves its own voice path once and reuses it — so switching speakers doesn't reload anything per line.
- **Inline control tokens** parsed server-side, available to any client via the `input` string (no special API flag beyond `allow_voice_tags` for `[voice:]`; `[pause:]`/pronunciation are always live):
  - `[pause:1.5s]` — exact syntax required (`colon, decimal, trailing s`); total pause budget is capped (`MAX_PAUSE_DURATION_S`=60s per tag, `MAX_TOTAL_PAUSE_S`=300s per request, checked pre-stream so an over-budget request 400s before headers go out).
  - `[Worcester](/wˈʊstər/)` — inline IPA override, English only.
  - `[voice:name]`, `[rate:1.5]` — covered above.
- **SSML** (`services/text_processing/ssml.py`, 170 lines) translates a subset (`<speak>`, `<break time/strength>`, `<voice name>`, `<prosody rate>`, `<phoneme alphabet="ipa">`, `<sub alias>`) into those same inline tokens; unsupported elements (`<emphasis>`, `<say-as>`, `<p>`, `<lang>`, vendor-prefixed extensions) have their markup stripped but text kept. DTDs rejected, nesting capped at `SSML_MAX_DEPTH=10`.

---

## 4. Text normalization & chunking (the part Tamber's "sentence-sized NDJSON chunks" idea maps directly onto)

Pipeline (`api/src/services/text_processing/text_processor.py`, `smart_split()`):

1. **Pause-tag split first**, on the raw text, via `PAUSE_TAG_PATTERN.split()` — so pauses are never affected by normalization/chunking below them.
2. **Line/paragraph joining** (`join_lines`): blank-line runs = paragraph breaks (kept as separate normalization units, punctuation forced onto paragraph ends that lack it); single `\n` = just whitespace.
3. **Normalization** (`services/text_processing/normalization/english.py` + a per-language registry via `get_normalizer(lang_code)`) — numbers, units, URLs, emails, phone numbers, ALL-CAPS-as-words-not-spelled-out (with short-acronym exceptions like FBI), symbol-to-word replacement, optional emoji removal. Entirely toggleable per-field in `NormalizationOptions`; `[Word](/ipa/)` custom-phoneme spans are protected from normalization via a split/rejoin around `CUSTOM_PHONEMES` regex so normalization never touches text inside them.
4. **Sentence segmentation**: `unicode_sentences(text)` from the Rust crate binding `unicode_segmentation_rs` (real Unicode sentence-boundary algorithm, not a naive regex) — good candidate dependency for Tamber's Python API too, or an equivalent JS/ICU segmenter if any client-side pre-chunking is ever wanted.
5. **Token-budget packing** (`chunk_sentences`/`pack`): each sentence is phonemized+tokenized (`process_text_chunk` → `phonemize()` + `tokenize()`) to get a token count, then greedily packed:
   - Target range **`TARGET_MIN_TOKENS=175`, `TARGET_MAX_TOKENS=250`, `ABSOLUTE_MAX_TOKENS=450`** (all env-configurable). Packer fills toward `target_max`, and will run past it up to `absolute_max` only while still under `target_min` (so a lone short sentence isn't stranded as a tiny chunk).
   - A sentence that alone exceeds `max_tokens` is split at clause punctuation (`,;:，、；：` — note CJK punctuation included) via `split_clauses`, and if a clause is *still* too big, `split_words` binary-searches the longest word-run that fits (rephonemizing at each probe — not cheap, but only hit on pathological input).
   - The model itself caps at **510 phonemized tokens/chunk**; Kokoro-FastAPI deliberately chunks well under that (175–450) because running it near the ceiling produces "rushed" artifacts.
6. **Yields** `(chunk_text, tokens, pause_duration_s)` tuples — either a text chunk or a pause chunk, interleaved in original order. `TTSService.generate_audio_stream` consumes this generator, and for each item either synthesizes silence (`np.zeros`, exact sample count for the pause duration at 24kHz) or calls into `KokoroV1.generate()` for real audio + optional per-chunk word timestamps, accumulating a running `current_offset` in seconds so multiple chunks concatenate into one continuous timeline.

**This chunking design is exactly the granularity Tamber wants for its own NDJSON protocol** — "sentence-sized chunks" in Tamber's brief maps 1:1 onto what `smart_split` already produces server-side; the only new work is (a) flushing one NDJSON line **per chunk** instead of accumulating everything into one continuous encoded stream, and (b) making each chunk's encoded bytes self-contained (§5).

---

## 5. Streaming mechanics — and the critical gotcha for Tamber

`generate_audio_stream()` iterates chunks from `smart_split`/`_split_multi_voice` and, for each, calls `_process_chunk()` → `KokoroV1.generate()` → one `AudioChunk(audio: np.float32[], word_timestamps)` per Kokoro-internal chunk, then (if `output_format` given) `AudioService.convert_audio()` → `StreamingAudioWriter.write_chunk()`.

**The gotcha**: `StreamingAudioWriter` (`api/src/services/streaming_audio_writer.py`) is instantiated **once per HTTP request** and holds one long-lived PyAV `container`/`stream` for the *entire* response:

```python
class StreamingAudioWriter:
    def __init__(self, format, sample_rate, channels=1):
        ...
        self.container = av.open(self.output_buffer, mode="w", format=self.format, options=container_options)
        self.stream = self.container.add_stream(codec_map[self.format], rate=sample_rate, layout=...)

    def write_chunk(self, audio_data=None, finalize=False):
        ...
        frame = av.AudioFrame.from_ndarray(audio_data.reshape(1, -1), format="s16", layout=...)
        frame.pts = self.pts; self.pts += frame.samples
        packets = self.stream.encode(frame)
        for packet in packets: self.container.mux(packet)
        data = self.output_buffer.getvalue()
        self.output_buffer.seek(0); self.output_buffer.truncate(0)   # <-- buffer recycled, NOT re-headered
        return data
```

Every sentence-chunk's numpy audio gets muxed into the **same** ongoing container/stream. `write_chunk()` returns whatever new bytes landed in the buffer since the last call and then clears the buffer — but the encoder/muxer state (MP3 bit reservoir, WAV `data` chunk byte count, etc.) is never reset between calls. Concretely:
- For **MP3**: only the very first `write_chunk()` call's bytes include the file/stream headers; every subsequent call returns raw continuation frames that depend on the encoder's running bit-reservoir state. They are **not** individually valid MP3 files.
- For **WAV**: PyAV writes the `RIFF`/`fmt `/`data` header once, on the first mux; later calls return bare PCM bytes with no header at all. (Also: the response is a **streaming WAV with a `0xFFFFFFFF` sentinel size field** since final length isn't known up front — explicitly called out in the README's troubleshooting section as breaking Python's stdlib `wave` module, though `soundfile`/`ffmpeg`/browsers handle it fine.)
- Only the **full concatenation of every streamed byte for the whole request** is a valid, decodable audio file. This is *why* the client-side design has to be MSE-based (progressively feed one ever-growing SourceBuffer) or block-mode (buffer everything, then decode once) — **individual over-the-wire chunks were never meant to be independently decodable** in this codebase.

**Tamber cannot reuse this encoder as-is.** Tamber's hard constraint is "each NDJSON line contains a complete, independently decodable audio chunk" for `decodeAudioData()` per line on iOS. That means Tamber's server needs to instantiate a **fresh `StreamingAudioWriter` (fresh PyAV container) per text chunk**, not one per request, and call `write_chunk(..., finalize=True)` to flush a complete, self-contained file (with header) for every chunk before moving to the next chunk's writer. This is a small, mechanical change (the class already exists and already supports `finalize`) but it is a real code change, not a drop-in reuse — verify this in Tamber's own implementation rather than assuming the upstream streaming path already produces independent chunks.

Also note for chunk boundaries: `settings.gap_trim_ms` (default 1ms) and `dynamic_gap_trim_padding_ms` (410ms, weighted per trailing punctuation via `dynamic_gap_trim_padding_char_multiplier`) control how much of each chunk's trailing silence `AudioService.trim_audio`/`convert_audio` trims — relevant if Tamber wants gapless playback across independently-decoded chunks scheduled back-to-back on a Web Audio timeline; copy this trimming logic (or equivalent) so chunk boundaries don't have silence gaps or double-counted padding when precisely scheduled.

**Sentence/chunk-level timing sidecar** (`return_timing` + `return_download_link` on `/v1/audio/speech`): while streaming, `timings` list accumulates `{"text": chunk_text, "start": ..., "end": ...}` (seconds in final audio, post-speed/pause) per chunk, written as `{"chunks": [...]}` JSON next to the temp download file, fetched via the `X-Timing-Path` header after the stream ends. Pauses appear as `{"text": ""}` entries. This is chunk-level only (10-20s granularity), **not** word-level — word-level only comes from `/dev/captioned_speech`.

---

## 6. Word-level timestamps — exactly how they're produced

This directly confirms Tamber's brief. In `api/src/inference/kokoro_v1.py`, `KokoroV1.generate()`:

```python
for result in pipeline(text, voice=voice_path, speed=speed, model=self._model):
    if result.audio is not None:
        word_timestamps = None
        if return_timestamps and hasattr(result, "tokens") and result.tokens:
            word_timestamps = []
            for token in result.tokens:
                if not all(hasattr(token, a) for a in ("text","start_ts","end_ts")): continue
                if not token.text or not token.text.strip(): continue
                if token.start_ts is None or token.end_ts is None: continue
                word_timestamps.append(WordTimestamp(
                    word=str(token.text).strip(),
                    start_time=float(token.start_ts) + current_offset,
                    end_time=float(token.end_ts) + current_offset,
                ))
        elif return_timestamps and result.phonemes and type(getattr(pipeline,"g2p",None)).__name__ == "EspeakG2P":
            word_timestamps = _espeak_word_timestamps(result.graphemes, result.phonemes, result.pred_dur, g2p=pipeline.g2p)
        yield AudioChunk(result.audio.numpy(), word_timestamps=word_timestamps)
```

- **English** (misaki G2P, voices `a*`/`b*`) gets timed tokens straight from `KPipeline` — this confirms Tamber's brief precisely: **`result.tokens[i].start_ts`/`.end_ts` from the hexgrad `kokoro` package's `KPipeline` is the ground truth for word timing**, no separate forced-aligner needed.
- **Espeak-backed languages** (`es/fr/it/hi/pt` — `e*/f*/i*/h*/p*` voices) get **no** timed tokens from KPipeline; Kokoro-FastAPI derives them itself from `result.pred_dur` (the model's per-phoneme predicted duration array) by: converting `pred_dur` units to seconds via a fixed scale (`_ESPEAK_TS_SCALE = 2.0/80.0`, matching KPipeline's own internal `join_timestamps` scale), walking the phoneme string and splitting duration-groups at whitespace (since espeak phoneme output is space-separated per word), and reconciling word/group count mismatches (numbers/abbreviations that expand to N spoken words) by re-phonemizing each word individually via the pipeline's own `g2p` callable and merging groups accordingly. If group and word counts still don't reconcile, it gives up and returns `None` — no client-visible timestamps for that chunk, not an error.
- **Japanese and Chinese** (`j*/z*`) get **no word-level timestamps at all** — `_espeak_word_timestamps` only applies to `EspeakG2P` pipelines, and ja/zh G2P has no space-separated word groups to split on anyway (CJK doesn't segment into whitespace-delimited words). **Tamber should plan explicitly for "no karaoke highlighting for ja/zh"** rather than assume timestamps are universal — this is a real, permanent gap in the upstream model/pipeline, not a bug to route around.
- Each chunk's `current_offset` (running seconds since request start) is added to that chunk's own local `start_ts`/`end_ts` in `TTSService.generate_audio_stream`, so timestamps returned to the client are already absolute over the whole response, not per-chunk-relative. Tamber's NDJSON design should decide explicitly whether it wants absolute-timeline timestamps (simpler client math, but ties the client to knowing prior-chunk durations) or per-chunk-relative timestamps (simpler if each chunk is scheduled independently on its own Web Audio buffer's start offset) — upstream picked absolute; either is fine as long as it's documented.
- **Character offsets into the original text** (Tamber's brief also wants these, for e.g. simultaneous text-selection highlighting) are **not** something Kokoro-FastAPI produces anywhere — `WordTimestamp` only carries `word`/`start_time`/`end_time`/`voice`. If Tamber wants character offsets, it has to add its own mapping from spoken chunk text back to original source offsets, similar in spirit to (but more robust than) the web UI's own fuzzy `alignChunks` heuristic in §7 — likely straightforward since Kokoro-FastAPI's own normalization pipeline already tracks position implicitly through `unicode_sentences`, but this needs new code, it isn't exposed today.

---

## 7. The bundled web UI's audio pipeline — the exact iOS break, in the actual code

`web/` is a **hand-rolled, no-build, vanilla-ES-modules** app (`type="module"` script tags, zero bundler, zero npm runtime deps — `package.json`'s only dependency is `@playwright/test` for e2e). `siriwave.js` is vendored directly as a plain script. This is architecturally nothing like Tamber's Vite+React+TS+Mantine plan; there's no component/state-library pattern to port, only the *behavior* to match or exceed.

### 7.1 The exact MSE usage (`web/src/services/audio/MsePipeline.js`)

```js
this.mediaSource = new MediaSource();
this.objectUrl = URL.createObjectURL(this.mediaSource);
this.audio.src = this.objectUrl;
this.mediaSource.addEventListener('sourceopen', async () => {
    this.sourceBuffer = this.mediaSource.addSourceBuffer('audio/mpeg');
    this.sourceBuffer.mode = 'sequence';
    ...
    this.sourceBuffer.appendBuffer(chunk);   // raw fetch-stream bytes, straight from /v1/audio/speech
});
```
It reads the **raw fetch `ReadableStream`** body of `/v1/audio/speech?response_format=mp3&stream=true` and `appendBuffer()`s each read directly into a `'sequence'`-mode SourceBuffer typed `'audio/mpeg'`. This works *only* because (per §5) the whole stream is one continuous MP3 encode — MSE's job here is literally "decode this growing MP3 file live," which is exactly the MSE use case, and exactly what iOS Safari does not support.

The pipeline also implements real bounded-buffer management worth noting as prior art (not iOS-relevant, but good streaming-buffer design in general): a 60s "leading edge" backpressure cap (stop appending once buffered-ahead-of-playhead exceeds `MAX_LEAD_SECONDS`), a 30s trailing eviction window (`sourceBuffer.remove()` of anything more than 30s behind `currentTime`, down to 15s behind), and `QuotaExceededError` handling that evicts from the buffer start and retries the same chunk. None of this is needed in Tamber's per-chunk-decodeAudioData design (each decoded `AudioBuffer` can simply be discarded/GC'd after it plays), but it's a useful reference if Tamber ever needs to bound total decoded-audio memory for very long documents.

### 7.2 How it detects "MSE won't work" and what happens then (`web/src/services/AudioService.js`)

```js
supportsMSEMp3() {
    return typeof window !== 'undefined' && 'MediaSource' in window &&
        typeof MediaSource.isTypeSupported === 'function' &&
        MediaSource.isTypeSupported('audio/mpeg');
}
shouldUseMseStream(responseFormat, canStreamMp3) {
    return responseFormat === 'mp3' && canStreamMp3;
}
```
On iOS Safari, `window.MediaSource` is `undefined` (iOS only ever shipped the restricted `ManagedMediaSource`, and even that only from iOS 17.1+, and this code never touches `ManagedMediaSource` at all) — so `supportsMSEMp3()` is `false` there. **The important nuance: this is not a crash.** `setupAudioStream()` checks `canUseMseStream` up front and, when false, calls `setupBlockMode()` instead:

```js
async setupBlockMode(stream, response, onProgress, estimatedChunks) {
    const loader = new BlockLoader({ onProgress: ... });
    const chunks = await loader.load(stream);       // reads the ENTIRE response body into memory first
    ...
    const blob = new Blob(chunks, { type: blobType });
    this.audio.src = URL.createObjectURL(blob);       // then plays it as one ordinary file
}
```
So **on iOS Safari today, Kokoro-FastAPI's web UI still produces audio — it just silently downgrades to "wait for the whole generation to finish downloading, then play it as a single file."** For a short phrase that's invisible. For a long article/book (the README's own benchmark uses full novels, "~1.5 hours output"), that means the iOS user stares at a spinner for however long the *entire* TTS generation + full download takes before hearing a single word — which defeats the entire purpose of streaming and is a materially broken experience even though nothing throws an exception. This is the accurate framing for Tamber's docs/marketing: **not "crashes on iOS," but "silently loses all progressive playback and can force multi-minute silent waits on long input."** `wav`/`pcm` formats always go through block mode too (`shouldUseMseStream` only allows `mp3`), so even on desktop Chrome, choosing WAV output means no streaming playback in this UI at all — another gap Tamber's NDJSON-chunk design avoids entirely by never depending on format-specific MSE support.

Other iOS-relevant issues visible in this file:
- Uses a plain `<audio>` element + `fetch()` body streaming throughout — no Web Audio `AudioContext` anywhere in this UI, so there's no explicit "unlock on user gesture" logic to find or copy; Tamber's Web-Audio-based design needs its own unlock-on-gesture handling from scratch (standard iOS Safari requirement whenever `AudioContext.decodeAudioData`/scheduled playback is used instead of a bare `<audio>` element).
- The "swap to full file source" dance (`swapToFileSource`, `canSwapToFileSource`, preloading the finished download as a Blob) exists purely to work around MSE's bounded/evicted buffer not supporting true seeking/duration once a long generation finishes — an entire subsystem (roughly 150 lines) that Tamber's architecture (independent decoded chunks, not a live-growing MSE buffer) has no need to replicate, since seeking in Tamber's design is just "jump to the chunk whose char-offset range contains the target and start scheduling from there."

### 7.3 The "read-along" karaoke highlighting is NOT word-level, and NOT from `/dev/captioned_speech`

This is a significant, concrete gap for Tamber to exceed. The bundled UI's `ReadAlong` feature (`web/src/components/ReadAlong.js`, `readAlong.js`, `readAlongTiming.js`) never calls `/dev/captioned_speech` at all. It:
1. Calls plain `/v1/audio/speech` with `return_timing: true` + `return_download_link: true` (chunk/sentence-level timing sidecar, §5 — not word-level).
2. Segments the *source text* into sentences client-side (`segmentSentences`, its own regex-based sentence splitter, separate from and cruder than the server's `unicode_sentences`).
3. **Fuzzy-aligns** the sentence list to the server's chunk-timing list by anchor-word matching (`alignChunks` in `readAlongTiming.js`): takes the first ~5 words of each server chunk, searches a ±40/+80-word window in the client's own re-tokenized source text for a best-effort match, then linearly interpolates sentence start times *within* a matched span by proportional character-weight (`weightOf` = spoken-character-count + a fixed 14-"char" pause weight per sentence, to approximate inter-sentence pause time).
4. If the timing fetch fails or chunks don't align, it falls back further still — to `sentenceIndexAt(sentences, currentTime/duration)`, i.e. **pure proportional-fraction guessing** with zero server timing data at all.
5. Highlighting granularity is **whole sentences**, not words, and resync only happens every 200ms (`SYNC_MS`) via `setInterval`, not per audio-frame.

**Tamber's planned design (true per-word timestamps from `/dev/captioned_speech`-equivalent, scheduled against each chunk's own decoded-buffer start time) is strictly more accurate and more granular than anything in the existing web UI** — this is the single clearest "exceed the original" opportunity, and it's low-effort since the server-side data (word tokens with real timestamps) already exists in the codebase, just unused by this particular client.

### 7.4 Other web UI UX features worth cataloguing (to match or deliberately exceed)

- **Editor**: paginated `<textarea>`-based editor (`TextEditor.js`), default 500 chars/page (adjustable 100–2000, "Format" button), page jump input, find/replace panel, `.txt` file upload, "Clear text", live character count.
- **Voice picker**: searchable dropdown (`VoiceSelector.js`, 608 lines) plus a "Cast" system — pin voices, insert `[voice:]` tags at cursor, rename/duplicate/edit-mix/remove, export/import the whole cast as JSON (`{"voice_aliases": {...}}` — the same shape as the API's `voice_aliases` field, so it round-trips directly into API calls). Separate tabs for plain voice selection vs. tag/alias authoring vs. voice tuning (record/upload a reference clip, live waveform canvas, accent radio US/UK, pitch-ceiling override, save-to-server or download-`.pt`).
- **Generation controls**: speed (0.1–4, note: UI allows finer range than the API's 0.25–4 clamp), language dropdown (Auto + 8 languages), format dropdown (**only mp3/wav/pcm exposed in the UI**, despite the API also supporting opus/flac/aac), a collapsible normalization-options panel mirroring every `NormalizationOptions` flag individually.
- **Player dock**: SiriWave "ios9"-style waveform visual — **note this is a canned idle/active animation keyed only off play/pause state, not real audio-reactive amplitude analysis** (no `AnalyserNode` anywhere in this codebase); a determinate `<progress>` bar during generation (chunk-received-count / estimated-chunk-count, estimated purely from `text.length / 150 chars-per-chunk`, i.e. a guess, not the server's real chunk count); seek slider + time display; volume slider; a download menu offering audio / timing-JSON / both.
- **Respects `prefers-reduced-motion`** for the waveform animation — worth carrying into Tamber's "very animated" client too, given the explicit mobile-first/iOS requirement (motion-heavy UI + battery/accessibility considerations go hand in hand).
- **`/web/config` root-path autodetection** so the same static bundle works whether served at `/web/` directly or behind a reverse-proxy path prefix — same problem Tamber's NetBird-fronted deployment will have; worth an equivalent tiny runtime-config fetch (or bake the API base URL as a build-time env var Tamber's own settings screen can override, since Tamber's brief already requires a user-configurable API base URL anyway).

**Tamber's UX bar to clear**: word-level (not sentence-level) highlighting, real per-chunk progress (not a length/150 estimate), true streaming-with-progressive-playback on iOS (not a silent block-mode downgrade), and a build pipeline (Vite) that gets asset hashing/long-term caching instead of the `Cache-Control: no-cache` the Python static-file router hardcodes for every web asset today.

---

## 8. Docker, images, env vars, model/voice caching

### 8.1 Images

Multi-stage `docker/cpu/Dockerfile.optimized` (GPU variant is structurally the same, adds CUDA base + `--extra gpu`):
1. **Builder** stage: `python:3.12`, installs `git curl g++ cmake make` (cmake/g++ needed because `pyopenjtalk-plus` ships sdist-only), installs `uv`, `uv sync --frozen --extra cpu --no-install-project` using `pyproject.toml`+`uv.lock`.
2. **Runtime** stage: `python:3.12-slim`, installs `espeak-ng espeak-ng-data libsndfile1 curl`, symlinks espeak data, creates non-root `appuser` (uid 1000), copies the built `.venv` from the builder.
3. **Model baking**: copies `download_model.py` + the (mostly-empty, cache-stable) `api/src/models` tree, then `ARG DOWNLOAD_MODEL=true` runs `download_model.py --output api/src/models/v1_0` **at build time** — so the ~330MB `kokoro-v1_0.pth` + `config.json` are baked into the image layer, not fetched on container start (entrypoint.sh re-runs the same script as a fallback/no-op if the files are already valid).
4. **Japanese support**: `ARG INCLUDE_JAPANESE=true` runs `python -m unidic download` (~526MB UniDic dictionary for fugashi/MeCab) — explicitly called out as "keep true, false silently breaks ja generation," and a real image-size lever if Tamber doesn't need Japanese.
5. Copies `api/` (minus the model dir, already baked), `web/`, `VERSION`, `entrypoint.sh`; runs as `appuser`; `CMD ["./entrypoint.sh"]`.

Runtime env baked into the image: `PYTHONUNBUFFERED=1`, `PYTHONPATH=/app:/app/api`, `PATH` prepends the venv, `USE_GPU=false`, `PHONEMIZER_ESPEAK_PATH=/usr/bin`, `PHONEMIZER_ESPEAK_DATA=/usr/share/espeak-ng-data`, `ESPEAK_DATA_PATH=/usr/share/espeak-ng-data`, `DEVICE="cpu"`.

`entrypoint.sh`:
```bash
if [ "${DOWNLOAD_MODEL:-true}" = "true" ]; then python download_model.py --output api/src/models/v1_0; fi
exec python -m uvicorn api.src.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8880}" --log-level debug
```

### 8.2 Model download/caching (`docker/scripts/download_model.py`)

- Downloads exactly two files, `kokoro-v1_0.pth` + `config.json`, from a **pinned GitHub Releases URL** (`github.com/remsky/Kokoro-FastAPI/releases/download/v0.1.4/...`) — **not** HuggingFace directly for the base model (HF is only cited in docs/README as "where the model comes from" upstream of that pinned release mirror).
- Verifies via **hardcoded SHA-256** per file before accepting; downloads to `.download` temp suffix and only `os.replace()`s into place after checksum passes (avoids partial/corrupt files surviving a crash mid-download).
- `verify_files()` also rejects a model file under 100MB (guards against an error-page HTML body having been saved in place of the real binary — a real past incident per its comment, `#301`).
- Idempotent: if valid files already exist, it's a no-op — this is what lets `entrypoint.sh` call it unconditionally on every container start with negligible cost.
- Separately, `download_tuner()` fetches Inno-tuner weights from HuggingFace Hub (`huggingface_hub.hf_hub_url`) into `<output>/inno_tuner`, and does an async "is a newer revision available" check capped at 3 seconds, skipped entirely under `HF_HUB_OFFLINE`/`HF_HUB_DISABLE_TELEMETRY`. Only invoked if the tuner feature is used; not relevant to Tamber's core scope.
- **Voices are not downloaded at all** — see §3, they're committed `.pt` files baked into the image via the plain `COPY api ./api` step.

### 8.3 Compose files & key env vars

`docker/cpu/docker-compose.yml` / `docker/gpu/docker-compose.yml` (ROCm variant analogous): builds from the repo root with the platform Dockerfile, maps `8880:8880`, mounts `../../web:/app/web` (**hot-reloads UI edits without a rebuild** — nice pattern, though Tamber's UI has a real build step so this becomes "mount the built `dist/` output" instead), optional `.env` file at repo root, and a commented-out menu of the interesting toggles: `API_LOG_LEVEL`, `ENABLE_INNO_TUNER`, `ALLOW_DEV_UNLOAD`, `ENABLE_DEBUG_ENDPOINTS`. GPU compose adds the standard `deploy.resources.reservations.devices` NVIDIA block.

Full settings surface (`api/src/core/config.py`, a `pydantic_settings.BaseSettings` reading env vars case-insensitively + an optional `.env` file, unknown keys logged-and-ignored rather than fatal — a good defensive pattern to copy): `HOST`, `PORT`, `DEFAULT_VOICE`, `DEFAULT_VOICE_CODE`, `USE_GPU`, `DEVICE_TYPE`, `ENABLE_MIOPEN` (ROCm), `ALLOW_LOCAL_VOICE_SAVING`, `ALLOW_DEV_UNLOAD`, `ENABLE_INNO_TUNER`, `MODEL_AUTO_UNLOAD_TIMEOUT_SECONDS`, `ENABLE_DEBUG_ENDPOINTS`, `ENABLE_VOICE_TAGS`, `ENABLE_SSML`, `MODEL_DIR`/`VOICES_DIR`/`MODEL_REPO_ID`, `DEFAULT_VOLUME_MULTIPLIER`, `TARGET_MIN_TOKENS`/`TARGET_MAX_TOKENS`/`ABSOLUTE_MAX_TOKENS`, `SSML_MAX_DEPTH`, `MAX_PAUSE_DURATION_S`/`MAX_TOTAL_PAUSE_S`, `MAX_INPUT_LENGTH` (1,000,000 chars default), `ADVANCED_TEXT_NORMALIZATION`, `VOICE_WEIGHT_NORMALIZATION`, `GAP_TRIM_MS`/`DYNAMIC_GAP_TRIM_PADDING_MS`, `ENABLE_WEB_PLAYER`, `WEB_PLAYER_PATH`, **`CORS_ORIGINS` (list, default `["*"]`) / `CORS_ENABLED`** (Tamber's "CORS must be configurable" requirement maps directly onto reusing this exact pattern), `TEMP_FILE_DIR`/`MAX_TEMP_DIR_SIZE_MB`/`MAX_TEMP_DIR_AGE_HOURS`/`MAX_TEMP_DIR_COUNT`. **No API-key/auth setting exists anywhere** — confirmed by grep, zero hits for `authorization`/`api_key`/`bearer` in `api/src/`.

---

## 9. What Tamber should keep, change, and drop

**Keep (proven, worth reusing the design of, even if reimplemented):**
- The overall single-container shape: FastAPI app that both serves the TTS API and the built static UI from one process/port.
- Word-level timestamps sourced straight from `KPipeline`'s `token.start_ts`/`end_ts` for English — this is the real, working mechanism Tamber's brief already assumes; the espeak-`pred_dur` fallback for es/fr/it/hi/pt is worth copying near-verbatim (it's non-trivial and already solved), and Tamber should explicitly document/accept "no word timestamps for ja/zh" as a model-level limitation, not something to work around.
- The sentence-aware, token-budget chunking algorithm (`smart_split`: Unicode sentence segmentation → greedy pack to `target_min/max` → clause-then-word fallback splitting for oversized sentences) as the basis for how Tamber decides NDJSON chunk boundaries. The specific tunables (175/250/450 tokens) are a reasonable starting point.
- Weighted voice-mixing syntax `name(weight)+name(weight)` and the "load tensors, do linear arithmetic, cache the result" implementation approach — simple and works.
- `CORS_ORIGINS`/`CORS_ENABLED` as plain env-driven settings — directly satisfies Tamber's "CORS must be configurable" requirement with no redesign needed.
- SHA-256-verified, idempotent, temp-file-then-atomic-rename model download at container start/build — solid pattern for Tamber's own model-fetch step regardless of exactly which Kokoro checkpoint/release URL it pins to.
- Baking voices into the image rather than fetching them at runtime (they're small, static, and versioned with the code) — no reason to add network dependency there.
- Structured error envelopes (`{"error": "...", "message": "...", "type": "..."}`) with the right HTTP status per failure class (400 validation, 403 feature-disabled, 500 processing) — easy to copy and keeps OpenAI-client compatibility if Tamber ever wants that door open.
- The `unrecognized_env_file_keys()` warn-don't-crash pattern for `.env` typos.

**Change (right idea, wrong execution for Tamber's constraints):**
- **Streaming encoder**: reuse `StreamingAudioWriter`'s PyAV-based approach, but instantiate a fresh container **per chunk** (finalize/flush each one) instead of once per request, so every NDJSON line is an independently decodable file — this is the single most important code-level change relative to upstream, driven directly by the iOS `decodeAudioData` requirement.
- **Timestamp granularity/shape for the client protocol**: upstream's `/dev/captioned_speech` already returns per-chunk NDJSON-ish lines with base64 audio + word timestamps — adopt that response shape, but decide deliberately on absolute-vs-chunk-relative timestamp semantics (upstream uses absolute-over-whole-response) and add the character-offset-into-source-text field Tamber's brief wants, since upstream never produces it.
- **Web UI's read-along**: replace sentence-level fuzzy anchor-alignment with true word-level sync driven directly by the real per-word timestamps Tamber's own chunks will already carry — strictly better data is already available server-side; there's no reason to keep any of the client-side fuzzy-matching heuristics (`alignChunks`, `sentenceIndexAt`) once real timestamps exist per chunk.
- **Static asset serving**: replace the no-build "serve raw file bytes with `Cache-Control: no-cache`" web router with a normal Vite build output (hashed filenames, long-cache-plus-immutable headers, gzip/brotli) — trivial win once `web/` is an actual Vite project instead of hand-written ES modules.
- **`/web/config`-style runtime capability discovery**: keep the idea (client learns server feature flags/base path at runtime) but fold it into whatever health/config endpoint Tamber already needs for its configurable-base-URL requirement, rather than adding a second bespoke endpoint.

**Drop (not worth porting):**
- **MediaSource/SourceBuffer entirely** — explicitly forbidden by Tamber's brief, and confirmed above to be exactly what's unavailable on iOS Safari; there is nothing in `MsePipeline.js` worth keeping except the general "bound how much decoded audio you hold in memory" idea, which Tamber gets almost for free anyway since each chunk's decoded `AudioBuffer` can simply be released after it plays.
- **The block-mode full-buffer fallback as a "streaming" solution** — it technically avoids MSE but reintroduces the exact wait-for-everything problem Tamber is trying to eliminate; don't treat it as an acceptable iOS fallback.
- **No-auth posture** — Tamber's brief requires an optional bearer API key; there's nothing to adapt from upstream here, it has to be added fresh (simple FastAPI dependency checking an `Authorization: Bearer` header against an env var, 401 on mismatch when the env var is set, pass-through when unset — same on/off-via-env-var pattern used everywhere else in this codebase's settings).
- **Debug endpoints' breadth** (`/debug/threads`, full psutil/GPUtil dumps) — overkill for Tamber v1; a minimal `/health`-plus-model-status is enough, and shouldn't be exposed without the same auth as everything else if it reveals host internals.
- **The Inno voice-tuning subsystem** (`/dev/tune`, reference-clip cloning-adjacent feature) and **SSML translation** — both are legitimate, well-built features, but out of scope for Tamber's stated four deliverables; revisit only if a future milestone explicitly asks for custom-voice-from-clip or SSML input. Don't invest here now.
- **Kubernetes Helm chart / DigitalOcean-specific deployment docs** — Tamber's stated target is a single Docker container behind a NetBird reverse proxy, not k8s; nothing here needs porting.
- **Per-thread/per-request `TTSService.create()` re-fetching global managers** on every dev-router dependency call (`development.py`'s `get_tts_service()` calls `TTSService.create()` fresh each time rather than reusing the module-level singleton `openai_compatible.py` uses) — a minor inconsistency in the reference implementation itself; Tamber's own service should settle on one singleton pattern for the model/voice managers and use it everywhere, not replicate this split.
