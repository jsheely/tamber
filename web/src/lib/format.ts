/** About 15 characters per second at 1x (docs brief); divided by speed. */
export const ESTIMATE_CHARS_PER_SECOND = 15;

export function estimateSeconds(chars: number, speed: number): number {
  return chars / (ESTIMATE_CHARS_PER_SECOND * (speed > 0 ? speed : 1));
}

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** "about 3 min", "12 s", "1 h 5 min". */
export function formatDurationWords(seconds: number): string {
  const s = Math.round(Math.max(0, seconds));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** File-name safe slug of the first few words ("tamber-<slug>.wav"). */
export function slugify(text: string, maxLen = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug || 'audio';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 1.25 -> "1.25x" (with a multiplication sign). */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}×`;
}
