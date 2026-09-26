import { lazy, Suspense, useState } from 'react';
import { useSession, type DrawerName } from '../store/session';

// Lazy: none of these are needed for first paint (keeps the initial bundle small).
const VoiceDrawer = lazy(() => import('./voices/VoiceDrawer'));
const SettingsDrawer = lazy(() => import('./settings/SettingsDrawer'));
const ImportDrawer = lazy(() => import('./import/ImportDrawer'));
const HistoryDrawer = lazy(() => import('./history/HistoryDrawer'));

/** Mounts each drawer the first time it is opened, then keeps it for its close transition. */
export function Drawers({ onRetryVoices }: { onRetryVoices: () => void }) {
  const drawer = useSession((s) => s.drawer);
  const [mounted, setMounted] = useState<ReadonlySet<DrawerName>>(() => new Set());
  if (drawer && !mounted.has(drawer)) {
    // Derived state: remember that this drawer has been opened (safe during render).
    setMounted(new Set([...mounted, drawer]));
  }
  const show = (name: DrawerName) => drawer === name || mounted.has(name);
  return (
    <Suspense fallback={null}>
      {show('voices') && <VoiceDrawer onRetryVoices={onRetryVoices} />}
      {show('settings') && <SettingsDrawer />}
      {show('import') && <ImportDrawer />}
      {show('history') && <HistoryDrawer />}
    </Suspense>
  );
}
