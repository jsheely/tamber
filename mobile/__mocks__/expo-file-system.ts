/**
 * In-memory expo-file-system (new File / Directory / Paths API) for Jest.
 * `__fs` exposes the backing store so tests can assert what was written.
 */
type Entry = { kind: 'file'; content: string; encoding: 'utf8' | 'base64' } | { kind: 'dir' };

export const __fs = new Map<string, Entry>();

function join(parts: (string | { uri: string })[]): string {
  const segs = parts.map((p) => (typeof p === 'string' ? p : p.uri));
  let uri = segs[0] ?? '';
  for (const s of segs.slice(1)) uri = `${uri.replace(/\/+$/, '')}/${s.replace(/^\/+/, '')}`;
  return uri;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export class Directory {
  readonly uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = join(parts);
  }
  get exists(): boolean {
    return __fs.get(this.uri)?.kind === 'dir';
  }
  create(): void {
    __fs.set(this.uri, { kind: 'dir' });
  }
  delete(): void {
    for (const key of [...__fs.keys()]) {
      if (key === this.uri || key.startsWith(`${this.uri}/`)) __fs.delete(key);
    }
  }
  list(): (File | Directory)[] {
    return [...__fs.entries()]
      .filter(([k]) => k.startsWith(`${this.uri}/`) && !k.slice(this.uri.length + 1).includes('/'))
      .map(([k, e]) => (e.kind === 'dir' ? new Directory(k) : new File(k)));
  }
}

export class File {
  readonly uri: string;
  constructor(...parts: (string | { uri: string })[]) {
    this.uri = join(parts);
  }
  get name(): string {
    return this.uri.split('/').pop() ?? '';
  }
  get exists(): boolean {
    return __fs.get(this.uri)?.kind === 'file';
  }
  create(): void {
    if (!this.exists) __fs.set(this.uri, { kind: 'file', content: '', encoding: 'utf8' });
  }
  write(content: string | Uint8Array, options?: { encoding?: 'utf8' | 'base64' }): void {
    if (typeof content === 'string') {
      __fs.set(this.uri, { kind: 'file', content, encoding: options?.encoding === 'base64' ? 'base64' : 'utf8' });
    } else {
      __fs.set(this.uri, { kind: 'file', content: toBase64(content), encoding: 'base64' });
    }
  }
  textSync(): string {
    const e = __fs.get(this.uri);
    if (!e || e.kind !== 'file') throw new Error(`ENOENT ${this.uri}`);
    return e.encoding === 'base64' ? Buffer.from(e.content, 'base64').toString('utf8') : e.content;
  }
  async text(): Promise<string> {
    return this.textSync();
  }
  base64Sync(): string {
    const e = __fs.get(this.uri);
    if (!e || e.kind !== 'file') throw new Error(`ENOENT ${this.uri}`);
    return e.encoding === 'base64' ? e.content : Buffer.from(e.content, 'utf8').toString('base64');
  }
  bytesSync(): Uint8Array {
    return new Uint8Array(Buffer.from(this.base64Sync(), 'base64'));
  }
  async bytes(): Promise<Uint8Array> {
    return this.bytesSync();
  }
  get size(): number {
    return this.exists ? this.bytesSync().length : 0;
  }
  delete(): void {
    __fs.delete(this.uri);
  }
}

export const Paths = {
  cache: new Directory('file:///cache'),
  document: new Directory('file:///document'),
};

export const EncodingType = { UTF8: 'utf8', Base64: 'base64' } as const;
