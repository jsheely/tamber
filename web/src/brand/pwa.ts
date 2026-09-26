import { brand } from './tokens.ts'; // explicit extension: required by the Vite template's nodenext tsconfig.node.json and Vite's native config loader

/**
 * Structural subset of vite-plugin-pwa's `ManifestOptions`, declared locally so this file has no
 * dependencies. Deliberately mutable: an `as const` object makes `icons` a readonly tuple, which
 * vite-plugin-pwa's `icons: IconResource[]` rejects (TS2322) in `VitePWA({ manifest })`.
 */
export interface PwaManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: 'any' | 'maskable' | 'monochrome';
}

export interface PwaManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser';
  theme_color: string;
  background_color: string;
  icons: PwaManifestIcon[];
}

/**
 * Web app manifest fields for vite-plugin-pwa: `VitePWA({ manifest: pwaManifest, ... })`.
 * Icon files are copied into web/public by scripts/copy-brand-assets.mjs.
 * iOS ignores manifest icons; it uses the apple-touch-icon link in index.html (see head-tags.html).
 */
export const pwaManifest: PwaManifest = {
  name: 'Tamber',
  short_name: 'Tamber',
  description: 'Self-hosted text-to-speech with word-by-word highlighting.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: brand.background,
  background_color: brand.background,
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

/** Static files vite-plugin-pwa should precache alongside the build (`includeAssets`). */
export const pwaIncludeAssets = [
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'mask-icon.svg',
  'glyph.svg',
] as const;
