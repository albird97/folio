import { sha256Hex } from '@folio/pdf-core';
import { useCallback, useRef } from 'react';
import { useWorkspaceContext } from '../context';
import { exportFailureMessage, saveNotes, useSaveAs } from './use-save-as';

/**
 * "Save": writes the changes back to the file the document came from (or
 * was last saved as), atomically, only when the user asks. A file changed by
 * another program since Folio read it is never overwritten silently: the
 * user chooses between overwriting it and saving elsewhere. Where a file
 * cannot be written (browsers, files from Chrome, read-only files), Save
 * falls back to Save As. Resolves true once saved.
 */
export function useSave(): (key: string) => Promise<boolean> {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const saveAs = useSaveAs();
  const saving = useRef(false);
  return useCallback(
    async (key: string) => {
      const doc = workspace.getState().documents.find((entry) => entry.key === key);
      if (!doc?.editor || doc.status !== 'ready' || saving.current) return false;
      const target = doc.saveTarget;
      if (!adapter.features.saveInPlace || !target || !doc.diskSha256) return saveAs(key);
      saving.current = true;
      let outcome: 'saved' | 'failed' | 'save-as' = 'failed';
      try {
        const { bytes, warnings } = await workspace.getState().exportDocument(key);
        const request = { handle: target.handle, bytes, expectedSha256: doc.diskSha256 };
        let result = await adapter.writeFile(request);
        if (result.status === 'changed-on-disk') {
          const choice = await new Promise<'overwrite' | 'save-as' | 'cancel'>((resolve) =>
            ui.getState().openDialog({ kind: 'save-conflict', docKey: key, resolve }),
          );
          if (choice === 'save-as') outcome = 'save-as';
          if (choice !== 'overwrite') return outcome === 'save-as' ? saveAs(key) : false;
          result = await adapter.writeFile({ ...request, overwriteExternalChanges: true });
        }
        if (result.status === 'unavailable') {
          workspace.getState().showNotice(`${result.message} Choose where to save it instead.`);
          outcome = 'save-as';
        } else if (result.status === 'saved') {
          const state = workspace.getState();
          state.markSaved(key);
          state.setSaveTarget(key, target, await sha256Hex(bytes));
          state.showNotice(
            [
              `Saved ${target.name}.`,
              ...saveNotes(warnings, doc.info?.hasSignatures ?? false),
            ].join(' '),
          );
          outcome = 'saved';
        }
      } catch (error) {
        workspace.getState().showNotice(exportFailureMessage(error));
      } finally {
        saving.current = false;
      }
      if (outcome === 'save-as') return saveAs(key);
      return outcome === 'saved';
    },
    [adapter, workspace, ui, saveAs],
  );
}
