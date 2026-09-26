import { createRequire } from 'node:module';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// --- TypeScript 6 for the ESLint parser --------------------------------------------------------
// typescript-eslint needs the classic TypeScript JS API (TS <= 6.0). This workspace pins
// `typescript` 6.0.x (nested in extension/node_modules) for that, while type checking uses TS 7
// (`typescript-native`, see scripts/tsc.mjs). `ts-api-utils` is hoisted to the repo root, where
// `typescript` is TS 7 (whose `require('typescript')` only exposes version info), so point that
// resolution at the same TS 6 module instance before typescript-eslint loads.
const require = createRequire(import.meta.url);
const ts6Path = require.resolve('typescript');
require(ts6Path);
try {
  const estreeRequire = createRequire(require.resolve('@typescript-eslint/typescript-estree'));
  const utilsRequire = createRequire(estreeRequire.resolve('ts-api-utils'));
  const seenByUtils = utilsRequire.resolve('typescript');
  if (seenByUtils !== ts6Path) require.cache[seenByUtils] = require.cache[ts6Path];
} catch {
  // Layout without a hoisted ts-api-utils: nothing to align.
}
const { default: tseslint } = await import('typescript-eslint');

export default tseslint.config(
  { ignores: ['.output', '.wxt', 'node_modules', 'coverage', 'stats.html'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      globals: { ...globals.browser, ...globals.webextensions },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-restricted-globals': [
        'error',
        { name: 'MediaSource', message: 'Tamber never uses MSE (iOS has no MediaSource).' },
        { name: 'ManagedMediaSource', message: 'Tamber never uses MSE.' },
      ],
    },
  },
  {
    files: ['src/test/**', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
);
