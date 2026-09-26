/**
 * Share-sheet intake. Mounted once in the root layout (the only place that reliably sees share
 * events with expo-router, docs/research/mobile-expo.md §3/§5).
 *
 * Cold start: expo-share-intent delivers the payload after the provider mounts; app/+native-intent
 * keeps expo-router from treating the share deep link as a route. Warm start: the provider updates
 * `shareIntent` when the app returns to the foreground. Either way this effect resolves the payload,
 * resets it (so it is handled exactly once), routes to the player and auto-starts playback (native
 * audio needs no user gesture). With no server configured yet, the share waits in pendingShare and
 * onboarding picks it up.
 */
import { router, useRootNavigationState } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect } from 'react';
import { create } from 'zustand';

import { openContent, type ContentRequest } from '@/player/controller';
import { usePlayback } from '@/store/playback';
import { useSettings } from '@/store/settings';

import { resolveShareIntent, type ResolvedShare } from './resolveShareIntent';

interface PendingShareState {
  pending: ResolvedShare | null;
  set: (p: ResolvedShare | null) => void;
}

export const usePendingShare = create<PendingShareState>()((set) => ({
  pending: null,
  set: (pending) => set({ pending }),
}));

export function contentRequestForShare(share: ResolvedShare): ContentRequest {
  switch (share.kind) {
    case 'file':
      return { kind: 'file', uri: share.uri, name: share.name, mimeType: share.mimeType, fromShare: true };
    case 'url':
      return {
        kind: 'url',
        url: share.url,
        title: share.title,
        fallbackText: share.fallbackText,
        fromShare: true,
      };
    case 'text':
      return { kind: 'text', text: share.text, title: share.title, libraryKind: 'share' };
  }
}

/** Open the player and start reading a shared payload. */
export function startSharedPlayback(share: ResolvedShare): void {
  router.push('/player');
  void openContent(contentRequestForShare(share), { autoStart: true });
}

export function useShareIntentRouting(ready: boolean): void {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext();
  const navState = useRootNavigationState();
  const navigationReady = !!navState?.key;

  useEffect(() => {
    if (!ready || !navigationReady || !hasShareIntent) return;
    const resolved = resolveShareIntent(shareIntent);
    resetShareIntent();
    if (!resolved) {
      usePlayback.getState().showToast("Tamber can't read that kind of content.", 'warning');
      return;
    }
    if (!useSettings.getState().settings.apiBaseUrl) {
      usePendingShare.getState().set(resolved);
      router.replace('/onboarding');
      return;
    }
    startSharedPlayback(resolved);
  }, [ready, navigationReady, hasShareIntent, shareIntent, resetShareIntent]);

  useEffect(() => {
    if (error) usePlayback.getState().showToast(`Share failed: ${error}`, 'error');
  }, [error]);
}
