import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { MIN_CHECK_INTERVAL_MS, checkIfStale, useAppUpdate } from '../lib/appUpdate';
import { Providers } from '../Providers';
import { useSession } from '../store/session';
import { useSettings } from '../store/settings';

interface FakeWorker {
  state: ServiceWorkerState;
  listeners: Set<() => void>;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  setState: (state: ServiceWorkerState) => void;
}

function fakeWorker(state: ServiceWorkerState): FakeWorker {
  const w: FakeWorker = {
    state,
    listeners: new Set(),
    addEventListener: (_t, fn) => void w.listeners.add(fn),
    removeEventListener: (_t, fn) => void w.listeners.delete(fn),
    setState: (s) => {
      w.state = s;
      for (const fn of [...w.listeners]) fn();
    },
  };
  return w;
}

function fakeRegistration(opts: { installing?: FakeWorker; waiting?: FakeWorker; fail?: boolean } = {}) {
  const reg = {
    installing: (opts.installing ?? null) as unknown as ServiceWorker | null,
    waiting: (opts.waiting ?? null) as unknown as ServiceWorker | null,
    update: vi.fn(async () => {
      if (opts.fail) throw new TypeError('offline');
      return reg as unknown as ServiceWorkerRegistration;
    }),
  };
  return reg;
}

function resetStore() {
  useAppUpdate.setState({
    needRefresh: false,
    dismissed: false,
    checking: false,
    applying: false,
    lastChecked: null,
    handle: null,
    reload: vi.fn(),
  });
}

describe('useAppUpdate store', () => {
  beforeEach(resetStore);

  it('reports unsupported without a service worker and reloads on apply', async () => {
    expect(await useAppUpdate.getState().check()).toBe('unsupported');
    await useAppUpdate.getState().apply();
    expect(useAppUpdate.getState().reload).toHaveBeenCalledTimes(1);
  });

  it('finds a waiting worker and applies it through updateSW(true)', async () => {
    const reg = fakeRegistration({ waiting: fakeWorker('installed') });
    const update = vi.fn(async () => undefined);
    useAppUpdate.getState().connectServiceWorker({
      registration: reg as unknown as ServiceWorkerRegistration,
      update,
    });
    expect(await useAppUpdate.getState().check()).toBe('update');
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(useAppUpdate.getState().needRefresh).toBe(true);
    expect(useAppUpdate.getState().lastChecked).not.toBeNull();

    await useAppUpdate.getState().apply();
    expect(update).toHaveBeenCalledWith(true);
    expect(useAppUpdate.getState().applying).toBe(true);
  });

  it('waits for an installing worker to finish before answering', async () => {
    const installing = fakeWorker('installing');
    const reg = fakeRegistration({ installing });
    useAppUpdate.getState().connectServiceWorker({
      registration: reg as unknown as ServiceWorkerRegistration,
      update: async () => undefined,
    });
    const pending = useAppUpdate.getState().check();
    expect(useAppUpdate.getState().checking).toBe(true);
    installing.setState('installed');
    expect(await pending).toBe('update');
    expect(useAppUpdate.getState().checking).toBe(false);
  });

  it('answers none when nothing is new and error when the check fails', async () => {
    const ok = fakeRegistration();
    useAppUpdate.getState().connectServiceWorker({
      registration: ok as unknown as ServiceWorkerRegistration,
      update: async () => undefined,
    });
    expect(await useAppUpdate.getState().check()).toBe('none');
    const failing = fakeRegistration({ fail: true });
    useAppUpdate.getState().connectServiceWorker({
      registration: failing as unknown as ServiceWorkerRegistration,
      update: async () => undefined,
    });
    expect(await useAppUpdate.getState().check()).toBe('error');
  });

  it('checkIfStale throttles foreground checks', async () => {
    const reg = fakeRegistration();
    useAppUpdate.getState().connectServiceWorker({
      registration: reg as unknown as ServiceWorkerRegistration,
      update: async () => undefined,
    });
    checkIfStale();
    await waitFor(() => expect(reg.update).toHaveBeenCalledTimes(1));
    checkIfStale(); // just checked: skipped
    expect(reg.update).toHaveBeenCalledTimes(1);
    useAppUpdate.setState({ lastChecked: Date.now() - MIN_CHECK_INTERVAL_MS - 1 });
    checkIfStale();
    await waitFor(() => expect(reg.update).toHaveBeenCalledTimes(2));
  });
});

describe('update UI', () => {
  beforeEach(() => {
    resetStore();
    useSettings.getState().reset();
    useSession.setState({ drawer: null, view: 'compose', connection: 'unknown', health: null, voices: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { code: 'not_found', message: 'no', type: 'x' } }, { status: 404 })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the banner when a build is waiting; Update applies it, the X dismisses it', async () => {
    const user = userEvent.setup();
    const update = vi.fn(async () => undefined);
    useAppUpdate.getState().connectServiceWorker({
      registration: fakeRegistration({ waiting: fakeWorker('installed') }) as unknown as ServiceWorkerRegistration,
      update,
    });
    render(
      <Providers>
        <App />
      </Providers>,
    );
    expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument();
    useAppUpdate.getState().markNeedRefresh();
    expect(await screen.findByTestId('update-banner')).toHaveTextContent('A new version of Tamber is ready');

    await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }));
    await waitFor(() => expect(screen.queryByTestId('update-banner')).not.toBeInTheDocument());

    // Settings still offers the update.
    await user.click(screen.getByTestId('open-settings'));
    expect(await screen.findByTestId('app-version')).toHaveTextContent('Tamber 0.0.0-test');
    await user.click(screen.getByTestId('app-update'));
    expect(update).toHaveBeenCalledWith(true);
  });

  it('"Check for updates" in Settings reports up to date', async () => {
    const user = userEvent.setup();
    const reg = fakeRegistration();
    useAppUpdate.getState().connectServiceWorker({
      registration: reg as unknown as ServiceWorkerRegistration,
      update: async () => undefined,
    });
    render(
      <Providers>
        <App />
      </Providers>,
    );
    await user.click(screen.getByTestId('open-settings'));
    await user.click(await screen.findByTestId('app-check-updates'));
    expect(reg.update).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("You're up to date")).toBeInTheDocument();
  });
});
