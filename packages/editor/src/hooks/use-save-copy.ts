import { useCallback, useRef } from 'react';
import { useWorkspaceContext } from '../context';

/**
 * "Save a copy": writes the bytes of the file as it was opened to a new file,
 * through a save dialog on desktop or as a download in browsers. The opened
 * file itself is never overwritten.
 */
export function useSaveCopy(): (key: string) => void {
  const { adapter, workspace } = useWorkspaceContext();
  const saving = useRef(false);
  return useCallback(
    (key: string) => {
      if (saving.current || !adapter.features.saveCopy) return;
      const state = workspace.getState();
      const doc = state.documents.find((entry) => entry.key === key);
      const bytes = workspace.getBytes(key);
      if (!doc || !bytes) return;
      saving.current = true;
      adapter
        .saveFileAs({ suggestedName: doc.fileName, bytes })
        .then(
          (result) => {
            if (result.status === 'saved') state.showNotice(`Saved a copy as ${result.name}.`);
            else if (result.status === 'downloaded') {
              state.showNotice(`Downloading a copy as ${result.name}.`);
            }
          },
          () => state.showNotice('The copy could not be saved.'),
        )
        .finally(() => {
          saving.current = false;
        });
    },
    [adapter, workspace],
  );
}
