/**
 * iOS has no Media Source Extensions, so Tamber never uses them (docs/ARCHITECTURE.md §5.1).
 * Guard: no source file in app/ or src/ may mention the MSE classes.
 */
import * as fs from 'fs';
import * as path from 'path';

const FORBIDDEN = [['Media', 'Source'].join(''), ['Source', 'Buffer'].join('')];
const ROOT = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('no MSE', () => {
  const files = [...sourceFiles(path.join(ROOT, 'app')), ...sourceFiles(path.join(ROOT, 'src'))];

  it('scans the app sources', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(FORBIDDEN)('no source contains %s', (word) => {
    const offenders = files.filter((f) => fs.readFileSync(f, 'utf8').includes(word));
    expect(offenders).toEqual([]);
  });
});
