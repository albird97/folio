import type { PdfEngine } from '@folio/pdf-core';
import type { PlatformAdapter } from '@folio/platform-adapters';
import type { ShortcutPlatform } from '@folio/shared-ui';
import { TooltipProvider } from '@folio/shared-ui';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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

export function WorkspaceProvider({ adapter, engine, profile, children, stores }: WorkspaceProviderProps) {
  const [value] = useState<WorkspaceContextValue>(() => ({
    adapter,
    workspace: stores?.workspace ?? createWorkspaceStore(engine),
    ui: stores?.ui ?? createUiStore(adapter.storage),
    profile,
    shortcutPlatform: adapter.os === 'macos' ? 'macos' : 'other',
  }));
  useEffect(() => {
    const { workspace } = value;
    return () => {
      void workspace.destroy();
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
  return useWorkspace((state) => state.documents.find((doc) => doc.key === state.activeKey) ?? null);
}
