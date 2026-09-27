/**
 * Service worker registration (vite-plugin-pwa, `registerType: 'prompt'`). A new build is never
 * swapped in under a running page: the app shows an "Update" banner and Settings offers
 * "Check for updates", both driven by the `useAppUpdate` store. Imported from main.tsx only, so
 * tests (which do not run the PWA plugin) never touch the virtual module.
 */
import { registerSW } from 'virtual:pwa-register';
import { checkIfStale, useAppUpdate } from './lib/appUpdate';

/** Periodic check while the app stays open (installed PWAs can live for days). */
const PERIODIC_CHECK_MS = 60 * 60 * 1000;

export function setupAppUpdates(): void {
  if (!('serviceWorker' in navigator)) return;
  const store = useAppUpdate.getState();
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => useAppUpdate.getState().markNeedRefresh(),
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      store.connectServiceWorker({ registration, update });
      // The page loaded while a newer worker was already waiting (e.g. reopened from the dock).
      if (registration.waiting) useAppUpdate.getState().markNeedRefresh();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkIfStale();
      });
      window.addEventListener('focus', checkIfStale);
      setInterval(checkIfStale, PERIODIC_CHECK_MS);
    },
    onRegisterError: (err) => {
      console.warn('[tamber] service worker registration failed', err);
    },
  });
}
