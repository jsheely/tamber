import { displayNameOfVoiceId, isBlend, parseVoiceSpec, type Voice } from '@tamber/client';
import type { PlayerState } from './messages';

/** m:ss (or h:mm:ss). */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function statusText(
  state: Pick<PlayerState, 'status' | 'queuePosition' | 'error' | 'ended' | 'text'>,
): string {
  switch (state.status) {
    case 'playing':
      return 'Reading';
    case 'paused':
      return 'Paused';
    case 'loading':
      return 'Preparing audio…';
    case 'queued':
      return state.queuePosition
        ? `Waiting for the server (#${state.queuePosition})`
        : 'Waiting for the server';
    case 'needs-gesture':
      return 'Click to start audio';
    case 'error':
      return state.error ?? 'Something went wrong';
    case 'idle':
      return state.ended ? 'Finished' : state.text ? 'Stopped' : 'Nothing playing';
  }
}

/** Human label for a voice id or blend spec. */
export function voiceLabel(spec: string, voices: readonly Voice[] = []): string {
  if (!spec) return '';
  if (isBlend(spec)) {
    try {
      return parseVoiceSpec(spec)
        .map((c) => voices.find((v) => v.id === c.id)?.name ?? displayNameOfVoiceId(c.id))
        .join(' + ');
    } catch {
      return spec;
    }
  }
  return voices.find((v) => v.id === spec)?.name ?? displayNameOfVoiceId(spec);
}

export interface VoiceGroup {
  group: string;
  items: { value: string; label: string }[];
}

/** Select data: favourites first, then voices grouped by language. */
export function voiceSelectData(
  voices: readonly Voice[],
  favorites: readonly string[],
  current: string,
): VoiceGroup[] {
  const groups: VoiceGroup[] = [];
  const seen = new Set<string>();
  if (favorites.length) {
    groups.push({
      group: 'Favourites',
      items: favorites.map((f) => {
        seen.add(f);
        return { value: f, label: `★ ${voiceLabel(f, voices)}` };
      }),
    });
  }
  const byLang = new Map<string, { value: string; label: string }[]>();
  for (const v of voices) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    const list = byLang.get(v.language_name) ?? [];
    list.push({ value: v.id, label: `${v.name}${v.grade ? ` (${v.grade})` : ''}` });
    byLang.set(v.language_name, list);
  }
  for (const [group, items] of byLang) groups.push({ group, items });
  if (current && !seen.has(current)) {
    groups.unshift({
      group: 'Current',
      items: [{ value: current, label: voiceLabel(current, voices) }],
    });
  }
  return groups;
}
