import { useEffect } from 'react';
import { useWorkspaceContext } from '../context';
import type { Tool } from '../store/ui';

/** Single-key tool shortcuts, as in other PDF editors. */
export const TOOL_KEYS: Readonly<Record<string, Tool>> = {
  v: 'select',
  h: 'highlight',
  u: 'underline',
  k: 'strikeout',
  n: 'note',
  p: 'ink',
  r: 'rectangle',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  t: 'text',
  i: 'image',
};

/** Opens the signature dialog: a signature is drawn or chosen before it is placed. */
const SIGN_KEY = 's';

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Letters pick tools while a document is open and nothing is being typed
 * (V Select, H Highlight, U Underline, K Strikethrough, N Note, P Draw,
 * R Rectangle, O Ellipse, L Line, A Arrow, T Text, I Image, S Sign).
 */
export function useToolShortcuts(): void {
  const { workspace, ui } = useWorkspaceContext();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(EDITABLE) ||
          target.closest('[role="dialog"], [role="menu"], [role="listbox"]'))
      ) {
        return;
      }
      const letter = event.key.toLowerCase();
      const tool = TOOL_KEYS[letter];
      if (!tool && letter !== SIGN_KEY) return;
      const state = workspace.getState();
      const doc = state.documents.find((entry) => entry.key === state.activeKey);
      if (doc?.status !== 'ready') return;
      if (tool !== 'select' && !doc.permissions.annotate) return;
      event.preventDefault();
      if (tool) ui.getState().setTool(tool);
      else ui.getState().openDialog({ kind: 'signature', docKey: doc.key });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspace, ui]);
}
