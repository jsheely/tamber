import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { MotionConfig } from 'motion/react';
import { useMemo, type ReactNode } from 'react';
import { motionConfigValue } from './lib/motion';
import { settingsColorSchemeManager } from './store/colorScheme';
import { useSettings } from './store/settings';
import { cssVariablesResolver, theme } from './theme';

export function Providers({ children }: { children: ReactNode }) {
  const manager = useMemo(() => settingsColorSchemeManager(), []);
  const motionPref = useSettings((s) => s.motion);
  return (
    <MantineProvider
      theme={theme}
      defaultColorScheme="auto"
      colorSchemeManager={manager}
      cssVariablesResolver={cssVariablesResolver}
    >
      <MotionConfig reducedMotion={motionConfigValue(motionPref)}>
        <Notifications position="top-center" limit={3} zIndex={400} containerWidth={420} />
        {children}
      </MotionConfig>
    </MantineProvider>
  );
}
