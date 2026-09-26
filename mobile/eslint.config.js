// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.export-check/*', '.expo/*', 'android/*', 'ios/*', 'coverage/*'],
  },
  {
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'MediaSource', message: 'Tamber never uses MSE (iOS has none). Use per-chunk files.' },
        { name: 'SourceBuffer', message: 'Tamber never uses MSE (iOS has none). Use per-chunk files.' },
      ],
    },
  },
]);
