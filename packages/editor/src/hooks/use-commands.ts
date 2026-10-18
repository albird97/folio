import type { AppCommand } from '@folio/platform-adapters';
import { matchesShortcut, nextThemePreference, worksInTextFields } from '@folio/shared-ui';
import { useCallback, useEffect, useRef } from 'react';
import { COMMAND_DEDUPE_MS, COMMAND_SHORTCUTS } from '../commands';
import { FIND_INPUT_ID } from '../components/find-bar';
import { PAGE_INPUT_ID } from '../components/viewer-controls';
import { useWorkspaceContext } from '../context';
import { useCloseDocument } from './use-close-document';
import { useSaveCopy } from './use-save-copy';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (target instanceof HTMLElement && target.isContentEditable) || !!target.closest(EDITABLE);
}

/** Runs app commands from native menus and the keyboard. Returns the dispatcher. */
export function useCommands(): (command: AppCommand) => void {
  const { adapter, workspace, ui, profile, shortcutPlatform } = useWorkspaceContext();
  const last = useRef<{ command: AppCommand; at: number } | null>(null);
  const closeDocument = useCloseDocument();
  const saveCopy = useSaveCopy();

  const dispatch = useCallback(
    (command: AppCommand) => {
      const now = performance.now();
      if (last.current?.command === command && now - last.current.at < COMMAND_DEDUPE_MS) return;
      last.current = { command, at: now };
      const state = workspace.getState();
      const active = state.documents.find((doc) => doc.key === state.activeKey);
      // Viewer commands need an open, readable document.
      const key = active?.status === 'ready' ? active.key : null;
      const focusField = (id: string) => {
        const field = document.getElementById(id);
        if (field instanceof HTMLInputElement) {
          field.focus();
          field.select();
        }
      };
      switch (command) {
        case 'open':
          void adapter.pickPdfFiles({ multiple: true }).then(
            (files) => state.openFiles(files),
            () => state.showNotice('The file picker could not be opened.'),
          );
          break;
        case 'close-tab':
          if (state.activeKey) closeDocument(state.activeKey);
          break;
        case 'next-tab':
          state.activateRelative(1);
          break;
        case 'previous-tab':
          state.activateRelative(-1);
          break;
        case 'toggle-left-panel':
          ui.getState().toggleLeftPanel();
          break;
        case 'toggle-right-panel':
          ui.getState().toggleRightPanel();
          break;
        case 'cycle-theme':
          ui.getState().setTheme(nextThemePreference(ui.getState().theme));
          break;
        case 'save-copy':
          if (key) saveCopy(key);
          break;
        case 'zoom-in':
          if (key) state.zoomBy(key, 1);
          break;
        case 'zoom-out':
          if (key) state.zoomBy(key, -1);
          break;
        case 'zoom-actual-size':
          if (key) state.setZoom(key, 'custom', 1);
          break;
        case 'zoom-fit-width':
          if (key) state.setZoom(key, 'fit-width');
          break;
        case 'zoom-fit-page':
          if (key) state.setZoom(key, 'fit-page');
          break;
        case 'rotate-clockwise':
          if (key) state.rotateView(key, 90);
          break;
        case 'rotate-counterclockwise':
          if (key) state.rotateView(key, -90);
          break;
        case 'go-to-page':
          if (key) focusField(PAGE_INPUT_ID);
          break;
        case 'find':
          if (!key) break;
          // An open find bar takes focus again; a new one focuses itself.
          if (active?.search.open) focusField(FIND_INPUT_ID);
          else state.openSearch(key);
          break;
        case 'find-next':
        case 'find-previous':
          if (!key) break;
          if (active?.search.open && active.search.matches.length > 0) {
            state.stepSearch(key, command === 'find-next' ? 1 : -1);
          } else if (!active?.search.open) {
            state.openSearch(key);
          }
          break;
      }
    },
    [adapter, workspace, ui, closeDocument, saveCopy],
  );

  useEffect(() => adapter.onCommand(dispatch), [adapter, dispatch]);

  useEffect(() => {
    const shortcuts = COMMAND_SHORTCUTS[profile];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // In text fields only Ctrl/⌘ shortcuts and function keys apply; other
      // keys type text (⌥W is "∑" on a Mac).
      const editable = isEditable(event.target);
      // Windows also types AltGr characters with Ctrl+Alt, without reporting
      // AltGraph (Ctrl+Alt+2 is "@" on Spanish keyboards), including dead keys
      // that start a composed character ("~" on French and Czech keyboards).
      if (editable && shortcutPlatform === 'other' && event.ctrlKey && event.altKey) {
        if (event.key === 'Dead' || (event.key.length === 1 && !/^[a-z0-9]$/i.test(event.key))) {
          return;
        }
      }
      for (const [command, keys] of Object.entries(shortcuts) as Array<
        [AppCommand, readonly string[]]
      >) {
        if (
          keys.some(
            (keyCombo) =>
              (!editable || worksInTextFields(keyCombo)) &&
              matchesShortcut(event, keyCombo, shortcutPlatform),
          )
        ) {
          event.preventDefault();
          dispatch(command);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch, profile, shortcutPlatform]);

  return dispatch;
}
