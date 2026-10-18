import { createUiStore, type UiState } from '@folio/editor';
import { applyInitialTheme, TooltipProvider, useTheme } from '@folio/shared-ui';
import { StrictMode, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore, type StoreApi } from 'zustand';
import { createChromeStorage } from './chrome-storage';
import { sendMessage } from './messages';

/**
 * Bootstraps a compact extension surface (popup, side panel, options) with
 * the shared theme preference, which follows changes from other pages.
 */
function Themed({ ui, children }: { ui: StoreApi<UiState>; children: ReactNode }) {
  const theme = useStore(ui, (state) => state.theme);
  const hydrated = useStore(ui, (state) => state.hydrated);
  useTheme(theme);
  return hydrated ? <TooltipProvider>{children}</TooltipProvider> : null;
}

export function mountSurface(render: (ui: StoreApi<UiState>) => ReactNode): void {
  applyInitialTheme();
  function Root() {
    const [ui] = useState(() => createUiStore(createChromeStorage()));
    return <Themed ui={ui}>{render(ui)}</Themed>;
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

export function openEditor(handoffId?: string) {
  return sendMessage(handoffId ? { type: 'editor/open', handoffId } : { type: 'editor/open' });
}
