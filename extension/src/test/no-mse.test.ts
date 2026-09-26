import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Built from pieces so this file does not match itself.
const FORBIDDEN = ['Media' + 'Source', 'Source' + 'Buffer'];
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('iOS-safe playback design', () => {
  it('no source file uses Media Source Extensions', () => {
    const files = walk(SRC).filter((f) => /\.(ts|tsx|js|mjs|html|css)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return FORBIDDEN.some((w) => text.includes(w));
    });
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });
});
