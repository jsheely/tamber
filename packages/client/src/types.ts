/**
 * Tamber HTTP contract types. This file is the TypeScript mirror of docs/API.md.
 * Field names are snake_case on the wire, exactly as the server sends them.
 *
 * Offsets (`char_start` / `char_end`) are UTF-16 code-unit indices into the exact `text` string the
 * client submitted, half-open `[start, end)`, so `text.slice(char_start, char_end)` is the span.
 * Word times (`start` / `end`) are seconds relative to the start of *their own chunk's* audio.
 */

/** Kokoro single-letter language codes. v1 servers enable `a` and `b` by default. */
export type LangCode = 'a' | 'b' | 'e' | 'f' | 'h' | 'i' | 'p' | 'j' | 'z';

/** Audio encodings available on `POST /v1/tts`. Every chunk is a complete, independently decodable file. */
export type AudioFormat = 'wav' | 'mp3';

/** Encodings available on the OpenAI-compatible `POST /v1/audio/speech`. */
export type OpenAIAudioFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

/**
 * How the server groups sentences into chunks (see docs/API.md "Chunking").
 * - `balanced`: first sentence alone (fast first audio), then whole sentences packed up to
 *   `chunk_target_chars` without crossing paragraphs.
 * - `sentence`: exactly one sentence (or sentence piece) per chunk.
 */
export type ChunkMode = 'balanced' | 'sentence';

export type Gender = 'female' | 'male';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type ErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'unknown_voice'
  | 'unsupported_language'
  | 'unsupported_format'
  | 'text_too_long'
  | 'empty_text'
  | 'file_too_large'
  | 'unsupported_media_type'
  | 'extract_failed'
  | 'fetch_failed'
  | 'url_not_allowed'
  | 'rate_limited'
  | 'server_busy'
  | 'model_loading'
  | 'not_found'
  | 'method_not_allowed'
  | 'synthesis_failed'
  | 'internal_error';

/** OpenAI-compatible error `type` values used by Tamber. */
export type ErrorType =
  'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'server_error';

/** Every non-2xx JSON response body (all routes, including the OpenAI-compatible ones). */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | (string & {});
    message: string;
    type: ErrorType | (string & {});
    /** Request field that caused the error, e.g. `"text"` or `"voice"`, else null. */
    param: string | null;
    request_id: string | null;
    /** Optional structured extra info (validation errors list, limits, etc.). */
    details?: unknown;
  };
}

// ---------------------------------------------------------------------------------------------
// GET /v1/health
// ---------------------------------------------------------------------------------------------

export interface LanguageInfo {
  code: LangCode;
  /** BCP-47 tag, e.g. `en-US`. */
  tag: string;
  /** English display name, e.g. `American English`. */
  name: string;
  /** Whether chunks in this language carry per-word timings (`words` non-empty). */
  word_timestamps: boolean;
}

export interface HealthLimits {
  /** Max length of `text` / `input` in UTF-16 code units. */
  max_text_chars: number;
  max_upload_bytes: number;
  /** Max characters of text returned by /v1/extract before truncation. */
  max_extract_chars: number;
  chunk_target_chars: number;
  chunk_max_chars: number;
  /** Requests per minute per client on POST routes; 0 = unlimited. */
  rate_limit_per_minute: number;
  speed_min: number;
  speed_max: number;
  max_blend_voices: number;
}

export interface HealthFeatures {
  extract_url: boolean;
  extract_file: boolean;
  extract_html: boolean;
  openai_compat: boolean;
  voice_blending: boolean;
  voice_preview: boolean;
}

export interface HealthResponse {
  /** `loading` while the model warms up (TTS routes answer 503 `model_loading` meanwhile). */
  status: 'ok' | 'loading' | 'degraded';
  /** Server version (semver). */
  version: string;
  /** Contract major version. This package speaks `1`. */
  api_version: number;
  /** `kokoro` in production, `fake` for the model-free dev/test engine. */
  engine: 'kokoro' | 'fake' | (string & {});
  model: string;
  device: string;
  model_loaded: boolean;
  /** True when TAMBER_API_KEY is set: every /v1 route except /v1/health needs a bearer token. */
  auth_required: boolean;
  sample_rate: number;
  formats: AudioFormat[];
  default_voice: string;
  default_format: AudioFormat;
  languages: LanguageInfo[];
  limits: HealthLimits;
  features: HealthFeatures;
}

// ---------------------------------------------------------------------------------------------
// GET /v1/voices
// ---------------------------------------------------------------------------------------------

export interface Voice {
  /** Kokoro voice id, e.g. `af_heart`. First letter = lang code, second = gender. */
  id: string;
  /** Display name, e.g. `Heart`. */
  name: string;
  /** BCP-47 tag, e.g. `en-US`. */
  language: string;
  /** Display name of the language, e.g. `American English`. */
  language_name: string;
  lang_code: LangCode;
  gender: Gender;
  /** Training-quality grade from Kokoro's VOICES.md (`A`, `B-`, `C+` ...), or null if ungraded. */
  grade: string | null;
  /** Whether synthesis with this voice yields word timings. */
  word_timestamps: boolean;
  /** Short sentence suitable for an audition button (synthesize it or use the preview route). */
  preview_text: string;
  /** Free-form labels, e.g. `["recommended"]`. */
  tags: string[];
}

export interface VoicesResponse {
  voices: Voice[];
  default_voice: string;
  languages: LanguageInfo[];
}

// ---------------------------------------------------------------------------------------------
// POST /v1/tts
// ---------------------------------------------------------------------------------------------

export interface TtsRequest {
  /** 1..limits.max_text_chars UTF-16 code units. Offsets in the response index into this exact string. */
  text: string;
  /** Voice id or blend spec (`af_bella+af_sky`, `af_bella(2)+af_sky(1)`). Default: server default voice. */
  voice?: string;
  /** 0.25..4.0, default 1.0. Higher = faster. */
  speed?: number;
  /** Default `wav` (recommended: deterministic decode on iOS Safari, sample-exact gapless joins). */
  format?: AudioFormat;
  /** Lang code or alias (`en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `pt-br`). Null/absent = from voice. */
  lang?: string | null;
  /** Default true: `application/x-ndjson` event stream. False: one `TtsResult` JSON body. */
  stream?: boolean;
  /** Default `balanced`. */
  chunk_mode?: ChunkMode;
  /**
   * Skip synthesis of chunks before this index (seek / resume). Chunk indices and offsets stay
   * relative to the full text. Must be < total_chunks. Default 0.
   */
  start_chunk?: number;
}

/** One chunk of the deterministic chunk plan. */
export interface ChunkSpan {
  index: number;
  char_start: number;
  char_end: number;
}

export interface WordTiming {
  /** Exactly `text.slice(char_start, char_end)` of the submitted text. */
  text: string;
  /** Seconds from the start of this chunk's audio. */
  start: number;
  end: number;
  char_start: number;
  char_end: number;
}

/** Always the first line of a stream. */
export interface TtsStartEvent {
  type: 'start';
  request_id: string;
  sample_rate: number;
  format: AudioFormat;
  /** Canonical voice spec actually used. */
  voice: string;
  lang: LangCode;
  speed: number;
  chunk_mode: ChunkMode;
  /** Number of chunks in the full plan (independent of start_chunk). */
  total_chunks: number;
  start_chunk: number;
  /** False when the language has no word timings: every chunk's `words` will be empty. */
  word_timestamps: boolean;
  /** Length of the submitted text in UTF-16 code units. */
  text_length: number;
  /** The complete chunk plan (all indices, including those before start_chunk). */
  chunks: ChunkSpan[];
}

/** Optional: emitted while waiting for a synthesis slot. `position` 1 = next in line. */
export interface TtsQueuedEvent {
  type: 'queued';
  position: number;
}

export interface TtsChunkEvent {
  type: 'chunk';
  index: number;
  /** Exactly `text.slice(char_start, char_end)`. */
  text: string;
  char_start: number;
  char_end: number;
  /** Base64 (standard alphabet, padded) of one complete audio file (WAV: RIFF PCM s16le mono). */
  audio: string;
  format: AudioFormat;
  sample_rate: number;
  /** Duration of this chunk's audio in seconds (WAV: exact; MP3: nominal). */
  duration: number;
  /** Timed words, in order. Empty when the language has no word timings. */
  words: WordTiming[];
  /**
   * Optional, only ever `true`: the model returned no tokens for this chunk (English), so the server
   * spread its words proportionally over the audio. Timings still satisfy every §7.2 invariant.
   */
  words_estimated?: boolean;
}

export interface TtsDoneEvent {
  type: 'done';
  /** Sum of `duration` over the chunks actually sent in this response. */
  total_duration: number;
  chunks_sent: number;
  chunks_failed: number;
  elapsed_ms: number;
}

export interface TtsErrorEvent {
  type: 'error';
  code: ErrorCode | (string & {});
  message: string;
  /** Chunk index the error refers to, or null for request-level errors. */
  index: number | null;
  /** True: the stream ends after this line (no `done`). False: that chunk was skipped, stream continues. */
  fatal: boolean;
}

/** Keep-alive; may be sent at any time. Ignore it. */
export interface TtsPingEvent {
  type: 'ping';
}

export type TtsEvent =
  TtsStartEvent | TtsQueuedEvent | TtsChunkEvent | TtsDoneEvent | TtsErrorEvent | TtsPingEvent;

/** Body of `POST /v1/tts` with `stream: false`. */
export interface TtsResult {
  request_id: string;
  sample_rate: number;
  format: AudioFormat;
  voice: string;
  lang: LangCode;
  speed: number;
  chunk_mode: ChunkMode;
  total_chunks: number;
  start_chunk: number;
  word_timestamps: boolean;
  text_length: number;
  plan: ChunkSpan[];
  chunks: TtsChunkEvent[];
  /** Non-fatal per-chunk errors (fatal errors produce an HTTP error response instead). */
  errors: TtsErrorEvent[];
  total_duration: number;
  elapsed_ms: number;
}

// ---------------------------------------------------------------------------------------------
// POST /v1/extract
// ---------------------------------------------------------------------------------------------

export interface ExtractUrlRequest {
  url: string;
}

export interface ExtractHtmlRequest {
  /** Raw HTML of a page the client already has (e.g. the extension reading the current tab). */
  html: string;
  /** Page URL, used for metadata and as `source`. */
  url?: string;
}

export type ExtractSourceType = 'url' | 'html' | 'file';

export interface ExtractResponse {
  title: string | null;
  /**
   * Plain text ready for /v1/tts: no markup, paragraphs separated by exactly "\n\n", single spaces
   * inside paragraphs, no leading/trailing whitespace.
   */
  text: string;
  /** The URL (url/html) or the uploaded file name (file). */
  source: string;
  source_type: ExtractSourceType;
  /** Detected/declared media type of the source, e.g. `text/html`, `application/pdf`. */
  mime_type: string | null;
  /** Whitespace-separated word count of `text`. */
  word_count: number;
  /** `text.length` in UTF-16 code units. */
  char_count: number;
  /** True when the text was cut at limits.max_extract_chars. */
  truncated: boolean;
  /** Detected language (BCP-47) if known, else null. */
  language: string | null;
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------------------------

export interface OpenAISpeechRequest {
  /** `kokoro`, `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` all map to the same model. */
  model?: string;
  input: string;
  /** Kokoro id / blend, or an OpenAI name (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse). */
  voice: string;
  /** Default `mp3` (as OpenAI). */
  response_format?: OpenAIAudioFormat;
  /** 0.25..4.0, default 1.0. */
  speed?: number;
  /** Accepted and ignored (Kokoro has no instruction following). */
  instructions?: string;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  object: 'list';
  data: ModelInfo[];
}
