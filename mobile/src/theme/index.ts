/**
 * Tamber visual language for React Native. Every value derives from the shared brand tokens in
 * `@tamber/client/brand` (the same source the web and extension Mantine themes use), so the three
 * clients read as one product.
 */
import { brand, themeSpec } from '@tamber/client/brand';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, useColorScheme } from 'react-native';

import { useSettings } from '@/store/settings';

export type ColorScheme = 'light' | 'dark';

export interface Palette {
  scheme: ColorScheme;
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  primary: string;
  onPrimary: string;
  accent: string;
  link: string;
  danger: string;
  success: string;
  warning: string;
  wordBg: string;
  chunkBg: string;
  spokenOpacity: number;
  gradient: readonly [string, string];
  tileGradient: readonly [string, string];
  statusBar: 'light' | 'dark';
}

const dark: Palette = {
  scheme: 'dark',
  background: brand.background,
  surface: '#1A1631',
  surfaceAlt: '#2A2643',
  border: '#3A3656',
  text: '#F4F1FF',
  textDim: '#C9C6D9',
  textFaint: '#7E7A99',
  primary: '#7C3AED',
  onPrimary: '#FFFFFF',
  accent: brand.cyan,
  link: brand.lavender,
  danger: '#F87171',
  success: '#34D399',
  warning: '#FBBF24',
  wordBg: themeSpec.highlight.wordBgDark,
  chunkBg: themeSpec.highlight.chunkBgDark,
  spokenOpacity: themeSpec.highlight.spokenOpacity,
  gradient: [brand.violet, brand.cyan],
  tileGradient: [brand.tileStart, brand.tileEnd],
  statusBar: 'light',
};

const light: Palette = {
  scheme: 'light',
  background: '#FAF7FF',
  surface: '#FFFFFF',
  surfaceAlt: '#F3E8FF',
  border: '#E4DDF5',
  text: '#1A1631',
  textDim: '#4A4566',
  textFaint: '#7E7A99',
  primary: brand.deepViolet,
  onPrimary: '#FFFFFF',
  accent: brand.teal,
  link: brand.deepViolet,
  danger: '#DC2626',
  success: '#059669',
  warning: '#B45309',
  wordBg: themeSpec.highlight.wordBgLight,
  chunkBg: themeSpec.highlight.chunkBgLight,
  spokenOpacity: themeSpec.highlight.spokenOpacity,
  gradient: [brand.violet, brand.cyan],
  tileGradient: ['#F3E8FF', '#ECFEFF'],
  statusBar: 'dark',
};

export const palettes: Record<ColorScheme, Palette> = { dark, light };

export const radius = themeSpec.radius;
export const motion = themeSpec.motion;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** System font stack: SF Pro on iOS, Roboto on Android (Inter-like metrics, no font download). */
export const fonts = {
  regular: Platform.select({ ios: 'System', default: 'sans-serif' }),
  medium: Platform.select({ ios: 'System', default: 'sans-serif-medium' }),
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
} as const;

export const type = {
  display: { fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.6 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 17, fontWeight: '700' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  small: { fontSize: 13, fontWeight: '500' as const },
  tiny: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.4 },
  reader: { fontSize: 20, lineHeight: 32, fontWeight: '400' as const },
};

/**
 * Convert the CSS gradient angle (brand.gradientAngle, CSS convention: 0deg = to top, clockwise)
 * into expo-linear-gradient start/end points in the unit square.
 */
export function gradientPoints(angleDeg: number = brand.gradientAngle): {
  start: { x: number; y: number };
  end: { x: number; y: number };
} {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad) / 2;
  const dy = -Math.cos(rad) / 2;
  return { start: { x: 0.5 - dx, y: 0.5 - dy }, end: { x: 0.5 + dx, y: 0.5 + dy } };
}

export const brandGradient = {
  colors: brand.gradientStops.map((s) => s.color) as [string, string],
  locations: brand.gradientStops.map((s) => s.offset) as [number, number],
  ...gradientPoints(),
};

/** Resolve settings.theme against the OS scheme. */
export function resolveScheme(pref: 'auto' | 'light' | 'dark', os: string | null | undefined): ColorScheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return os === 'light' ? 'light' : 'dark';
}

export function useColorSchemePreference(): ColorScheme {
  const pref = useSettings((s) => s.settings.theme);
  const os = useColorScheme();
  return resolveScheme(pref, os);
}

export function usePalette(): Palette {
  const scheme = useColorSchemePreference();
  return palettes[scheme];
}

let systemReduceMotion = false;
let systemReduceMotionLoaded = false;
const reduceMotionListeners = new Set<(v: boolean) => void>();

function subscribeSystemReduceMotion(fn: (v: boolean) => void): () => void {
  reduceMotionListeners.add(fn);
  if (!systemReduceMotionLoaded) {
    systemReduceMotionLoaded = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        systemReduceMotion = !!v;
        reduceMotionListeners.forEach((l) => l(systemReduceMotion));
      })
      .catch(() => undefined);
    AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => {
      systemReduceMotion = !!v;
      reduceMotionListeners.forEach((l) => l(systemReduceMotion));
    });
  }
  return () => {
    reduceMotionListeners.delete(fn);
  };
}

/** The OS "reduce motion" accessibility setting (AccessibilityInfo), kept live. */
export function useSystemReduceMotion(): boolean {
  const [value, setValue] = useState(systemReduceMotion);
  useEffect(() => subscribeSystemReduceMotion(setValue), []);
  return value;
}

/** True when animations should be minimal: settings.motion, else the OS reduce-motion setting. */
export function useReduceMotion(): boolean {
  const pref = useSettings((s) => s.settings.motion);
  const system = useSystemReduceMotion();
  return pref === 'reduced' || (pref === 'system' && system);
}

/** Memoised StyleSheet factory keyed on the palette. */
export function useThemedStyles<T>(factory: (p: Palette) => T): T {
  const p = usePalette();
  return useMemo(() => factory(p), [factory, p]);
}

export { brand, themeSpec };
