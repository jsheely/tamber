import type { HealthResponse, Voice, VoicesResponse } from '@tamber/client';
import { create } from 'zustand';

export type ConnectionState = 'unknown' | 'checking' | 'ok' | 'loading' | 'auth' | 'error';
export type DrawerName = 'voices' | 'settings' | 'import' | 'history';
export type ViewMode = 'compose' | 'read';
export type VoiceTab = 'voices' | 'blend';

/** Non-persisted UI + server state. Nothing here survives a reload by design. */
export interface SessionState {
  view: ViewMode;
  drawer: DrawerName | null;
  /** Voice drawer tab to open on. */
  voiceTab: VoiceTab;
  /** Focus the API key field when the settings drawer opens (401 / auth_required). */
  focusApiKey: boolean;
  connection: ConnectionState;
  connectionMessage: string | null;
  health: HealthResponse | null;
  voices: Voice[] | null;
  voicesDefault: string | null;
  voicesLoading: boolean;
  voicesError: string | null;
  setView: (view: ViewMode) => void;
  openDrawer: (drawer: DrawerName, opts?: { focusApiKey?: boolean; voiceTab?: VoiceTab }) => void;
  closeDrawer: () => void;
  setVoiceTab: (tab: VoiceTab) => void;
  setConnection: (connection: ConnectionState, message?: string | null) => void;
  setHealth: (health: HealthResponse | null) => void;
  setVoices: (res: VoicesResponse | null, error?: string | null) => void;
  setVoicesLoading: (loading: boolean) => void;
}

export const useSession = create<SessionState>()((set) => ({
  view: 'compose',
  drawer: null,
  voiceTab: 'voices',
  focusApiKey: false,
  connection: 'unknown',
  connectionMessage: null,
  health: null,
  voices: null,
  voicesDefault: null,
  voicesLoading: false,
  voicesError: null,
  setView: (view) => set({ view }),
  openDrawer: (drawer, opts) =>
    set((s) => ({
      drawer,
      focusApiKey: opts?.focusApiKey ?? false,
      voiceTab: opts?.voiceTab ?? s.voiceTab,
    })),
  closeDrawer: () => set({ drawer: null, focusApiKey: false }),
  setVoiceTab: (voiceTab) => set({ voiceTab }),
  setConnection: (connection, message = null) => set({ connection, connectionMessage: message }),
  setHealth: (health) => set({ health }),
  setVoices: (res, error = null) =>
    set({
      voices: res?.voices ?? null,
      voicesDefault: res?.default_voice ?? null,
      voicesError: error,
      voicesLoading: false,
    }),
  setVoicesLoading: (voicesLoading) => set({ voicesLoading }),
}));
