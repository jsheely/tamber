/**
 * Pure mapping from an expo-share-intent payload to what Tamber should read.
 *
 *   files[0]                       -> { kind: 'file' }  (uploaded to /v1/extract)
 *   webUrl, or text that is a URL  -> { kind: 'url' }   (/v1/extract; falls back to meta.title/text)
 *   other text                     -> { kind: 'text' }  (read as-is)
 *
 * expo-share-intent sets `webUrl` whenever the shared text *contains* a link, so a long passage
 * that merely quotes a URL would be misread as a page share. We only treat it as a URL share when
 * the text around the link is short (a page title / "check this out" line); otherwise the text is
 * read directly.
 */
import type { ShareIntent } from 'expo-share-intent';

export type ResolvedShare =
  | { kind: 'text'; text: string; title: string | null }
  | {
      kind: 'url';
      url: string;
      /** Page title from the share metadata (iOS WebPage activation) or the text around the link. */
      title: string | null;
      /** What to read if extraction fails: title + surrounding text, or null. */
      fallbackText: string | null;
    }
  | { kind: 'file'; uri: string; name: string; mimeType: string | null };

/** Payload subset we rely on (keeps the resolver testable without the native module). */
export type ShareIntentLike = Pick<ShareIntent, 'text' | 'webUrl' | 'files' | 'meta'>;

/** Longest surrounding text (UTF-16 units) that still counts as a "link share". */
export const URL_SHARE_CONTEXT_LIMIT = 280;

const URL_RE = /https?:\/\/[^\s<>"'`]+/i;

function stripTrailingPunctuation(url: string): string {
  return url.replace(/[)\].,;:!?'"»”’]+$/u, '');
}

/** The single URL `text` consists of (ignoring whitespace), or null. */
export function urlOnly(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t || /\s/.test(t)) return null;
  return /^https?:\/\/\S+$/i.test(t) ? stripTrailingPunctuation(t) : null;
}

function firstUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  return m ? stripTrailingPunctuation(m[0]) : null;
}

function fileNameFromPath(path: string): string {
  const clean = path.split('?')[0] ?? path;
  const last = clean.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last) || 'document';
  } catch {
    return last || 'document';
  }
}

export function resolveShareIntent(intent: ShareIntentLike | null | undefined): ResolvedShare | null {
  if (!intent) return null;

  const file = intent.files?.find((f) => !!f?.path);
  if (file) {
    return {
      kind: 'file',
      uri: file.path,
      name: file.fileName || fileNameFromPath(file.path),
      mimeType: file.mimeType || null,
    };
  }

  const text = (intent.text ?? '').trim();
  const metaTitle = (intent.meta?.title ?? '').trim() || null;
  const url =
    urlOnly(intent.webUrl) ?? urlOnly(text) ?? (intent.webUrl ? firstUrl(intent.webUrl) : null) ?? (text ? firstUrl(text) : null);

  if (url) {
    // Text around the link (e.g. "Great read: <url>" or "Title\n<url>").
    const context = text
      .replace(url, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isLinkShare = !text || urlOnly(text) !== null || context.length <= URL_SHARE_CONTEXT_LIMIT;
    if (isLinkShare) {
      const title = metaTitle ?? (context || null);
      const fallbackParts = [metaTitle, context].filter(
        (p, i, arr): p is string => !!p && arr.indexOf(p) === i,
      );
      return {
        kind: 'url',
        url,
        title,
        fallbackText: fallbackParts.length ? fallbackParts.join('\n\n') : null,
      };
    }
  }

  if (text) return { kind: 'text', text, title: metaTitle };
  return null;
}
