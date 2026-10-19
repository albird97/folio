import type { AppCommand } from '@folio/platform-adapters';
import { matchesShortcut, nextThemePreference, worksInTextFields } from '@folio/shared-ui';
import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { COMMAND_DEDUPE_MS, COMMAND_SHORTCUTS } from '../commands';
import { FIND_INPUT_ID } from '../components/find-bar';
import { PAGE_INPUT_ID } from '../components/viewer-controls';
import { useActiveDocument, useWorkspaceContext } from '../context';
import { TOOL_DIALOG_KINDS } from '../store/ui';
import { useCloseDocument } from './use-close-document';
import { usePageCommands } from './use-page-commands';
import { useSave } from './use-save';
import { useSaveAs } from './use-save-as';
import { useSaveCopy } from './use-save-copy';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (target instanceof HTMLElement && target.isContentEditable) || !!target.closest(EDITABLE);
}

/** Fields with an undo history of their own: text being typed (a list has none). */
function undoesItself(target: EventTarget | null): boolean {
  return isEditable(target) && !(target instanceof HTMLSelectElement);
}

/** Where a command came from: a native menu, a key press, or a control in the page. */
type CommandSource = 'menu' | 'keyboard' | 'ui';

/** Commands a text field handles itself (its own undo history) when it has focus. */
const FIELD_COMMANDS: ReadonlySet<AppCommand> = new Set(['undo', 'redo']);

/** Runs app commands from native menus and the keyboard. Returns the dispatcher. */
export function useCommands(): (command: AppCommand) => void {
  const { adapter, workspace, ui, profile, shortcutPlatform } = useWorkspaceContext();
  const last = useRef<{ command: AppCommand; at: number; source: CommandSource } | null>(null);
  const closeDocument = useCloseDocument();
  const saveCopy = useSaveCopy();
  const saveAs = useSaveAs();
  const save = useSave();
  const activeDoc = useActiveDocument();
  const pageCommands = usePageCommands(activeDoc?.status === 'ready' ? activeDoc : null);

  const run = useCallback(
    (command: AppCommand, source: CommandSource) => {
      const now = performance.now();
      // One key press can reach both a native menu accelerator and the page.
      // Repeats from the same source (pressing Undo twice) are separate.
      const previous = last.current;
      const echo =
        (previous?.source === 'menu' && source === 'keyboard') ||
        (previous?.source === 'keyboard' && source === 'menu');
      if (previous?.command === command && echo && now - previous.at < COMMAND_DEDUPE_MS) {
        return;
      }
      last.current = { command, at: now, source };
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
      // A native Edit menu's Undo while typing undoes the typing.
      if (FIELD_COMMANDS.has(command) && undoesItself(document.activeElement)) {
        document.execCommand(command);
        return;
      }
      switch (command) {
        case 'undo':
          if (key) state.undo(key);
          break;
        case 'redo':
          if (key) state.redo(key);
          break;
        case 'save':
          if (key) void save(key);
          break;
        case 'save-as':
          if (key) void saveAs(key);
          break;
        case 'print':
          if (!key || !active) break;
          if (!adapter.features.printing) {
            state.showNotice('Printing is not available here.');
          } else if (active.info?.permissions && !active.info.permissions.print) {
            state.showNotice('The author of this document does not allow printing it.');
          } else {
            ui.getState().openDialog({ kind: 'print', docKey: key });
          }
          break;
        case 'insert-pages':
          pageCommands.insertFromFile();
          break;
        case 'insert-blank-page':
          pageCommands.insertBlank();
          break;
        case 'rotate-pages-clockwise':
          pageCommands.rotate(90);
          break;
        case 'rotate-pages-counterclockwise':
          pageCommands.rotate(-90);
          break;
        case 'delete-pages':
          pageCommands.deletePages();
          break;
        case 'extract-pages':
          pageCommands.extract();
          break;
        case 'sign':
        case 'page-numbers':
        case 'watermark':
        case 'recognize-text':
        case 'export-images':
        case 'export-text':
        case 'reduce-file-size':
        case 'protect':
        case 'ask-ai':
          if (key) ui.getState().openDialog({ kind: TOOL_DIALOG_KINDS[command], docKey: key });
          break;
        case 'open':
          void adapter.pickPdfFiles({ multiple: true }).then(
            (files) => state.openFiles(files),
            () => state.showNotice('The file picker could not be opened.'),
          );
          break;
        case 'open-url':
          if (adapter.features.openFromUrl && adapter.openUrl) {
            ui.getState().openDialog({ kind: 'open-url' });
          } else {
            state.showNotice('Opening from a web address is not available here.');
          }
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
          // Render the find bar now so its field exists to take focus.
          if (!active?.search.open) flushSync(() => state.openSearch(key));
          focusField(FIND_INPUT_ID);
          break;
        case 'find-next':
        case 'find-previous':
          if (!key) break;
          if (active?.search.open && active.search.matches.length > 0) {
            state.stepSearch(key, command === 'find-next' ? 1 : -1);
          } else if (!active?.search.open) {
            flushSync(() => state.openSearch(key));
            focusField(FIND_INPUT_ID);
          }
          break;
      }
    },
    [adapter, workspace, ui, closeDocument, saveCopy, saveAs, save, pageCommands],
  );

  const dispatch = useCallback((command: AppCommand) => run(command, 'ui'), [run]);

  useEffect(() => adapter.onCommand((command) => run(command, 'menu')), [adapter, run]);

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
        // Undo and redo in a text field undo the typing, as everywhere else.
        if (FIELD_COMMANDS.has(command) && undoesItself(event.target)) continue;
        if (
          keys.some(
            (keyCombo) =>
              (!editable || worksInTextFields(keyCombo)) &&
              matchesShortcut(event, keyCombo, shortcutPlatform),
          )
        ) {
          event.preventDefault();
          run(command, 'keyboard');
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [run, profile, shortcutPlatform]);

  return dispatch;
}
