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
    // Follow changes from other pages (e.g. the extension's options page).
    // Watchers also hear this page's own writes, sometimes after a newer
    // change: echoes of this page's writes are recognised and skipped (or a
    // late echo would briefly undo a newer change), and applied values are
    // never written back (or two pages would keep overwriting each other).
    let applyingStored = false;
    const unechoedWrites: string[] = [];
    storage.watch?.(UI_STORAGE_KEY, (value) => {
      const echo = unechoedWrites.indexOf(JSON.stringify(value));
      if (echo !== -1) {
        unechoedWrites.splice(0, echo + 1);
        return;
      }
      const next = sanitize(value);
      const current = store.getState();
      if ((Object.keys(next) as Array<keyof Persisted>).some((key) => next[key] !== current[key])) {
        applyingStored = true;
        try {
          store.setState(next);
        } finally {
          applyingStored = false;
        }
      }
    });
    store.subscribe((state, previous) => {
      if (applyingStored) return;
      if (
        state.theme !== previous.theme ||
        state.leftPanelOpen !== previous.leftPanelOpen ||
        state.rightPanelOpen !== previous.rightPanelOpen
      ) {
        const persisted: Persisted = {
          theme: state.theme,
          leftPanelOpen: state.leftPanelOpen,
          rightPanelOpen: state.rightPanelOpen,
        };
        if (storage.watch) {
          unechoedWrites.push(JSON.stringify(persisted));
          // Storage only echoes real changes, so drop entries that never come back.
          if (unechoedWrites.length > 20) unechoedWrites.shift();
        }
        void storage.set<Persisted>(UI_STORAGE_KEY, persisted);
      }
    });
  });

  return store;
}
