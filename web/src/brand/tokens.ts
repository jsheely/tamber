/**
 * Tamber brand tokens (source: assets/brand/BRAND.md).
 * Framework-agnostic so both the Mantine theme and vite.config.ts can import them.
 */
export const brand = {
  /** Orb / gradient start; primary accent on dark UI. */
  violet: '#A855F7',
  /** Buttons, links and focus rings on light UI (5.7:1 on white). */
  deepViolet: '#7C3AED',
  /** Outer ripple / gradient end; secondary accent on dark UI. */
  cyan: '#22D3EE',
  /** Use instead of cyan for text on white (cyan on white is only 1.8:1). */
  teal: '#0E7490',
  /** Links and small accent text on dark UI. */
  lavender: '#C084FC',
  /** Single-colour fallback when a gradient is not possible. */
  midpoint: '#6594F2',
  /** App background on dark UI; PWA theme_color / background_color. */
  background: '#0F0D1C',
  tileStart: '#1A1631',
  tileEnd: '#07070D',
  /** The mark gradient. Never reverse it: violet at the orb, cyan at the outer ripple. */
  gradient: 'linear-gradient(62deg, #A855F7 0%, #22D3EE 100%)',
  tileGradient: 'linear-gradient(135deg, #1A1631 0%, #07070D 100%)',
} as const;

type Shades = readonly [string, string, string, string, string, string, string, string, string, string];

/**
 * 10-shade scales in Mantine's format (`createTheme({ colors: { tamber: violetShades } })`).
 * Index 4 = lavender #C084FC, 5 = violet #A855F7, 6 = deep violet #7C3AED.
 * Suggested: `primaryColor: 'tamber', primaryShade: 6` (both schemes). Mantine puts white labels on
 * the primary shade for filled components: white on #7C3AED is 5.7:1, but white on #A855F7 is only
 * 3.96:1 (fails WCAG AA), so don't use shade 5 as the dark-scheme primaryShade. Dark-scheme anchors
 * already use index 4 (#C084FC, 7.3:1 on #0F0D1C); use `brand.violet` for orb/gradient accents.
 */
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

/** Index 4 = cyan #22D3EE (dark UI), 7 = teal #0E7490 (text on white). */
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

/**
 * Mantine dark palette (index 7 is the dark-scheme body background) tinted to the brand
 * background, so `colors.dark` renders #0F0D1C as the page colour.
 */
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
