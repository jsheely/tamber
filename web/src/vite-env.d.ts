/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// moduleDetection "force" makes every file a module, so globals go through `declare global`.
declare global {
  /** From package.json, injected by vite.config.ts `define` (and vitest.config.ts). */
  const __APP_VERSION__: string;
  /** ISO timestamp of the build, injected by vite.config.ts `define`. */
  const __BUILD_TIME__: string;
}

export {};
