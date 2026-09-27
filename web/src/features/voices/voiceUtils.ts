import {
  displayNameOfVoiceId,
  findSavedBlend,
  isBlend,
  normalizedWeights,
  parseVoiceSpec,
  type Gender,
  type LangCode,
  type SavedBlend,
  type Voice,
} from '@tamber/client';

export interface VoiceFilter {
  query: string;
  lang: LangCode | 'all';
  gender: Gender | 'all';
}

export function voiceById(voices: readonly Voice[] | null, id: string): Voice | undefined {
  return voices?.find((v) => v.id === id);
}

export function filterVoices(voices: readonly Voice[], f: VoiceFilter): Voice[] {
  const q = f.query.trim().toLowerCase();
  return voices.filter((v) => {
    if (f.lang !== 'all' && v.lang_code !== f.lang) return false;
    if (f.gender !== 'all' && v.gender !== f.gender) return false;
    if (!q) return true;
    return (
      v.id.includes(q) ||
      v.name.toLowerCase().includes(q) ||
      v.language_name.toLowerCase().includes(q) ||
      v.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

export function voiceLanguages(voices: readonly Voice[]): { code: LangCode; name: string }[] {
  const seen = new Map<LangCode, string>();
  for (const v of voices) if (!seen.has(v.lang_code)) seen.set(v.lang_code, v.language_name);
  return [...seen].map(([code, name]) => ({ code, name }));
}

export interface VoiceDescription {
  title: string;
  subtitle: string;
  blend: boolean;
  /** Initials for the avatar. */
  initials: string;
  /** False when a single voice is known to have no word timings. */
  wordTimestamps: boolean;
}

/** "Heart 67% / Bella 33%" for a blend's components. */
export function blendMixLabel(spec: string, voices: readonly Voice[] | null): string {
  try {
    return normalizedWeights(parseVoiceSpec(spec, 16))
      .map(
        (p) =>
          `${voiceById(voices, p.id)?.name ?? displayNameOfVoiceId(p.id)} ${Math.round(p.weight * 100)}%`,
      )
      .join(' / ');
  } catch {
    return spec;
  }
}

/**
 * Friendly label for a voice id or a blend spec. A blend that matches one of `savedBlends` is
 * titled with its saved name.
 */
export function describeVoice(
  spec: string,
  voices: readonly Voice[] | null,
  savedBlends: readonly SavedBlend[] = [],
): VoiceDescription {
  try {
    const parts = parseVoiceSpec(spec, 16);
    if (isBlend(spec) && parts.length > 1) {
      const norm = normalizedWeights(parts);
      const names = parts.map((p) => voiceById(voices, p.id)?.name ?? displayNameOfVoiceId(p.id));
      const saved = findSavedBlend(savedBlends, spec);
      const shares = norm.map((p) => `${Math.round(p.weight * 100)}%`).join(' / ');
      return {
        title: saved?.name ?? names.join(' + '),
        subtitle: saved ? `Blend · ${names.join(' + ')} · ${shares}` : `Blend · ${shares}`,
        blend: true,
        initials: (saved
          ? saved.name.split(' ').slice(0, 2).map((w) => w[0] ?? '')
          : names.slice(0, 2).map((n) => n[0] ?? '')
        )
          .join('')
          .toUpperCase(),
        wordTimestamps: parts.every((p) => voiceById(voices, p.id)?.word_timestamps ?? true),
      };
    }
    const id = parts[0]?.id ?? spec;
    const v = voiceById(voices, id);
    const name = v?.name ?? displayNameOfVoiceId(id);
    const bits = [v?.language_name, v?.gender, v?.grade ? `grade ${v.grade}` : null].filter(Boolean);
    return {
      title: name,
      subtitle: bits.length ? bits.join(' · ') : id,
      blend: false,
      initials: name.slice(0, 1).toUpperCase(),
      wordTimestamps: v?.word_timestamps ?? true,
    };
  } catch {
    return { title: spec, subtitle: 'Custom voice', blend: false, initials: '?', wordTimestamps: true };
  }
}

/** Mantine Select data grouped by language. */
export function voiceSelectData(voices: readonly Voice[]) {
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const v of voices) {
    const items = groups.get(v.language_name) ?? [];
    items.push({ value: v.id, label: `${v.name} (${v.id})` });
    groups.set(v.language_name, items);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
