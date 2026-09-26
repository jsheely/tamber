import { defaultClientConditions } from 'vite';
import { defineConfig } from 'wxt';

/**
 * Tamber Chrome extension (MV3). WXT generates manifest.json from this config plus the entrypoints
 * in src/entrypoints (background, popup, options, sidepanel, offscreen page, runtime content script).
 *
 * Permissions are deliberately minimal: no install-time host permissions and no static content
 * scripts. The API origin is requested at runtime from `optional_host_permissions`, and page access
 * comes from `activeTab` (granted by the context-menu click / keyboard shortcut / toolbar click).
 */
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  // Brand PNGs copied from assets/brand/png (never edited here).
  manifest: {
    name: 'Tamber',
    description: 'Read any text aloud with your self-hosted Tamber voice server.',
    version: '0.1.0',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
      },
      default_title: 'Tamber',
    },
    permissions: ['storage', 'contextMenus', 'scripting', 'offscreen', 'sidePanel', 'activeTab'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    commands: {
      'read-selection': {
        suggested_key: { default: 'Alt+Shift+R', mac: 'Alt+Shift+R' },
        description: 'Read selected text aloud',
      },
      'toggle-playback': {
        suggested_key: { default: 'Alt+Shift+P', mac: 'Alt+Shift+P' },
        description: 'Play / pause',
      },
      'stop-playback': {
        suggested_key: { default: 'Alt+Shift+S', mac: 'Alt+Shift+S' },
        description: 'Stop reading',
      },
    },
  },
  vite: () => ({
    // Extension pages load from disk, so one shared ~600 kB vendor chunk (React + Mantine) is fine.
    build: { chunkSizeWarningLimit: 1500 },
    // @tamber/client exports a "source" condition (packages/client/src/*.ts): the workspace package
    // is bundled from TypeScript source and hot-reloads under `wxt` dev.
    resolve: { conditions: ['source', ...defaultClientConditions] },
  }),
  // `pnpm zip` -> .output/tamber-<version>-chrome.zip (Chrome Web Store upload / sideload).
  zip: { artifactTemplate: 'tamber-{{version}}-{{browser}}.zip' },
  // Never open a browser automatically during `wxt dev` (load the unpacked build yourself).
  webExt: { disabled: true },
});
