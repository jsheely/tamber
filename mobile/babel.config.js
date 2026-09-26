module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated 4 / worklets: the plugin must be listed last.
    plugins: ['react-native-worklets/plugin'],
  };
};
