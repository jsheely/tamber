/**
 * Offscreen document lifecycle. Only one offscreen document may exist per profile, so creation is
 * guarded with hasDocument() (Chrome 150+) or runtime.getContexts() on older versions, and
 * concurrent callers share one in-flight createDocument() promise.
 */
import { browser } from 'wxt/browser';
import { isNoReceiverError, type OffscreenMessage } from './messages';

export const OFFSCREEN_PATH = '/offscreen.html';
export const OFFSCREEN_JUSTIFICATION = 'Play text-to-speech audio from your Tamber server';

let creating: Promise<void> | null = null;

export async function hasOffscreenDocument(): Promise<boolean> {
  const api = browser.offscreen as typeof browser.offscreen & {
    hasDocument?: () => Promise<boolean>;
  };
  if (typeof api.hasDocument === 'function') return api.hasDocument();
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

/** Create the offscreen document unless it exists. Resolves true if this call created it. */
export async function ensureOffscreen(): Promise<boolean> {
  if (creating) {
    await creating;
    return false;
  }
  if (await hasOffscreenDocument()) return false;
  if (creating) {
    await creating;
    return false;
  }
  creating = browser.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['AUDIO_PLAYBACK'],
    justification: OFFSCREEN_JUSTIFICATION,
  });
  try {
    await creating;
    return true;
  } catch (err) {
    // Another context won the race: that is fine, a document exists.
    if (/single offscreen document/i.test(String((err as Error)?.message ?? err))) return false;
    throw err;
  } finally {
    creating = null;
  }
}

export async function closeOffscreen(): Promise<void> {
  try {
    if (await hasOffscreenDocument()) await browser.offscreen.closeDocument();
  } catch {
    // Already closed (Chrome auto-closes idle AUDIO_PLAYBACK documents after ~30 s).
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send a command to the offscreen document. Retries briefly while a just-created document is still
 * registering its listeners. Resolves the response, or undefined when no document is listening.
 */
export async function sendToOffscreen<T = unknown>(
  message: OffscreenMessage,
  { retries = 5, delayMs = 60 }: { retries?: number; delayMs?: number } = {},
): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await browser.runtime.sendMessage(message)) as T;
    } catch (err) {
      if (!isNoReceiverError(err) || attempt >= retries) {
        if (isNoReceiverError(err)) return undefined;
        throw err;
      }
      await sleep(delayMs);
    }
  }
}
