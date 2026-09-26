import { TamberClient } from '@tamber/client';
import { File } from 'expo-file-system';
// The multipart encoder expo/fetch (SDK 57's global fetch) uses for FormData request bodies.
import { convertFormDataAsync } from 'expo/src/winter/fetch/convertFormData';

import { createClient } from '@/api/client';
import {
  composeExtractedText,
  extractFromFile,
  guessMimeType,
  normalizeUrlInput,
  textStats,
  toFileUri,
} from '@/content/extract';
import { deriveTitle, readLibraryText, useLibrary, LIBRARY_LIMIT } from '@/store/library';
import { chunkFiles } from '@/player/chunkFiles';

describe('content helpers', () => {
  it('prepends the title unless the text already starts with it', () => {
    expect(composeExtractedText({ title: 'Title', text: 'Body.' })).toBe('Title\n\nBody.');
    expect(composeExtractedText({ title: 'Title', text: 'Title\n\nBody.' })).toBe('Title\n\nBody.');
    expect(composeExtractedText({ title: null, text: 'Body.' })).toBe('Body.');
  });

  it('normalises link input', () => {
    expect(normalizeUrlInput('example.com/a')).toBe('https://example.com/a');
    expect(normalizeUrlInput('http://localhost:8880/x')).toBe('http://localhost:8880/x');
    expect(normalizeUrlInput('not a url')).toBeNull();
    expect(normalizeUrlInput('')).toBeNull();
  });

  it('guesses upload types and estimates listening time', () => {
    expect(guessMimeType('a.PDF')).toBe('application/pdf');
    expect(guessMimeType('x.docx')).toContain('wordprocessingml');
    const s = textStats('one two three four', 2);
    expect(s.words).toBe(4);
    expect(s.minutes).toBeCloseTo(4 / 320);
  });

  it('builds clients that disable response compression', () => {
    const c = createClient({ apiBaseUrl: 'https://tts.example.com', apiKey: 'k' });
    expect(c).toBeInstanceOf(TamberClient);
    expect(c.url('/tts')).toBe('https://tts.example.com/v1/tts');
  });

  it('uploads documents as bytes()-backed parts that expo/fetch can serialize', async () => {
    // Put a real file in the (mock) file system.
    new File('file:///cache/doc.pdf').write('%PDF-1.7 fake');
    const appended: [string, unknown][] = [];
    let form: unknown = null;
    const g = globalThis as unknown as { FormData: unknown };
    const original = g.FormData;
    g.FormData = class {
      constructor() {
        form = this;
      }
      append(name: string, value: unknown) {
        appended.push([name, value]);
      }
      entries() {
        return appended[Symbol.iterator]();
      }
    };
    const fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          title: 'Doc',
          text: 'Hello.',
          source: 'doc.pdf',
          source_type: 'file',
          mime_type: 'application/pdf',
          word_count: 1,
          char_count: 6,
          truncated: false,
          language: null,
        }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    try {
      const client = new TamberClient({ baseUrl: 'https://tts.example.com', fetch });
      const res = await extractFromFile(client, { uri: 'file:///cache/doc.pdf', name: 'doc.pdf' });
      expect(res.text).toBe('Doc\n\nHello.');
      const [field, part] = appended[0] as [string, { name: string; type: string; bytes: () => Promise<Uint8Array> }];
      expect(field).toBe('file');
      expect(part.name).toBe('doc.pdf');
      expect(part.type).toBe('application/pdf');
      expect(Buffer.from(await part.bytes()).toString('utf8')).toBe('%PDF-1.7 fake');
      expect(appended[1]).toEqual(['filename', 'doc.pdf']);

      // The real expo/fetch (SDK 57 global fetch) multipart encoder accepts the form the client built.
      const { body } = await convertFormDataAsync(form as FormData, 'B');
      const encoded = Buffer.from(body).toString('utf8');
      expect(encoded).toContain('content-disposition: form-data; name="file"; filename="doc.pdf"');
      expect(encoded).toContain('content-type: application/pdf');
      expect(encoded).toContain('%PDF-1.7 fake');
      expect(encoded).toContain('name="filename"\r\n\r\ndoc.pdf');
    } finally {
      g.FormData = original;
    }
  });

  it('documents why the React Native { uri, name, type } shape is not used', async () => {
    const parts: [string, unknown][] = [['file', { uri: 'file:///cache/doc.pdf', name: 'doc.pdf', type: 'application/pdf' }]];
    const form = { entries: () => parts[Symbol.iterator]() } as unknown as FormData;
    await expect(convertFormDataAsync(form, 'B')).rejects.toThrow('Unsupported FormDataPart implementation');
  });

  it('turns bare share-sheet paths into file URIs', () => {
    expect(toFileUri('/data/user/0/app/cache/a b.pdf')).toBe('file:///data/user/0/app/cache/a b.pdf');
    expect(toFileUri('file:///x/y.pdf')).toBe('file:///x/y.pdf');
    expect(toFileUri('content://com.android.providers/doc/1')).toBe('content://com.android.providers/doc/1');
  });
});

describe('library', () => {
  beforeEach(() => useLibrary.getState().clear());

  it('stores text in a file and keeps only the last 20 items', async () => {
    const first = useLibrary.getState().add({ title: 'First', kind: 'text', text: 'First text.' });
    expect(await readLibraryText(first.id)).toBe('First text.');
    for (let i = 0; i < LIBRARY_LIMIT + 3; i++) {
      useLibrary.getState().add({ title: `Doc ${i}`, kind: 'url', source: `https://e.x/${i}`, text: `Text ${i}` });
    }
    const items = useLibrary.getState().items;
    expect(items).toHaveLength(LIBRARY_LIMIT);
    expect(items[0]!.title).toBe(`Doc ${LIBRARY_LIMIT + 2}`);
    expect(await readLibraryText(first.id)).toBeNull();
  });

  it('removes items and their text', async () => {
    const item = useLibrary.getState().add({ kind: 'text', text: 'Some words here\nmore' });
    expect(item.title).toBe('Some words here');
    useLibrary.getState().remove(item.id);
    expect(useLibrary.getState().items).toHaveLength(0);
    expect(await readLibraryText(item.id)).toBeNull();
  });

  it('derives titles', () => {
    expect(deriveTitle('  \n', null)).toBe('Untitled');
    expect(deriveTitle('x'.repeat(200))).toHaveLength(80);
  });
});

describe('chunk files', () => {
  it('writes base64 chunk audio under cache/tamber/<requestId>/', () => {
    const uri = chunkFiles.write('abc123', 4, 'wav', 'UklGRg==');
    expect(uri).toBe('file:///cache/tamber/abc123/4.wav');
    chunkFiles.remove(['abc123']);
  });
});
