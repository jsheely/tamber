/**
 * App-update state for the installed PWA. When the app is added to the home screen there is no
 * address bar to reload from, so this store tracks whether a newer build is waiting and exposes
 * "check now" and "update now" for the banner and Settings.
 *
 * The service worker itself is wired in `pwa.ts` (production only: the virtual module does not
 * exist in tests), which calls `connectServiceWorker()`. Without a service worker, `check()` reports
 * 'unsupported' and `apply()` falls back to a plain reload.
 */
import { create } from 'zustand';

export type UpdateCheckResult = 'update' | 'none' | 'unsupported' | 'error';

export interface ServiceWorkerHandle {
  registration: ServiceWorkerRegistration;
  /** vite-plugin-pwa's updateSW(reloadPage): skip waiting and reload once the new worker controls. */
  update: (reloadPage?: boolean) => Promise<void>;
}

export interface AppUpdateState {
  /** A newer build is installed and waiting to take over. */
  needRefresh: boolean;
  /** The banner was dismissed for this waiting build (Settings still offers the update). */
  dismissed: boolean;
  checking: boolean;
  applying: boolean;
  /** Epoch ms of the last completed check, null before the first. */
  lastChecked: number | null;
  handle: ServiceWorkerHandle | null;
  /** How to reload the page (tests swap it; jsdom cannot navigate). */
  reload: () => void;
  connectServiceWorker: (handle: ServiceWorkerHandle) => void;
  /** Called by the registration's onNeedRefresh. */
  markNeedRefresh: () => void;
  dismiss: () => void;
  /** Ask the browser to look for a new service worker. Resolves when it knows the answer. */
  check: () => Promise<UpdateCheckResult>;
  /** Activate the waiting build and reload, or plain-reload when there is no service worker. */
  apply: () => Promise<void>;
}

/** Skip a check when the last one was this recent (foreground flips, repeated taps). */
export const MIN_CHECK_INTERVAL_MS = 30_000;
/** Give a freshly discovered worker this long to finish installing before answering. */
const INSTALL_WAIT_MS = 15_000;

function waitForInstalled(reg: ServiceWorkerRegistration): Promise<boolean> {
  const worker = reg.installing;
  if (reg.waiting) return Promise.resolve(true);
  if (!worker) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), INSTALL_WAIT_MS);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', onState);
      resolve(ok);
    };
    const onState = () => {
      if (worker.state === 'installed') finish(true);
      else if (worker.state === 'redundant') finish(false);
    };
    worker.addEventListener('statechange', onState);
    onState();
  });
}

export function reloadPage(): void {
  window.location.reload();
}

export const useAppUpdate = create<AppUpdateState>()((set, get) => ({
  needRefresh: false,
  dismissed: false,
  checking: false,
  applying: false,
  lastChecked: null,
  handle: null,
  reload: reloadPage,
  connectServiceWorker: (handle) => set({ handle }),
  markNeedRefresh: () => set({ needRefresh: true, dismissed: false }),
  dismiss: () => set({ dismissed: true }),
  check: async () => {
    const { handle, checking } = get();
    if (!handle) return 'unsupported';
    if (checking) return get().needRefresh ? 'update' : 'none';
    set({ checking: true });
    try {
      await handle.registration.update();
      const installed = await waitForInstalled(handle.registration);
      if (installed) set({ needRefresh: true, dismissed: false });
      return get().needRefresh ? 'update' : 'none';
    } catch {
      return 'error';
    } finally {
      set({ checking: false, lastChecked: Date.now() });
    }
  },
  apply: async () => {
    const { handle, applying, reload } = get();
    if (applying) return;
    set({ applying: true });
    if (!handle || !handle.registration.waiting) {
      reload();
      return;
    }
    try {
      await handle.update(true);
      // updateSW(true) reloads on controllerchange; if that never fires, reload anyway.
      setTimeout(reload, 4000);
    } catch {
      reload();
    }
  },
}));

/** A check when the app returns to the foreground, throttled by MIN_CHECK_INTERVAL_MS. */
export function checkIfStale(): void {
  const { lastChecked, handle } = useAppUpdate.getState();
  if (!handle) return;
  if (lastChecked !== null && Date.now() - lastChecked < MIN_CHECK_INTERVAL_MS) return;
  void useAppUpdate.getState().check();
}
