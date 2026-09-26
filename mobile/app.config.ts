import type { ExpoConfig } from 'expo/config';

/**
 * Tamber mobile app config (Expo SDK 57, Continuous Native Generation).
 *
 * Brand assets: mobile/assets/* are copies of assets/brand/png/* exactly as the
 * "Where each file goes" table in assets/brand/BRAND.md prescribes:
 *   icon.png                <- png/icon-1024.png            (opaque, App Store safe)
 *   adaptive-icon.png       <- png/adaptive-foreground-1024.png
 *   adaptive-monochrome.png <- png/adaptive-monochrome-1024.png
 *   splash-icon.png         <- png/adaptive-foreground-1024.png
 *   favicon.png             <- png/icon-48.png
 * Never edit assets/brand/ from here; re-copy when the masters change.
 */

const BRAND_BACKGROUND = '#0F0D1C';
const IOS_APP_GROUP = 'group.net.thirtytech.tamber';

const config: ExpoConfig = {
  name: 'Tamber',
  slug: 'tamber',
  scheme: 'tamber',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  backgroundColor: BRAND_BACKGROUND,
  ios: {
    bundleIdentifier: 'net.thirtytech.tamber',
    supportsTablet: true,
    infoPlist: {
      // UIBackgroundModes: ['audio'] is injected by the expo-audio plugin (enableBackgroundPlayback).
      // Production servers are HTTPS; allow plain http only for LAN/localhost dev servers.
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
      },
      // iPad may rotate freely; iPhone stays portrait (orientation above).
      'UISupportedInterfaceOrientations~ipad': [
        'UIInterfaceOrientationPortrait',
        'UIInterfaceOrientationPortraitUpsideDown',
        'UIInterfaceOrientationLandscapeLeft',
        'UIInterfaceOrientationLandscapeRight',
      ],
    },
  },
  android: {
    package: 'net.thirtytech.tamber',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/adaptive-monochrome.png',
      backgroundColor: BRAND_BACKGROUND,
    },
    // FOREGROUND_SERVICE + FOREGROUND_SERVICE_MEDIA_PLAYBACK and the Media3 session service are
    // added by the expo-audio plugin.
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 288,
        backgroundColor: BRAND_BACKGROUND,
      },
    ],
    [
      'expo-audio',
      {
        enableBackgroundPlayback: true,
        enableBackgroundRecording: false,
        microphonePermission: false,
      },
    ],
    [
      'expo-share-intent',
      {
        iosActivationRules: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
          NSExtensionActivationSupportsWebPageWithMaxCount: 1,
          NSExtensionActivationSupportsFileWithMaxCount: 1,
        },
        androidIntentFilters: [
          'text/*',
          'application/pdf',
          'application/epub+zip',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/html',
          'text/markdown',
        ],
        iosAppGroupIdentifier: IOS_APP_GROUP,
      },
    ],
    'expo-secure-store',
    'expo-document-picker',
    'expo-dev-client',
    [
      'expo-build-properties',
      {
        // Plain http is allowed only so the app can talk to a LAN dev server (http://192.168.x.y:8880).
        // Production servers are HTTPS behind the NetBird proxy.
        android: { usesCleartextTraffic: true },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
