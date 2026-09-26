import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // WxtVitest wires WXT's auto-imports/aliases and swaps `wxt/browser` for an in-memory fake browser.
  plugins: [WxtVitest()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
