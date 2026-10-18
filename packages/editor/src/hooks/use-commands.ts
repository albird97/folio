import type { AppCommand } from '@folio/platform-adapters';
import { matchesShortcut, nextThemePreference } from '@folio/shared-ui';
import { useCallback, useEffect, useRef } from 'react';
import { COMMAND_DEDUPE_MS, COMMAND_SHORTCUTS } from '../commands';
import { useWorkspaceContext } from '../context';

/** Runs app commands from native menus and the keyboard. Returns the dispatcher. */
export function useCommands(): (command: AppCommand) => void {
  const { adapter, workspace, ui, profile, shortcutPlatform } = useWorkspaceContext();
  const last = useRef<{ command: AppCommand; at: number } | null>(null);

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
          if (state.activeKey) void state.close(state.activeKey);
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
    [adapter, workspace, ui],
  );

  useEffect(() => adapter.onCommand(dispatch), [adapter, dispatch]);

  useEffect(() => {
    const shortcuts = COMMAND_SHORTCUTS[profile];
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      for (const [command, keys] of Object.entries(shortcuts) as Array<
        [AppCommand, readonly string[]]
      >) {
        if (keys.some((keyCombo) => matchesShortcut(event, keyCombo, shortcutPlatform))) {
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
