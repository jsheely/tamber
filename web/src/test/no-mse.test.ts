import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * iOS Safari has no MSE, so the web app must never depend on it (docs/ARCHITECTURE.md 5.1).
 * This guard fails if any file under src/ mentions the MSE classes. This file is the only exception.
 */
const FORBIDDEN = ['MediaSource', 'SourceBuffer'];
// jsdom gives import.meta.url an http: URL, so locate this file through Vitest instead.
const SELF = resolve(expect.getState().testPath ?? '');
const SRC = resolve(dirname(SELF), '..');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((p) => join(dir, p))
    .filter((p) => statSync(p).isFile());
}

describe('no MediaSource Extensions', () => {
  const files = listFiles(SRC);

  it('scans the whole source tree', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.endsWith(`player${sep}ChunkedPlayer.ts`))).toBe(true);
    expect(files.some((f) => f.endsWith('.css'))).toBe(true);
  });

  it('no file under src/ contains "MediaSource" or "SourceBuffer"', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === SELF) continue;
      const content = readFileSync(file, 'utf8');
      for (const word of FORBIDDEN) {
        if (content.includes(word)) offenders.push(`${relative(SRC, file)}: ${word}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
