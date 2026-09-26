// Jest setup. Reanimated 4 / worklets need their JS mocks (no native runtime under Jest).
// Other native modules: manual mocks in __mocks__/ (expo-audio, expo-file-system,
// expo-secure-store, react-native-mmkv) or jest-expo's automatic module mocks.
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
