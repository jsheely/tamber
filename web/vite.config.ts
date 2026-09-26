import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// Explicit .ts extension: this file is typechecked with module "nodenext" (tsconfig.node.json).
import { pwaIncludeAssets, pwaManifest } from './src/brand/pwa.ts';

/** Where `pnpm dev:web` proxies /v1 (the Tamber API). Override with TAMBER_API_URL. */
const apiTarget = process.env.TAMBER_API_URL ?? 'http://localhost:8880';

export default defineConfig({
  base: '/',
  resolve: {
    // @tamber/client exports a "source" condition (packages/client/src/*.ts). Resolving it first
    // means the workspace package is bundled from TypeScript source and hot-reloads in dev.
    conditions: ['source', ...defaultClientConditions],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: pwaManifest,
      includeAssets: [...pwaIncludeAssets],
      workbox: {
        navigateFallback: '/index.html',
        // The API, its docs and schema are never app-shell navigations.
        navigateFallbackDenylist: [/^\/v1\//, /^\/docs/, /^\/openapi\.json/],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,webmanifest}'],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Never cache API traffic (streams, keys, extracted documents).
            urlPattern: ({ url }) => url.pathname.startsWith('/v1/'),
            handler: 'NetworkOnly',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // Cloudflare quick tunnels (`cloudflared tunnel --url http://localhost:5173`) get a random
  // *.trycloudflare.com hostname; a leading dot allows the domain and every subdomain.
  server: {
    port: 5173,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: ['es2022', 'safari16'],
    // Initial JS is ~220 kB gzip (React + Mantine + motion); drawers are lazy chunks.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Framework code changes rarely: separate chunks stay cached across app releases.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            {
              name: 'motion',
              test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
