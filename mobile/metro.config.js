// Metro config for Tamber mobile.
//
// mobile/ is a pnpm workspace member. expo/metro-config detects the workspace root from
// pnpm-workspace.yaml and configures watchFolders / nodeModulesPaths for the monorepo itself.
//
// @tamber/client is linked from ../packages/client. Its package.json "exports" list a "source"
// condition first, pointing at src/*.ts. Putting "source" in Metro's condition names makes Metro
// bundle the TypeScript source directly (transpiled by babel-preset-expo like any other file), so
// edits in packages/client hot-reload here without a build step. The same condition is used by
// Vite (web, extension), vitest and tsc (customConditions).
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_conditionNames = [
  'source',
  ...(config.resolver.unstable_conditionNames ?? []),
];

module.exports = config;
