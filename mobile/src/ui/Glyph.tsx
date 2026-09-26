import { brand } from '@tamber/client/brand';
import { memo, useId } from 'react';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { gradientPoints } from '@/theme';

import { GLYPH_PATH } from './Icon';

/** The Tamber speech-orb mark. `color` omitted = the violet->cyan brand gradient. */
export const Glyph = memo(function Glyph({ size = 28, color }: { size?: number; color?: string }) {
  const id = `glyph${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const { start, end } = gradientPoints();
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" accessibilityLabel="Tamber">
      {!color && (
        <Defs>
          <LinearGradient id={id} x1={start.x} y1={start.y} x2={end.x} y2={end.y}>
            {brand.gradientStops.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </LinearGradient>
        </Defs>
      )}
      <Path d={GLYPH_PATH} fill={color ?? `url(#${id})`} />
    </Svg>
  );
});
