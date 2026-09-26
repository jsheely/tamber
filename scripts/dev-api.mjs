#!/usr/bin/env node
// Run the Tamber API locally with uvicorn --reload, using api/.venv.
//
//   pnpm dev:api        real Kokoro engine (needs api/requirements-tts.txt installed)   [--real]
//   pnpm dev:api:fake   fake engine (no torch/model needed; tones + synthetic word timings)
//   pnpm dev            api + web dev server together (pnpm dev:fake for the fake engine)
//
// Environment variables (TAMBER_*) are passed through; TAMBER_ENGINE defaults to "fake" unless
// --real is given or it is already set. Port: TAMBER_PORT or 8880.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = join(root, 'api');
const candidates = [
  join(apiDir, '.venv', 'Scripts', 'python.exe'),
  join(apiDir, '.venv', 'bin', 'python'),
];
const python = candidates.find((p) => existsSync(p));
if (!python) {
  console.error(
    [
      'api/.venv not found. Create it first:',
      '  cd api',
      '  python -m venv .venv',
      '  .venv/Scripts/python -m pip install -r requirements-dev.txt   # Windows',
      '  .venv/bin/python -m pip install -r requirements-dev.txt       # macOS / Linux',
      '(add -r requirements-tts.txt for the real Kokoro engine)',
    ].join('\n'),
  );
  process.exit(1);
}

const real = process.argv.includes('--real');
const env = { ...process.env };
if (real) env.TAMBER_ENGINE = 'kokoro';
else env.TAMBER_ENGINE ??= 'fake';
// Local runs are online and serve the freshly built UI if present.
env.HF_HUB_OFFLINE ??= '0';
if (env.TAMBER_WEB_DIR === undefined && existsSync(join(root, 'web', 'dist', 'index.html'))) {
  env.TAMBER_WEB_DIR = join(root, 'web', 'dist');
}
const port = env.TAMBER_PORT ?? '8880';

console.log(`Tamber API (${env.TAMBER_ENGINE} engine) on http://localhost:${port}`);
const child = spawn(
  python,
  ['-m', 'uvicorn', 'tamber_api.main:app', '--reload', '--host', '0.0.0.0', '--port', port],
  { cwd: apiDir, env, stdio: 'inherit' },
);
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
