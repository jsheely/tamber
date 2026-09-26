/**
 * Mantine theme, identical to web/ (brand tokens come from @tamber/client/brand).
 */
import { createTheme, type MantineColorsTuple, type CSSVariablesResolver } from '@mantine/core';
import { cyanShades, darkShades, themeSpec, violetShades } from '@tamber/client/brand';
import type { MotionPreference, ThemePreference } from '@tamber/client';

const tuple = (shades: readonly string[]): MantineColorsTuple =>
  [...shades] as unknown as MantineColorsTuple;

export const theme = createTheme({
  primaryColor: 'tamber',
  primaryShade: { light: 6, dark: 6 },
  colors: {
    tamber: tuple(violetShades),
    tamberCyan: tuple(cyanShades),
    dark: tuple(darkShades),
  },
  fontFamily: themeSpec.fontFamily,
  fontFamilyMonospace: themeSpec.monoFamily,
  headings: { fontFamily: themeSpec.fontFamily, fontWeight: '700' },
  defaultRadius: 'lg',
  autoContrast: true,
  cursorType: 'pointer',
  defaultGradient: { from: 'tamber.5', to: 'tamberCyan.4', deg: 62 },
});

/** Highlight colours as CSS variables, per colour scheme (used by the Reader and mini-player). */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--tamber-gradient': 'linear-gradient(62deg, #A855F7 0%, #22D3EE 100%)',
    '--tamber-spoken-opacity': String(themeSpec.highlight.spokenOpacity),
  },
  light: {
    '--tamber-word-bg': themeSpec.highlight.wordBgLight,
    '--tamber-chunk-bg': themeSpec.highlight.chunkBgLight,
    '--tamber-accent-text': '#7C3AED',
    '--tamber-surface': '#FFFFFF',
  },
  dark: {
    '--tamber-word-bg': themeSpec.highlight.wordBgDark,
    '--tamber-chunk-bg': themeSpec.highlight.chunkBgDark,
    '--tamber-accent-text': '#C084FC',
    '--tamber-surface': '#1A1631',
  },
});

/** Mantine colour scheme for a theme preference ('auto' follows the OS). */
export function colorSchemeFor(pref: ThemePreference): 'light' | 'dark' | 'auto' {
  return pref;
}

/** Whether animations should be reduced for a motion preference. */
export function shouldReduceMotion(pref: MotionPreference, systemPrefersReduced: boolean): boolean {
  if (pref === 'full') return false;
  if (pref === 'reduced') return true;
  return systemPrefersReduced;
}

export const motionSpec = themeSpec.motion;
