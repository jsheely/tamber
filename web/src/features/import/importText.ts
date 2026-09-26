import type { ExtractResponse } from '@tamber/client';
import type { ImportInfo } from '../../store/draft';

/** File types /v1/extract accepts (docs/API.md 8.5). */
export const IMPORT_ACCEPT: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/epub+zip': ['.epub'],
  'text/plain': ['.txt'],
  'text/html': ['.html', '.htm'],
  'text/markdown': ['.md', '.markdown'],
};

export const IMPORT_EXTENSIONS = '.pdf,.docx,.epub,.txt,.html,.htm,.md';

/**
 * Text to put in the composer: `title + "\n\n" + text`, the title only when present and not
 * already the first line of the text.
 */
export function composeImportedText(res: Pick<ExtractResponse, 'title' | 'text'>): string {
  const title = res.title?.trim();
  if (!title) return res.text;
  const firstLine = (res.text.split('\n')[0] ?? '').trim();
  if (firstLine.toLowerCase() === title.toLowerCase()) return res.text;
  return `${title}\n\n${res.text}`;
}

export function importInfoFrom(res: ExtractResponse): ImportInfo {
  return {
    title: res.title,
    source: res.source,
    sourceType: res.source_type,
    wordCount: res.word_count,
    truncated: res.truncated,
  };
}

/** Accept obvious bare hosts ("example.com/post") by adding https://. */
export function normalizeImportUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch {
    return null;
  }
}
