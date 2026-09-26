#!/usr/bin/env node
// Runs the TypeScript 7 native compiler (`typescript-native` = npm:typescript@^7) for `tsc -b`.
//
// Why a wrapper: typescript-eslint 8.x needs the classic TypeScript JS API (peer typescript
// ">=4.8.4 <6.1.0"), which TypeScript 7 no longer ships (its "." export is only version info).
// So this workspace's `typescript` devDependency is 6.0.x (used only by the ESLint parser) and
// TypeScript 7 is installed under the alias `typescript-native`. Both packages declare a `tsc`
// bin, so calling `tsc` from an npm script is ambiguous; this resolves TS 7 explicitly.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('typescript-native/package.json');
const pkg = require(pkgPath);
const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc;
if (!binRel) {
  console.error('[tsc] typescript-native has no tsc bin');
  process.exit(1);
}
if (!/^7\./.test(pkg.version)) {
  console.error(`[tsc] expected TypeScript 7.x under typescript-native, got ${pkg.version}`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [join(dirname(pkgPath), binRel), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
