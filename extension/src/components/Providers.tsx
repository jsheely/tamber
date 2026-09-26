import '@fontsource-variable/inter';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '../styles/global.css';

import type { ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { MotionConfig } from 'motion/react';
import { SettingsContext, useSettings, useSettingsState } from '../hooks/useSettings';
import { cssVariablesResolver, theme } from '../lib/theme';

function Themed({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const forced = settings.theme === 'auto' ? undefined : settings.theme;
  const reducedMotion =
    settings.motion === 'full' ? 'never' : settings.motion === 'reduced' ? 'always' : 'user';
  return (
    <MantineProvider
      theme={theme}
      defaultColorScheme="auto"
      forceColorScheme={forced}
      cssVariablesResolver={cssVariablesResolver}
    >
      <MotionConfig reducedMotion={reducedMotion}>
        <Notifications position="top-center" limit={3} />
        {children}
      </MotionConfig>
    </MantineProvider>
  );
}

/** Loads settings once per page and keeps them in sync with every other context. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const api = useSettingsState();
  return <SettingsContext.Provider value={api}>{children}</SettingsContext.Provider>;
}

/** Settings + Mantine theme + motion preferences, shared by popup, side panel and options. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <SettingsProvider>
      <Themed>{children}</Themed>
    </SettingsProvider>
  );
}
