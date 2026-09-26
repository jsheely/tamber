// Loaded first by eslint.config.js.
//
// typescript-eslint needs the classic TypeScript JS API. The repo root hoists TypeScript 7 (the
// native compiler, whose package exports no compiler API), and ts-api-utils (peer
// "typescript >=4.8.4", no upper bound) is hoisted next to it, so its require('typescript') would
// load TS 7 and crash. While linting, route every "typescript" request to this workspace's
// TypeScript 6 (web/node_modules/typescript) with Node's module.registerHooks (Node >= 22.15).
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('typescript/package.json');
const { version } = require(pkgPath);
if (!/^[4-6]\./.test(version)) {
  throw new Error(
    `[eslint] expected TypeScript 4-6 with the JS API for typescript-eslint, found ${version} at ${pkgPath}`,
  );
}
const ts6Url = pathToFileURL(require.resolve('typescript')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'typescript') return { url: ts6Url, format: 'commonjs', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
