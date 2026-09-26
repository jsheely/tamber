/**
 * Voice spec grammar (identical on server and clients; see docs/API.md "Voices and blends"):
 *
 *   spec      := component ( "+" component )*          at most `max_blend_voices` (default 4)
 *   component := voice_id [ "(" weight ")" ]
 *   voice_id  := /^[a-z]{2}_[a-z0-9]+(?:_[a-z0-9]+)*$/   e.g. af_heart, bm_george
 *   weight    := decimal > 0 and <= 100, e.g. 2, 0.5, .25  (default 1)
 *
 * Whitespace around tokens is ignored. Repeated ids are merged by summing weights. The server mixes
 * the voices' style tensors as a weighted average with weights normalised to sum to 1, so
 * `af_bella(2)+af_sky(1)` is 2/3 Bella + 1/3 Sky. The blend's language is the first component's.
 */

export interface VoiceComponent {
  id: string;
  weight: number;
}

export const VOICE_ID_PATTERN = /^[a-z]{2}_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const COMPONENT_PATTERN = /^([a-z0-9_]+)\s*(?:\(\s*([0-9]*\.?[0-9]+)\s*\))?$/;

export const DEFAULT_MAX_BLEND_VOICES = 4;

export class VoiceSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceSpecError';
  }
}

/** Parse a voice spec. Throws VoiceSpecError with a user-presentable message on invalid input. */
export function parseVoiceSpec(
  spec: string,
  maxVoices: number = DEFAULT_MAX_BLEND_VOICES,
): VoiceComponent[] {
  const trimmed = spec.trim();
  if (!trimmed) throw new VoiceSpecError('Voice is empty');
  const parts = trimmed.split('+').map((p) => p.trim());
  const merged = new Map<string, number>();
  for (const part of parts) {
    if (!part) throw new VoiceSpecError(`Malformed voice spec "${spec}": empty component`);
    const m = COMPONENT_PATTERN.exec(part);
    if (!m) throw new VoiceSpecError(`Malformed voice component "${part}"`);
    const id = m[1]!;
    if (!VOICE_ID_PATTERN.test(id)) throw new VoiceSpecError(`Invalid voice id "${id}"`);
    const weight = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) {
      throw new VoiceSpecError(`Weight for "${id}" must be > 0 and <= 100`);
    }
    merged.set(id, (merged.get(id) ?? 0) + weight);
  }
  if (merged.size > maxVoices) {
    throw new VoiceSpecError(`A blend can use at most ${maxVoices} voices`);
  }
  return [...merged].map(([id, weight]) => ({ id, weight }));
}

function formatWeight(w: number): string {
  // Up to 3 decimals, no trailing zeros.
  return String(Math.round(w * 1000) / 1000);
}

/**
 * Canonical string for components: ids joined by "+", weight omitted when every weight is equal,
 * otherwise `(w)` on each component with w rounded to 3 decimals. This is what the server echoes
 * back as `voice` in the start event.
 */
export function formatVoiceSpec(components: readonly VoiceComponent[]): string {
  if (components.length === 0) throw new VoiceSpecError('No voices');
  const first = components[0]!.weight;
  const allEqual = components.every((c) => Math.abs(c.weight - first) < 1e-9);
  return components.map((c) => (allEqual ? c.id : `${c.id}(${formatWeight(c.weight)})`)).join('+');
}

/** Canonicalise a spec string (parse + format). Throws VoiceSpecError when invalid. */
export function canonicalVoiceSpec(spec: string, maxVoices?: number): string {
  return formatVoiceSpec(parseVoiceSpec(spec, maxVoices));
}

/** Weights normalised to sum to 1 (what the server actually mixes). */
export function normalizedWeights(components: readonly VoiceComponent[]): VoiceComponent[] {
  const total = components.reduce((s, c) => s + c.weight, 0);
  return components.map((c) => ({ id: c.id, weight: total > 0 ? c.weight / total : 0 }));
}

export function isBlend(spec: string): boolean {
  return spec.includes('+');
}
