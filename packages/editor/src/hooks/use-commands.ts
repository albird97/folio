import type { AppCommand } from '@folio/platform-adapters';
import { matchesShortcut, nextThemePreference, usesCommandModifier } from '@folio/shared-ui';
import { useCallback, useEffect, useRef } from 'react';
import { COMMAND_DEDUPE_MS, COMMAND_SHORTCUTS } from '../commands';
import { useWorkspaceContext } from '../context';
import { useCloseDocument } from './use-close-document';

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

  const dispatch = useCallback(
    (command: AppCommand) => {
      const now = performance.now();
      if (last.current?.command === command && now - last.current.at < COMMAND_DEDUPE_MS) return;
      last.current = { command, at: now };
      const state = workspace.getState();
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
      }
    },
    [adapter, workspace, ui, closeDocument],
  );

  useEffect(() => adapter.onCommand(dispatch), [adapter, dispatch]);

  useEffect(() => {
    const shortcuts = COMMAND_SHORTCUTS[profile];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // In text fields only Ctrl/⌘ shortcuts apply; other keys type text
      // (⌥W is "∑" on a Mac).
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
              (!editable || usesCommandModifier(keyCombo)) &&
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
