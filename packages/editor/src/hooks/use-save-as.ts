import { useCallback, useRef } from 'react';
import { useWorkspaceContext } from '../context';

const WARNING_NOTES = {
  'unsupported-characters':
    'Some characters in added text cannot be shown by the standard PDF fonts and were saved as “?”.',
} as const;

/**
 * "Save as": writes the document with all changes to a new file (a save
 * dialog on desktop, a download in browsers). The file the document was
 * opened from is only replaced if the user picks it in the save dialog.
 * Resolves true once saved.
 */
export function useSaveAs(): (key: string, options?: { flatten?: boolean }) => Promise<boolean> {
  const { adapter, workspace } = useWorkspaceContext();
  const saving = useRef(false);
  return useCallback(
    async (key: string, options: { flatten?: boolean } = {}) => {
      if (saving.current) return false;
      const state = workspace.getState();
      const doc = state.documents.find((entry) => entry.key === key);
      if (!doc?.editor || doc.status !== 'ready') return false;
      if (options.flatten && !doc.permissions.modify) {
        state.showNotice('The author of this document does not allow changing its pages.');
        return false;
      }
      saving.current = true;
      try {
        const { bytes, warnings } = await state.exportDocument(
          key,
          options.flatten === undefined ? {} : { flatten: options.flatten },
        );
        const result = await adapter.saveFileAs({ suggestedName: doc.fileName, bytes });
        if (result.status === 'cancelled') return false;
        workspace.getState().markSaved(key);
        const notes = [
          result.status === 'saved' ? `Saved as ${result.name}.` : `Downloading ${result.name}.`,
          ...warnings.map((warning) => WARNING_NOTES[warning]),
          ...(doc.info?.hasSignatures
            ? ['Its digital signatures do not cover the changes and will show as invalid.']
            : []),
        ];
        workspace.getState().showNotice(notes.join(' '));
        return true;
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        workspace
          .getState()
          .showNotice(
            code === 'wrong-password'
              ? 'The document could not be saved: a password for one of its files is missing.'
              : 'The document could not be saved.',
          );
        return false;
      } finally {
        saving.current = false;
      }
    },
    [adapter, workspace],
  );
}
