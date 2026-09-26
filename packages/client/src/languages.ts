import type { Gender, LangCode, LanguageInfo } from './types.ts';

/**
 * Kokoro language table. `word_timestamps` reflects what the Kokoro pipeline itself can produce:
 * native per-word timings exist for English only (misaki G2P). Servers report the authoritative
 * value per language in /v1/health and /v1/voices; this table is the static fallback.
 */
export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'a', tag: 'en-US', name: 'American English', word_timestamps: true },
  { code: 'b', tag: 'en-GB', name: 'British English', word_timestamps: true },
  { code: 'e', tag: 'es', name: 'Spanish', word_timestamps: false },
  { code: 'f', tag: 'fr-FR', name: 'French', word_timestamps: false },
  { code: 'h', tag: 'hi', name: 'Hindi', word_timestamps: false },
  { code: 'i', tag: 'it', name: 'Italian', word_timestamps: false },
  { code: 'p', tag: 'pt-BR', name: 'Brazilian Portuguese', word_timestamps: false },
  { code: 'j', tag: 'ja', name: 'Japanese', word_timestamps: false },
  { code: 'z', tag: 'zh', name: 'Mandarin Chinese', word_timestamps: false },
];

/** Aliases accepted by the server's `lang` field (case-insensitive), mapped to the letter code. */
export const LANG_ALIASES: Readonly<Record<string, LangCode>> = {
  a: 'a',
  'en-us': 'a',
  en: 'a',
  b: 'b',
  'en-gb': 'b',
  e: 'e',
  es: 'e',
  f: 'f',
  'fr-fr': 'f',
  fr: 'f',
  h: 'h',
  hi: 'h',
  i: 'i',
  it: 'i',
  p: 'p',
  'pt-br': 'p',
  pt: 'p',
  j: 'j',
  ja: 'j',
  z: 'z',
  zh: 'z',
};

export function isLangCode(value: unknown): value is LangCode {
  return typeof value === 'string' && value.length === 1 && 'abefhipjz'.includes(value);
}

/** Resolve a lang code or alias to a LangCode, or null if unknown. */
export function resolveLang(value: string | null | undefined): LangCode | null {
  if (!value) return null;
  return LANG_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function languageInfo(code: LangCode): LanguageInfo | undefined {
  return LANGUAGES.find((l) => l.code === code);
}

/** Language of a Kokoro voice id (first letter), e.g. `af_heart` -> `a`. Null if not a known code. */
export function langOfVoiceId(voiceId: string): LangCode | null {
  const c = voiceId.trim().charAt(0).toLowerCase();
  return isLangCode(c) ? c : null;
}

/** Gender of a Kokoro voice id (second letter), e.g. `am_adam` -> `male`. */
export function genderOfVoiceId(voiceId: string): Gender | null {
  const c = voiceId.trim().charAt(1).toLowerCase();
  return c === 'f' ? 'female' : c === 'm' ? 'male' : null;
}

/** Display name from a voice id: `af_heart` -> `Heart`, `bm_george` -> `George`. */
export function displayNameOfVoiceId(voiceId: string): string {
  const rest = voiceId.includes('_') ? voiceId.slice(voiceId.indexOf('_') + 1) : voiceId;
  return rest
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
