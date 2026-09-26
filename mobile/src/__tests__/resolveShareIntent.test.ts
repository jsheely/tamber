import { resolveShareIntent, urlOnly, type ShareIntentLike } from '@/share/resolveShareIntent';

const base: ShareIntentLike = { text: null, webUrl: null, files: null, meta: null };

describe('resolveShareIntent', () => {
  it('returns null for empty payloads', () => {
    expect(resolveShareIntent(null)).toBeNull();
    expect(resolveShareIntent(base)).toBeNull();
    expect(resolveShareIntent({ ...base, text: '   ' })).toBeNull();
    expect(resolveShareIntent({ ...base, files: [] })).toBeNull();
  });

  it('maps a shared file to a file extract (first file wins)', () => {
    const r = resolveShareIntent({
      ...base,
      files: [
        {
          path: 'file:///private/var/shared/Report%20Q3.pdf',
          mimeType: 'application/pdf',
          fileName: 'Report Q3.pdf',
          size: 1234,
          width: null,
          height: null,
          duration: null,
        },
        {
          path: 'file:///other.txt',
          mimeType: 'text/plain',
          fileName: 'other.txt',
          size: 1,
          width: null,
          height: null,
          duration: null,
        },
      ],
    });
    expect(r).toEqual({
      kind: 'file',
      uri: 'file:///private/var/shared/Report%20Q3.pdf',
      name: 'Report Q3.pdf',
      mimeType: 'application/pdf',
    });
  });

  it('derives a file name from the path when missing (Android content URIs)', () => {
    const r = resolveShareIntent({
      ...base,
      files: [
        {
          path: 'content://com.android.providers/document/My%20Book.epub',
          mimeType: '',
          fileName: '',
          size: null,
          width: null,
          height: null,
          duration: null,
        },
      ],
    });
    expect(r).toEqual({
      kind: 'file',
      uri: 'content://com.android.providers/document/My%20Book.epub',
      name: 'My Book.epub',
      mimeType: null,
    });
  });

  it('maps an iOS web page share (webUrl + meta.title) to a URL extract', () => {
    const r = resolveShareIntent({
      ...base,
      text: 'https://example.com/story',
      webUrl: 'https://example.com/story',
      meta: { title: 'A Great Story' },
    });
    expect(r).toEqual({
      kind: 'url',
      url: 'https://example.com/story',
      title: 'A Great Story',
      fallbackText: 'A Great Story',
    });
  });

  it('maps text that is only a URL to a URL extract', () => {
    const r = resolveShareIntent({ ...base, text: '  https://news.example.org/a?b=1  ' });
    expect(r).toMatchObject({ kind: 'url', url: 'https://news.example.org/a?b=1', title: null, fallbackText: null });
  });

  it('treats "title + link" (Android Chrome style) as a URL share with a fallback', () => {
    const r = resolveShareIntent({
      ...base,
      text: 'Why voices matter\nhttps://example.com/voices',
      webUrl: 'https://example.com/voices',
    });
    expect(r).toEqual({
      kind: 'url',
      url: 'https://example.com/voices',
      title: 'Why voices matter',
      fallbackText: 'Why voices matter',
    });
  });

  it('strips trailing punctuation from links in prose', () => {
    const r = resolveShareIntent({ ...base, text: 'Read this (https://example.com/x).' });
    expect(r).toMatchObject({ kind: 'url', url: 'https://example.com/x' });
  });

  it('reads long text that merely contains a link as text', () => {
    const prose = `${'This is a long passage about speech synthesis. '.repeat(10)}See https://example.com for more.`;
    const r = resolveShareIntent({ ...base, text: prose, webUrl: 'https://example.com' });
    expect(r).toEqual({ kind: 'text', text: prose.trim(), title: null });
  });

  it('reads plain shared text directly', () => {
    const r = resolveShareIntent({ ...base, text: 'Hello there. General Kenobi.', meta: { title: 'Quote' } });
    expect(r).toEqual({ kind: 'text', text: 'Hello there. General Kenobi.', title: 'Quote' });
  });

  it('urlOnly accepts only a lone http(s) URL', () => {
    expect(urlOnly('https://a.example/x')).toBe('https://a.example/x');
    expect(urlOnly('ftp://a.example/x')).toBeNull();
    expect(urlOnly('see https://a.example')).toBeNull();
    expect(urlOnly(null)).toBeNull();
  });
});
