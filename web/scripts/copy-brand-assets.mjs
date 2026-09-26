#!/usr/bin/env node
// Copies the Tamber brand icons from assets/brand (the source of truth, never edited here)
// into web/public so Vite serves them from the site root. Safe to re-run; run it before
// `vite build` (e.g. as a "prebuild"/"predev" npm script) so the public copies track the masters.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = resolve(webRoot, '..', 'assets', 'brand');
const publicDir = join(webRoot, 'public');

/** [source relative to assets/brand, destination relative to web/public] */
const COPIES = [
  ['favicon.ico', 'favicon.ico'],
  ['icon-small.svg', 'favicon.svg'], // small-size master: drawn for 16-32 px
  ['png/icon-180.png', 'apple-touch-icon.png'], // opaque, iOS applies its own rounding
  ['png/icon-192.png', 'icon-192.png'],
  ['png/icon-512.png', 'icon-512.png'],
  ['png/icon-maskable-512.png', 'icon-maskable-512.png'],
  ['glyph.svg', 'mask-icon.svg'], // Safari pinned tab
  ['glyph.svg', 'glyph.svg'], // in-app logo / CSS mask (see src/brand/brand.css)
  ['icon.svg', 'icon.svg'], // full-detail mark for >= 48 px in-app use
];

if (!existsSync(brandDir)) {
  console.error(`[copy-brand-assets] brand directory not found: ${brandDir}`);
  process.exit(1);
}

mkdirSync(publicDir, { recursive: true });
const missing = [];
for (const [src, dest] of COPIES) {
  const from = join(brandDir, src);
  if (!existsSync(from)) {
    missing.push(src);
    continue;
  }
  copyFileSync(from, join(publicDir, dest));
}

if (missing.length > 0) {
  console.error(`[copy-brand-assets] missing brand files: ${[...new Set(missing)].join(', ')}`);
  process.exit(1);
}
console.log(`[copy-brand-assets] copied ${COPIES.length} files into ${publicDir}`);
