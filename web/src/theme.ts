import { createTheme, type CSSVariablesResolver, type MantineColorsTuple } from '@mantine/core';
import { themeSpec } from '@tamber/client/brand';
import { cyanShades, darkShades, violetShades } from './brand/tokens';

/**
 * The Tamber Mantine theme (identical in web/ and extension/). Colours come from
 * src/brand/tokens.ts (= @tamber/client/brand); highlight colours and motion from themeSpec.
 */
export const theme = createTheme({
  primaryColor: 'tamber',
  primaryShade: { light: 6, dark: 6 },
  colors: {
    tamber: violetShades as unknown as MantineColorsTuple,
    tamberCyan: cyanShades as unknown as MantineColorsTuple,
    dark: darkShades as unknown as MantineColorsTuple,
  },
  fontFamily: themeSpec.fontFamily,
  fontFamilyMonospace: themeSpec.monoFamily,
  headings: { fontFamily: themeSpec.fontFamily, fontWeight: '700' },
  defaultRadius: 'lg',
  cursorType: 'pointer',
  autoContrast: true,
  defaultGradient: { from: 'tamber.5', to: 'tamberCyan.4', deg: 62 },
  components: {
    ActionIcon: { defaultProps: { variant: 'subtle' } },
    Tooltip: { defaultProps: { openDelay: 350, withArrow: true, events: { hover: true, focus: true, touch: false } } },
    Drawer: {
      defaultProps: {
        overlayProps: { backgroundOpacity: 0.45, blur: 6 },
        transitionProps: { duration: themeSpec.motion.base },
      },
    },
    Notification: { defaultProps: { radius: 'lg' } },
  },
});

/** Highlight + motion tokens as CSS variables (used by the reader and visuals). */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    '--tamber-spoken-opacity': String(themeSpec.highlight.spokenOpacity),
    '--tamber-motion-fast': `${themeSpec.motion.fast}ms`,
    '--tamber-motion-base': `${themeSpec.motion.base}ms`,
    '--tamber-motion-slow': `${themeSpec.motion.slow}ms`,
    '--tamber-ease': `cubic-bezier(${themeSpec.motion.easing.join(', ')})`,
  },
  light: {
    '--tamber-word-bg': themeSpec.highlight.wordBgLight,
    '--tamber-word-glow': 'rgba(124, 58, 237, 0.10)',
    '--tamber-chunk-bg': themeSpec.highlight.chunkBgLight,
    '--tamber-surface': 'rgba(255, 255, 255, 0.78)',
    '--tamber-surface-border': 'rgba(124, 58, 237, 0.14)',
    '--tamber-dock-bg': 'rgba(255, 255, 255, 0.82)',
    '--tamber-muted': '#5B5675',
    '--tamber-ambient-a': 'rgba(168, 85, 247, 0.10)',
    '--tamber-ambient-b': 'rgba(34, 211, 238, 0.10)',
    '--tamber-segment-planned': 'rgba(91, 86, 117, 0.16)',
    '--tamber-segment-received': 'rgba(124, 58, 237, 0.38)',
    '--tamber-segment-failed': 'rgba(224, 49, 49, 0.55)',
  },
  dark: {
    '--tamber-word-bg': themeSpec.highlight.wordBgDark,
    '--tamber-word-glow': 'rgba(168, 85, 247, 0.30)',
    '--tamber-chunk-bg': themeSpec.highlight.chunkBgDark,
    '--tamber-surface': 'rgba(26, 22, 49, 0.62)',
    '--tamber-surface-border': 'rgba(192, 132, 252, 0.14)',
    '--tamber-dock-bg': 'rgba(15, 13, 28, 0.82)',
    '--tamber-muted': '#A6A2BD',
    '--tamber-ambient-a': 'rgba(124, 58, 237, 0.22)',
    '--tamber-ambient-b': 'rgba(34, 211, 238, 0.12)',
    '--tamber-segment-planned': 'rgba(166, 162, 189, 0.16)',
    '--tamber-segment-received': 'rgba(192, 132, 252, 0.42)',
    '--tamber-segment-failed': 'rgba(250, 82, 82, 0.6)',
  },
});
