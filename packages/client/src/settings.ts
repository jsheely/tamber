/**
 * The settings model shared by every Tamber client (web, extension, mobile). Each client persists
 * this object with its own storage adapter (web: localStorage via zustand persist; extension:
 * chrome.storage.sync + chrome.storage.local for secrets; mobile: MMKV via zustand persist +
 * expo-secure-store for secrets) under SETTINGS_STORAGE_KEY, and always runs persisted data through
 * migrateSettings() before use.
 */
import { isLangCode } from './languages.ts';
import type { AudioFormat, ChunkMode, LangCode } from './types.ts';
import { VOICE_ID_PATTERN, canonicalVoiceSpec, isBlend, parseVoiceSpec } from './voice-spec.ts';

export const SETTINGS_VERSION = 1 as const;
/** Storage key used by every client (localStorage key, chrome.storage key, MMKV key). */
export const SETTINGS_STORAGE_KEY = 'tamber.settings';
/** Settings that are secrets: never synced/exported; store them in the most private storage available. */
export const SECRET_SETTING_KEYS = ['apiKey'] as const;

/** A named voice blend the user built and kept (docs/ARCHITECTURE.md section 7). */
export interface SavedBlend {
  /** Display name, unique (case-insensitive) within the list, at most MAX_BLEND_NAME_CHARS. */
  name: string;
  /** Canonical blend spec (two or more voices), e.g. `af_heart(2)+af_bella(1)`. */
  spec: string;
}

export type ThemePreference = 'auto' | 'light' | 'dark';
export type MotionPreference = 'system' | 'full' | 'reduced';

export interface TamberSettings {
  /** Schema version of this object. */
  version: typeof SETTINGS_VERSION;
  /**
   * API origin (optionally with a path prefix), no trailing slash, without `/v1`, e.g.
   * `https://tts.example.com`. Empty string = same origin as the page (web UI served by the API).
   * Extension/mobile treat empty as "not configured yet" and show onboarding.
   */
  apiBaseUrl: string;
  /** Bearer token for TAMBER_API_KEY-protected servers. Empty = none. Secret. */
  apiKey: string;
  /** Voice id or blend spec. */
  voice: string;
  /** Playback/synthesis speed multiplier. UI range SPEED_MIN..SPEED_MAX. */
  speed: number;
  format: AudioFormat;
  /** Explicit language override, or null to derive it from the voice. */
  lang: LangCode | null;
  chunkMode: ChunkMode;
  /** Word-by-word karaoke highlighting on/off (sentence/chunk highlight stays on). */
  highlight: boolean;
  /** Keep the active word/sentence scrolled into view. */
  autoScroll: boolean;
  theme: ThemePreference;
  /** Animation intensity: follow the OS reduced-motion setting, or force full/reduced. */
  motion: MotionPreference;
  /** Output gain 0..1 (client-side). */
  volume: number;
  /** Pinned voice ids / blend specs, most recent first, max MAX_FAVORITE_VOICES. */
  favoriteVoices: string[];
  /** Named blends, most recently saved first, max MAX_SAVED_BLENDS. */
  savedBlends: SavedBlend[];
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.0;
export const SPEED_STEP = 0.05;
export const MAX_FAVORITE_VOICES = 24;
export const MAX_SAVED_BLENDS = 24;
export const MAX_BLEND_NAME_CHARS = 40;
export const DEFAULT_VOICE = 'af_heart';

export const DEFAULT_SETTINGS: Readonly<TamberSettings> = Object.freeze({
  version: SETTINGS_VERSION,
  apiBaseUrl: '',
  apiKey: '',
  voice: DEFAULT_VOICE,
  speed: 1.0,
  format: 'wav',
  lang: null,
  chunkMode: 'balanced',
  highlight: true,
  autoScroll: true,
  theme: 'auto',
  motion: 'system',
  volume: 1,
  favoriteVoices: Object.freeze([]) as unknown as string[],
  savedBlends: Object.freeze([]) as unknown as SavedBlend[],
} satisfies TamberSettings);

/** A fresh, mutable copy of the defaults. */
export function createDefaultSettings(): TamberSettings {
  return { ...DEFAULT_SETTINGS, favoriteVoices: [], savedBlends: [] };
}

/**
 * Normalise a user-entered API base URL: trim, add `https://` when no scheme is given (except for
 * localhost / IPs, which get `http://`), drop query/hash, drop trailing slashes and a trailing `/v1`.
 * Returns '' for empty input. Does not validate reachability.
 */
export function normalizeBaseUrl(input: string): string {
  let url = (input ?? '').trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const host = url.split(/[/:?#]/)[0] ?? '';
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i.test(
      host,
    );
    url = (local ? 'http://' : 'https://') + url;
  }
  url = url.replace(/[?#].*$/, '');
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/v1$/i, '');
  return url.replace(/\/+$/, '');
}

/** True if `url` (already normalised) is an absolute http(s) URL. */
export function isValidBaseUrl(url: string): boolean {
  return /^https?:\/\/[^/\s]+(\/[^\s]*)?$/i.test(url);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function roundToStep(n: number, step: number): number {
  return Math.round(n / step) * step;
}

function isValidVoice(v: unknown): v is string {
  if (typeof v !== 'string' || !v.trim()) return false;
  try {
    parseVoiceSpec(v);
    return true;
  } catch {
    return false;
  }
}

/** Trim, collapse whitespace and bound a blend name; '' when unusable. */
export function normalizeBlendName(name: unknown): string {
  return typeof name === 'string'
    ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_BLEND_NAME_CHARS)
    : '';
}

/** A valid SavedBlend (canonical spec, two or more voices, non-empty name) or null. */
function sanitizeSavedBlend(raw: unknown): SavedBlend | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = normalizeBlendName(r.name);
  if (!name || typeof r.spec !== 'string') return null;
  try {
    const spec = canonicalVoiceSpec(r.spec, 16);
    return isBlend(spec) ? { name, spec } : null;
  } catch {
    return null;
  }
}

/** Validate a list of saved blends: drop invalid entries and duplicate names, keep order, bound. */
export function sanitizeSavedBlends(raw: unknown): SavedBlend[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedBlend[] = [];
  const names = new Set<string>();
  for (const item of raw) {
    const b = sanitizeSavedBlend(item);
    if (!b || names.has(b.name.toLowerCase())) continue;
    names.add(b.name.toLowerCase());
    out.push(b);
    if (out.length >= MAX_SAVED_BLENDS) break;
  }
  return out;
}

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Coerce anything (persisted JSON from any older version, a partial object, garbage) into a valid,
 * current TamberSettings. Unknown keys are dropped, invalid values fall back to defaults, numbers
 * are clamped. Matches zustand persist's `migrate(persistedState, version)` signature.
 */
export function migrateSettings(persisted: unknown, fromVersion?: number): TamberSettings {
  const d = createDefaultSettings();
  if (typeof persisted !== 'object' || persisted === null) return d;
  const p = { ...(persisted as Record<string, unknown>) };
  const version = typeof fromVersion === 'number' ? fromVersion : Number(p.version ?? 0);

  // --- version upgrades (add a block per future version) -------------------------------------
  if (version < 1) {
    // Pre-release shapes: `baseUrl`/`apiUrl` -> apiBaseUrl, `theme: 'system'` -> 'auto',
    // `highlightWords` -> highlight.
    if (p.apiBaseUrl === undefined) p.apiBaseUrl = p.baseUrl ?? p.apiUrl;
    if (p.theme === 'system') p.theme = 'auto';
    if (p.highlight === undefined && typeof p.highlightWords === 'boolean')
      p.highlight = p.highlightWords;
  }

  // --- field validation --------------------------------------------------------------------------
  const out: TamberSettings = {
    version: SETTINGS_VERSION,
    apiBaseUrl: typeof p.apiBaseUrl === 'string' ? normalizeBaseUrl(p.apiBaseUrl) : d.apiBaseUrl,
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : d.apiKey,
    voice: isValidVoice(p.voice) ? p.voice.trim() : d.voice,
    speed:
      typeof p.speed === 'number' && Number.isFinite(p.speed)
        ? Number(clamp(roundToStep(p.speed, 0.01), SPEED_MIN, SPEED_MAX).toFixed(2))
        : d.speed,
    format: pick(p.format, ['wav', 'mp3'] as const, d.format),
    lang: isLangCode(p.lang) ? p.lang : null,
    chunkMode: pick(p.chunkMode, ['balanced', 'sentence'] as const, d.chunkMode),
    highlight: typeof p.highlight === 'boolean' ? p.highlight : d.highlight,
    autoScroll: typeof p.autoScroll === 'boolean' ? p.autoScroll : d.autoScroll,
    theme: pick(p.theme, ['auto', 'light', 'dark'] as const, d.theme),
    motion: pick(p.motion, ['system', 'full', 'reduced'] as const, d.motion),
    volume:
      typeof p.volume === 'number' && Number.isFinite(p.volume) ? clamp(p.volume, 0, 1) : d.volume,
    favoriteVoices: Array.isArray(p.favoriteVoices)
      ? [...new Set(p.favoriteVoices.filter(isValidVoice).map((v) => v.trim()))].slice(
          0,
          MAX_FAVORITE_VOICES,
        )
      : d.favoriteVoices,
    savedBlends: sanitizeSavedBlends(p.savedBlends),
  };
  return out;
}

/** Merge a partial update into current settings and re-validate (use in every setter). */
export function updateSettings(
  current: TamberSettings,
  patch: Partial<Omit<TamberSettings, 'version'>>,
): TamberSettings {
  return migrateSettings({ ...current, ...patch }, SETTINGS_VERSION);
}

/** Split settings into the syncable part and the secrets (for chrome.storage.sync vs local, etc.). */
export function splitSecrets(settings: TamberSettings): {
  shared: Omit<TamberSettings, 'apiKey'>;
  secrets: Pick<TamberSettings, 'apiKey'>;
} {
  const { apiKey, ...shared } = settings;
  return { shared, secrets: { apiKey } };
}

/** Toggle a voice in the favourites list (most recent first, bounded). */
export function toggleFavoriteVoice(list: readonly string[], voice: string): string[] {
  const v = voice.trim();
  if (list.includes(v)) return list.filter((x) => x !== v);
  return [v, ...list].slice(0, MAX_FAVORITE_VOICES);
}

/**
 * Add or replace a saved blend (most recent first, bounded). An entry with the same name
 * (case-insensitive) or the same spec is replaced, so re-saving never creates duplicates.
 * Throws VoiceSpecError for an invalid spec; returns a copy of the list unchanged for an empty
 * name or a single voice.
 */
export function saveBlend(
  list: readonly SavedBlend[],
  blend: { name: string; spec: string },
): SavedBlend[] {
  const name = normalizeBlendName(blend.name);
  const spec = canonicalVoiceSpec(blend.spec, 16);
  if (!name || !isBlend(spec)) return [...list];
  const lower = name.toLowerCase();
  const rest = list.filter((b) => b.name.toLowerCase() !== lower && b.spec !== spec);
  return [{ name, spec }, ...rest].slice(0, MAX_SAVED_BLENDS);
}

/** Remove the saved blend with this name (case-insensitive). */
export function removeSavedBlend(list: readonly SavedBlend[], name: string): SavedBlend[] {
  const lower = normalizeBlendName(name).toLowerCase();
  return list.filter((b) => b.name.toLowerCase() !== lower);
}

/** The saved blend whose spec matches `voice` (canonicalised), if any. */
export function findSavedBlend(
  list: readonly SavedBlend[],
  voice: string,
): SavedBlend | undefined {
  let spec: string;
  try {
    spec = canonicalVoiceSpec(voice, 16);
  } catch {
    return undefined;
  }
  return list.find((b) => b.spec === spec);
}

/** True for a plain single voice id (not a blend). */
export function isSingleVoiceId(voice: string): boolean {
  return VOICE_ID_PATTERN.test(voice.trim());
}
