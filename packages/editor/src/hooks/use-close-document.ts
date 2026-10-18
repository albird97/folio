import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import { useWorkspaceContext } from '../context';

/**
 * Closes a document without losing keyboard focus. When focus was inside what
 * closed (the tab's close button, the error or password screen, the pages
 * panel), it moves to the tab of the document shown next (`data-document-tab`),
 * or to the Welcome screen's primary action (`data-start-action`) once none is
 * left, instead of dropping to <body>.
 */
export function useCloseDocument(): (key: string) => void {
  const { workspace } = useWorkspaceContext();
  return useCallback(
    (key: string) => {
      // Render the removal now so the element to focus exists.
      flushSync(() => void workspace.getState().close(key));
      if (document.activeElement && document.activeElement !== document.body) return;
      const { activeKey } = workspace.getState();
      const target = activeKey
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-document-tab]')).find(
            (tab) => tab.dataset.documentTab === activeKey,
          )
        : document.querySelector<HTMLElement>('[data-start-action]');
      target?.focus();
    },
    [workspace],
  );
}
