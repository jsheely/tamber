/**
 * Stroke icons drawn with react-native-svg (Tabler-style 24x24 outlines, matching the
 * @tabler/icons-react set the web and extension use). No icon font to load.
 */
import { memo } from 'react';
import Svg, { Path } from 'react-native-svg';

const STROKE: Record<string, string> = {
  skipNext: 'M4 5v14l12 -7z M20 5l0 14',
  skipPrev: 'M20 5v14l-12 -7z M4 5l0 14',
  settings:
    'M4 6h8 M16 6h4 M4 12h2 M10 12h10 M4 18h11 M19 18h1 M14 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M8 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M17 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
  clipboard:
    'M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2 M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z',
  link: 'M9 15l6 -6 M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464 M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463',
  file: 'M14 3v4a1 1 0 0 0 1 1h4 M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z M9 13h6 M9 17h4',
  back: 'M15 6l-6 6l6 6',
  chevronRight: 'M9 6l6 6l-6 6',
  close: 'M18 6l-12 12 M6 6l12 12',
  search: 'M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 M21 21l-6 -6',
  star: 'M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z',
  trash:
    'M4 7l16 0 M10 11l0 6 M14 11l0 6 M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12 M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3',
  history: 'M12 8l0 4l2 2 M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5',
  wave: 'M3 12v0 M7 9v6 M11 5v14 M15 8v8 M19 10v4 M21 12v0',
  plus: 'M12 5l0 14 M5 12l14 0',
  minus: 'M5 12l14 0',
  check: 'M5 12l5 5l10 -10',
  alert:
    'M12 9v4 M12 16v.01 M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z',
  plug: 'M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054z M4 20l3.5 -3.5 M15 4l-3.5 3.5 M20 9l-3.5 3.5',
  headphones:
    'M4 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2z M15 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2z M4 15v-3a8 8 0 0 1 16 0v3',
  volume:
    'M15 8a5 5 0 0 1 0 8 M17.7 5a9 9 0 0 1 0 14 M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5',
  blend:
    'M7 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M7 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M17 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M7 8l0 8 M7 8a4 4 0 0 0 4 4h4',
  type: 'M4 7v-2h16v2 M9 20h6 M12 5v15',
  share: 'M8 9h-1a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-8a2 2 0 0 0 -2 -2h-1 M12 14v-11 M9 6l3 -3l3 3',
  key: 'M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z M15 9h.01',
  server:
    'M3 4m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z M3 12m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v2a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z M7 8l0 .01 M7 16l0 .01',
};

const FILLED: Record<string, string> = {
  play: 'M7 4v16l13 -8z',
  pause: 'M6 5a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z M14 5a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z',
  stop: 'M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z',
  starFilled:
    'M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z',
};

export type IconName = keyof typeof STROKE | keyof typeof FILLED;

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}

export const Icon = memo(function Icon({ name, size = 22, color, strokeWidth = 2 }: IconProps) {
  const filled = FILLED[name];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {filled ? (
        <Path d={filled} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
      ) : (
        <Path
          d={STROKE[name] ?? ''}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </Svg>
  );
});

/** The Tamber mark (assets/brand/glyph.svg, 64x64), filled with a colour or the brand gradient. */
export const GLYPH_PATH =
  'M4.2 32A14.1 14.1 0 1 1 18.4 46.1H7.6A3.4 3.4 0 0 1 4.2 42.8ZM36.8 10.8A28.1 28.1 0 0 1 36.8 53.2A4.4 4.4 0 0 1 31.1 46.6A19.4 19.4 0 0 0 31.1 17.4A4.4 4.4 0 0 1 36.8 10.8ZM48.2 3.2A41.4 41.4 0 0 1 48.2 60.8A4 4 0 0 1 42.3 55.2A33.3 33.3 0 0 0 42.3 8.8A4 4 0 0 1 48.2 3.2Z';
