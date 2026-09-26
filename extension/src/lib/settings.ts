/**
 * Settings persistence for every extension context (popup, side panel, options, background).
 *
 * Layout (docs/ARCHITECTURE.md section 7):
 * - chrome.storage.sync  ['tamber.settings']  = splitSecrets(settings).shared   (syncs across Chromes)
 * - chrome.storage.local ['tamber.secrets']   = { apiKey }                      (never synced)
 * - chrome.storage.sync  ['tamber.extension'] = { showMiniPlayer, openSidePanelOnPlay }
 *
 * load() merges the parts and runs migrateSettings(); save(patch) runs updateSettings() and writes
 * the split parts back. chrome.storage.onChanged keeps every open context in sync (see useSettings).
 *
 * The offscreen document cannot use chrome.storage (only chrome.runtime is exposed there), so the
 * settings travel inside the `play` / `updateSettings` messages instead.
 */
import { browser } from 'wxt/browser';
import {
  createDefaultSettings,
  migrateSettings,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  splitSecrets,
  updateSettings,
  type TamberSettings,
} from '@tamber/client';

export const SYNC_SETTINGS_KEY = SETTINGS_STORAGE_KEY; // 'tamber.settings'
export const SECRETS_KEY = 'tamber.secrets';
export const EXTENSION_SETTINGS_KEY = 'tamber.extension';
/** chrome.storage.sync limit per item is 8192 bytes; we stay well below it. */
export const SYNC_ITEM_BUDGET_BYTES = 6 * 1024;

export interface ExtensionSettings {
  /** Inject the floating in-page mini-player into the tab being read. */
  showMiniPlayer: boolean;
  /** Open the side panel reader whenever reading starts from a page. */
  openSidePanelOnPlay: boolean;
}

export const DEFAULT_EXTENSION_SETTINGS: Readonly<ExtensionSettings> = Object.freeze({
  showMiniPlayer: true,
  openSidePanelOnPlay: false,
});

export function migrateExtensionSettings(raw: unknown): ExtensionSettings {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    showMiniPlayer:
      typeof p.showMiniPlayer === 'boolean'
        ? p.showMiniPlayer
        : DEFAULT_EXTENSION_SETTINGS.showMiniPlayer,
    openSidePanelOnPlay:
      typeof p.openSidePanelOnPlay === 'boolean'
        ? p.openSidePanelOnPlay
        : DEFAULT_EXTENSION_SETTINGS.openSidePanelOnPlay,
  };
}

/** Merge the synced part and the local secrets into one validated TamberSettings. */
export function mergeStoredSettings(shared: unknown, secrets: unknown): TamberSettings {
  const s =
    typeof shared === 'object' && shared !== null ? (shared as Record<string, unknown>) : {};
  const k =
    typeof secrets === 'object' && secrets !== null ? (secrets as Record<string, unknown>) : {};
  if (!Object.keys(s).length && !Object.keys(k).length) return createDefaultSettings();
  const version = typeof s.version === 'number' ? s.version : SETTINGS_VERSION;
  return migrateSettings({ ...s, apiKey: k.apiKey }, version);
}

/** Size of a value as chrome.storage.sync measures it (key + JSON). */
export function syncItemBytes(key: string, value: unknown): number {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

/** Keep the synced item under budget by trimming the only unbounded-ish field (favourites). */
export function fitSyncPayload(
  shared: Omit<TamberSettings, 'apiKey'>,
): Omit<TamberSettings, 'apiKey'> {
  let out = shared;
  while (
    syncItemBytes(SYNC_SETTINGS_KEY, out) > SYNC_ITEM_BUDGET_BYTES &&
    out.favoriteVoices.length > 0
  ) {
    out = { ...out, favoriteVoices: out.favoriteVoices.slice(0, -1) };
  }
  return out;
}

export async function loadSettings(): Promise<TamberSettings> {
  const [sync, local] = await Promise.all([
    browser.storage.sync.get(SYNC_SETTINGS_KEY),
    browser.storage.local.get(SECRETS_KEY),
  ]);
  return mergeStoredSettings(sync[SYNC_SETTINGS_KEY], local[SECRETS_KEY]);
}

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const sync = await browser.storage.sync.get(EXTENSION_SETTINGS_KEY);
  return migrateExtensionSettings(sync[EXTENSION_SETTINGS_KEY]);
}

async function writeSettings(next: TamberSettings): Promise<void> {
  const { shared, secrets } = splitSecrets(next);
  await Promise.all([
    browser.storage.sync.set({ [SYNC_SETTINGS_KEY]: fitSyncPayload(shared) }),
    browser.storage.local.set({ [SECRETS_KEY]: secrets }),
  ]);
}

/** Writes are serialized so rapid changes (sliders, toggles) never lose an update. */
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(job, job);
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Apply a partial update (validated through updateSettings) and persist it. Returns the result. */
export function saveSettings(
  patch: Partial<Omit<TamberSettings, 'version'>>,
): Promise<TamberSettings> {
  return enqueue(async () => {
    const next = updateSettings(await loadSettings(), patch);
    await writeSettings(next);
    return next;
  });
}

export function saveExtensionSettings(
  patch: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  return enqueue(async () => {
    const next = migrateExtensionSettings({ ...(await loadExtensionSettings()), ...patch });
    await browser.storage.sync.set({ [EXTENSION_SETTINGS_KEY]: next });
    return next;
  });
}

/** Restore every default (the API URL and key included). */
export async function resetSettings(): Promise<void> {
  await Promise.all([
    browser.storage.sync.remove([SYNC_SETTINGS_KEY, EXTENSION_SETTINGS_KEY]),
    browser.storage.local.remove(SECRETS_KEY),
  ]);
}

export interface SettingsChange {
  settings?: true;
  extension?: true;
}

/**
 * Subscribe to settings changes made in any context. The listener receives which parts changed and
 * should re-load them. Returns an unsubscribe function.
 */
export function onSettingsChanged(listener: (change: SettingsChange) => void): () => void {
  const handler = (changes: Record<string, unknown>, areaName: string) => {
    const change: SettingsChange = {};
    if (areaName === 'sync' && SYNC_SETTINGS_KEY in changes) change.settings = true;
    if (areaName === 'local' && SECRETS_KEY in changes) change.settings = true;
    if (areaName === 'sync' && EXTENSION_SETTINGS_KEY in changes) change.extension = true;
    if (change.settings || change.extension) listener(change);
  };
  browser.storage.onChanged.addListener(handler);
  return () => browser.storage.onChanged.removeListener(handler);
}
