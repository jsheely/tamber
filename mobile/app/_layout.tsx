/**
 * Root layout: gesture + safe-area providers, share-intent provider, theme, the hydration gate that
 * keeps the splash screen up until settings (MMKV) and the API key (secure-store) are loaded, the
 * share-intent routing effect, and the global toast host.
 */
import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { clearChunkCache } from '@/player/chunkFiles';
import { useShareIntentRouting } from '@/share/useShareIntentRouting';
import { settingsHydrated, useSettings } from '@/store/settings';
import { usePalette, useReduceMotion } from '@/theme';
import { ToastHost } from '@/ui/Toast';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: 250, fade: true });

// Chunk audio from a previous run is never reused.
clearChunkCache();

function useHydrationGate(): boolean {
  const [ready, setReady] = useState(settingsHydrated);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void (async () => {
      if (!useSettings.persist.hasHydrated()) {
        await new Promise<void>((resolve) => {
          const unsub = useSettings.persist.onFinishHydration(() => {
            unsub();
            resolve();
          });
          if (useSettings.persist.hasHydrated()) {
            unsub();
            resolve();
          }
        });
      }
      if (!useSettings.getState().secretsLoaded) await useSettings.getState().loadSecrets();
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [ready]);
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => undefined);
  }, [ready]);
  return ready;
}

function AppShell({ ready }: { ready: boolean }) {
  const p = usePalette();
  const reduce = useReduceMotion();
  useShareIntentRouting(ready);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(p.background).catch(() => undefined);
  }, [p.background]);

  if (!ready) return null;
  return (
    <>
      <StatusBar style={p.statusBar} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: p.background },
          animation: reduce ? 'none' : 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="player" options={{ animation: reduce ? 'none' : 'slide_from_bottom' }} />
        <Stack.Screen name="onboarding" options={{ gestureEnabled: false }} />
        <Stack.Screen name="voices" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="library" />
      </Stack>
      <ToastHost />
    </>
  );
}

export default function RootLayout() {
  const ready = useHydrationGate();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ShareIntentProvider options={{ resetOnBackground: true }}>
          <AppShell ready={ready} />
        </ShareIntentProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
