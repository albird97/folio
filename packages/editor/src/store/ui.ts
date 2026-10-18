import { isThemePreference, type ThemePreference } from '@folio/shared-ui';
import type { KeyValueStorage } from '@folio/platform-adapters';
import { createStore, type StoreApi } from 'zustand/vanilla';

/** Workspace chrome state. Persisted per installation; never part of a document. */
export interface UiState {
  theme: ThemePreference;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  hydrated: boolean;
  setTheme(theme: ThemePreference): void;
  toggleLeftPanel(): void;
  toggleRightPanel(): void;
}

type Persisted = Pick<UiState, 'theme' | 'leftPanelOpen' | 'rightPanelOpen'>;

export const UI_STORAGE_KEY = 'workspace-ui';

function sanitize(value: unknown): Partial<Persisted> {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<Persisted> = {};
  if (isThemePreference(raw.theme)) out.theme = raw.theme;
  if (typeof raw.leftPanelOpen === 'boolean') out.leftPanelOpen = raw.leftPanelOpen;
  if (typeof raw.rightPanelOpen === 'boolean') out.rightPanelOpen = raw.rightPanelOpen;
  return out;
}

export function createUiStore(storage: KeyValueStorage): StoreApi<UiState> {
  const store = createStore<UiState>()((set) => ({
    theme: 'system',
    leftPanelOpen: true,
    rightPanelOpen: true,
    hydrated: false,
    setTheme: (theme) => set({ theme }),
    toggleLeftPanel: () => set((state) => ({ leftPanelOpen: !state.leftPanelOpen })),
    toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  }));

  void storage.get<unknown>(UI_STORAGE_KEY).then((stored) => {
    store.setState({ ...sanitize(stored), hydrated: true });
    store.subscribe((state, previous) => {
      if (
        state.theme !== previous.theme ||
        state.leftPanelOpen !== previous.leftPanelOpen ||
        state.rightPanelOpen !== previous.rightPanelOpen
      ) {
        void storage.set<Persisted>(UI_STORAGE_KEY, {
          theme: state.theme,
          leftPanelOpen: state.leftPanelOpen,
          rightPanelOpen: state.rightPanelOpen,
        });
      }
    });
  });

  return store;
}
