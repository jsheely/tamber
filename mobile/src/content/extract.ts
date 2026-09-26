/**
 * Turning inputs (URL, document, shared payload) into readable text through POST /v1/extract.
 */
import type { ExtractResponse, TamberClient } from '@tamber/client';
import { File } from 'expo-file-system';

export interface FileInput {
  uri: string;
  name: string;
  mimeType?: string | null;
}

export interface ReadableContent {
  title: string | null;
  text: string;
  source: string;
  truncated: boolean;
}

/**
 * Text to synthesise from an extract response: the title is read first (API.md §8.5 says clients
 * prepend `title + "\n\n"`), unless the extracted text already starts with it.
 */
export function composeExtractedText(extracted: Pick<ExtractResponse, 'title' | 'text'>): string {
  const title = (extracted.title ?? '').trim();
  const text = extracted.text;
  if (!title) return text;
  if (text.trimStart().startsWith(title)) return text;
  return `${title}\n\n${text}`;
}

function toReadable(res: ExtractResponse): ReadableContent {
  return {
    title: res.title,
    text: composeExtractedText(res),
    source: res.source,
    truncated: res.truncated,
  };
}

export async function extractFromUrl(
  client: TamberClient,
  url: string,
  signal?: AbortSignal,
): Promise<ReadableContent> {
  return toReadable(await client.extractUrl(url, { signal }));
}

/** A URI expo-file-system can open: share-sheet payloads may carry a bare absolute path. */
export function toFileUri(uriOrPath: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uriOrPath)) return uriOrPath;
  return `file://${uriOrPath.startsWith('/') ? '' : '/'}${uriOrPath}`;
}

/** The multipart `file` part for a local document (see uploadPart). */
export interface UploadPart {
  name: string;
  type: string;
  bytes: () => Promise<Uint8Array>;
}

/**
 * Build the multipart `file` part for a local document.
 *
 * SDK 57 installs expo/fetch as the global fetch. Its FormData serializer accepts strings, Blobs
 * and objects with a `bytes()` method, and throws "Unsupported FormDataPart implementation" for
 * React Native's `{ uri, name, type }` file shape. So the file is read with expo-file-system and
 * exposed through `bytes()`; `name` and `type` become the part's filename and Content-Type. The
 * reader is lazy: nothing is read until the request body is built.
 */
export function uploadPart(file: FileInput, type: string): UploadPart {
  const source = new File(toFileUri(file.uri));
  return { name: file.name, type, bytes: () => source.bytes() };
}

export async function extractFromFile(
  client: TamberClient,
  file: FileInput,
  signal?: AbortSignal,
): Promise<ReadableContent> {
  const type = file.mimeType || guessMimeType(file.name);
  const res = await client.extractFile(
    {
      file: uploadPart(file, type),
      filename: file.name,
      contentType: type,
    },
    { signal },
  );
  return toReadable(res);
}

const EXT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

export function guessMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TYPES[ext] ?? 'application/octet-stream';
}

/** Mime types offered by the document picker (what /v1/extract accepts). */
export const DOCUMENT_TYPES = [
  'application/pdf',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/*',
];

/** http(s) URL check for the "Open link" field (adds https:// when the scheme is missing). */
export function normalizeUrlInput(input: string): string | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  if (!/^https?:\/\/[^/\s.]+\.[^/\s]+/i.test(withScheme) && !/^https?:\/\/localhost/i.test(withScheme)) {
    return null;
  }
  return withScheme;
}

/** Words, characters and an estimate of listening time at `speed` (~160 wpm at 1.0x). */
export function textStats(text: string, speed = 1): { words: number; chars: number; minutes: number } {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const minutes = words / (160 * Math.max(0.25, speed));
  return { words, chars: text.length, minutes };
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0 s';
  const totalSeconds = Math.round(minutes * 60);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}
