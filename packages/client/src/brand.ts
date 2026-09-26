/**
 * Tamber brand tokens, framework-free (mirrors assets/brand/BRAND.md and web/src/brand/tokens.ts).
 * Import from `@tamber/client/brand` in the extension (Mantine theme) and mobile (RN styles) so all
 * clients share one visual language. Values here must stay in sync with assets/brand/BRAND.md.
 */
export const brand = {
  /** Orb / gradient start; primary accent on dark UI. */
  violet: '#A855F7',
  /** Buttons, links and focus rings on light UI (5.7:1 on white; white text on it 5.7:1). */
  deepViolet: '#7C3AED',
  /** Outer ripple / gradient end; secondary accent on dark UI. */
  cyan: '#22D3EE',
  /** Use instead of cyan for text on white (cyan on white is only 1.8:1). */
  teal: '#0E7490',
  /** Links and small accent text on dark UI (7.3:1 on background). */
  lavender: '#C084FC',
  /** Single-colour fallback when a gradient is not possible. */
  midpoint: '#6594F2',
  /** Dark UI background; PWA theme/background colour; splash background. */
  background: '#0F0D1C',
  tileStart: '#1A1631',
  tileEnd: '#07070D',
  /** Mark gradient: violet at the orb, cyan at the outer ripple. Never reverse it. */
  gradient: 'linear-gradient(62deg, #A855F7 0%, #22D3EE 100%)',
  tileGradient: 'linear-gradient(135deg, #1A1631 0%, #07070D 100%)',
  /** Gradient stops for platforms without CSS gradients (RN / canvas / SVG). */
  gradientStops: [
    { offset: 0, color: '#A855F7' },
    { offset: 1, color: '#22D3EE' },
  ],
  /** Angle of the mark gradient in degrees (CSS convention). */
  gradientAngle: 62,
} as const;

export type Shades = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** Mantine-format 10-shade violet scale. 4 = lavender, 5 = violet, 6 = deep violet (primaryShade). */
export const violetShades: Shades = [
  '#FAF5FF',
  '#F3E8FF',
  '#E9D5FF',
  '#D8B4FE',
  '#C084FC',
  '#A855F7',
  '#7C3AED',
  '#6D28D9',
  '#5B21B6',
  '#4C1D95',
];

/** Mantine-format cyan scale. 4 = cyan (dark UI), 7 = teal (text on white). */
export const cyanShades: Shades = [
  '#ECFEFF',
  '#CFFAFE',
  '#A5F3FC',
  '#67E8F9',
  '#22D3EE',
  '#06B6D4',
  '#0891B2',
  '#0E7490',
  '#155E75',
  '#164E63',
];

/** Mantine `dark` palette tinted to the brand background (index 7 = #0F0D1C page colour). */
export const darkShades: Shades = [
  '#C9C6D9',
  '#A6A2BD',
  '#7E7A99',
  '#5A5675',
  '#3A3656',
  '#2A2643',
  '#1A1631',
  '#0F0D1C',
  '#0A0914',
  '#07070D',
];

/**
 * Shared theme decisions every client applies (Mantine: createTheme; RN: StyleSheet constants).
 * Keeping them here is what makes web, extension and mobile look like one product.
 */
export const themeSpec = {
  primaryColorName: 'tamber',
  /** Filled components use shade 6 (#7C3AED) in both schemes: white text passes WCAG AA. */
  primaryShade: 6,
  defaultRadius: 'lg',
  /** Radii in px for RN / custom CSS. */
  radius: { xs: 6, sm: 10, md: 14, lg: 18, xl: 28 },
  /** Bundled variable font (web/extension: @fontsource-variable/inter); RN uses the system font. */
  fontFamily: "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  monoFamily: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  /** Karaoke highlight colours. */
  highlight: {
    /** Active word pill background (dark scheme / light scheme). */
    wordBgDark: 'rgba(168, 85, 247, 0.32)',
    wordBgLight: 'rgba(124, 58, 237, 0.16)',
    /** Active sentence/chunk wash. */
    chunkBgDark: 'rgba(34, 211, 238, 0.08)',
    chunkBgLight: 'rgba(14, 116, 144, 0.07)',
    /** Already-spoken text opacity. */
    spokenOpacity: 0.55,
  },
  /** Motion durations (ms) and the standard easing. Respect reduced motion by dropping to 0. */
  motion: {
    fast: 120,
    base: 220,
    slow: 420,
    easing: [0.22, 1, 0.36, 1] as const,
    spring: { stiffness: 380, damping: 30, mass: 0.8 },
  },
} as const;
