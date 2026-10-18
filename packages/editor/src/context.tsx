import type { PdfEngine } from '@folio/pdf-core';
import type { PlatformAdapter } from '@folio/platform-adapters';
import type { ShortcutPlatform } from '@folio/shared-ui';
import { TooltipProvider } from '@folio/shared-ui';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StoreApi } from 'zustand';
import { useStore } from 'zustand';
import type { ShortcutProfile } from './commands';
import { createUiStore, type UiState } from './store/ui';
import { createWorkspaceStore, type WorkspaceState, type WorkspaceStore } from './store/workspace';

interface WorkspaceContextValue {
  adapter: PlatformAdapter;
  workspace: WorkspaceStore;
  ui: StoreApi<UiState>;
  profile: ShortcutProfile;
  shortcutPlatform: ShortcutPlatform;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export interface WorkspaceProviderProps {
  adapter: PlatformAdapter;
  engine: PdfEngine;
  profile: ShortcutProfile;
  children: ReactNode;
  /** Inject pre-built stores (tests). */
  stores?: { workspace: WorkspaceStore; ui: StoreApi<UiState> };
}

export function WorkspaceProvider({
  adapter,
  engine,
  profile,
  children,
  stores,
}: WorkspaceProviderProps) {
  const [value] = useState<WorkspaceContextValue>(() => ({
    adapter,
    workspace: stores?.workspace ?? createWorkspaceStore(engine),
    ui: stores?.ui ?? createUiStore(adapter.storage),
    profile,
    shortcutPlatform: adapter.os === 'macos' ? 'macos' : 'other',
  }));
  // StrictMode (development) unmounts and remounts once right after mounting,
  // keeping state. Destroying at once would close, and release the grants of,
  // files the first mount already opened; a remount cancels the pending destroy.
  const pendingDestroy = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const { workspace } = value;
    clearTimeout(pendingDestroy.current);
    return () => {
      pendingDestroy.current = setTimeout(() => void workspace.destroy(), 0);
    };
  }, [value]);
  return (
    <WorkspaceContext.Provider value={value}>
      <TooltipProvider>{children}</TooltipProvider>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspaceContext must be used inside <WorkspaceProvider>.');
  return value;
}

export function useWorkspace<T>(selector: (state: WorkspaceState) => T): T {
  return useStore(useWorkspaceContext().workspace, selector);
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStore(useWorkspaceContext().ui, selector);
}

export function useActiveDocument() {
  return useWorkspace(
    (state) => state.documents.find((doc) => doc.key === state.activeKey) ?? null,
  );
}
