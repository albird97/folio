import { sha256Hex } from '@folio/pdf-core';
import { useCallback, useRef } from 'react';
import { useWorkspaceContext } from '../context';

const WARNING_NOTES = {
  'unsupported-characters':
    'Some characters in added text, page numbers or the watermark cannot be shown by the standard PDF fonts and were saved as “?”.',
  'unsupported-form-characters':
    'Some characters in form fields cannot be shown by the standard PDF fonts and were drawn as “?”.',
} as const;

export const SIGNATURE_NOTE =
  'Its digital signatures do not cover the changes and will show as invalid.';

/** Notes to add to "Saved …" messages: export warnings and signatures. */
export function saveNotes(
  warnings: readonly (keyof typeof WARNING_NOTES)[],
  hasSignatures: boolean,
): string[] {
  return [
    ...warnings.map((warning) => WARNING_NOTES[warning]),
    ...(hasSignatures ? [SIGNATURE_NOTE] : []),
  ];
}

export interface SaveAsOptions {
  /** Burn comments into the pages. */
  flatten?: boolean;
  /** Burn the form's fields into the pages. */
  flattenForms?: boolean;
}

export function exportFailureMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  return code === 'wrong-password'
    ? 'The document could not be saved: a password for one of its files is missing.'
    : 'The document could not be saved.';
}

/**
 * "Save as": writes the document with all changes to a new file (a save
 * dialog on desktop, a download in browsers). The file the document was
 * opened from is only replaced if the user picks it in the save dialog. On
 * desktop, later saves go to the chosen file. Resolves true once saved.
 */
export function useSaveAs(): (key: string, options?: SaveAsOptions) => Promise<boolean> {
  const { adapter, workspace } = useWorkspaceContext();
  const saving = useRef(false);
  return useCallback(
    async (key: string, options: SaveAsOptions = {}) => {
      if (saving.current) return false;
      const state = workspace.getState();
      const doc = state.documents.find((entry) => entry.key === key);
      if (!doc?.editor || doc.status !== 'ready') return false;
      const flattened = options.flatten === true || options.flattenForms === true;
      if (flattened && !doc.permissions.modify) {
        state.showNotice('The author of this document does not allow changing its pages.');
        return false;
      }
      saving.current = true;
      try {
        const { bytes, warnings } = await state.exportDocument(key, {
          ...(options.flatten === undefined ? {} : { flatten: options.flatten }),
          ...(options.flattenForms ? { flattenForms: true } : {}),
        });
        // A flattened copy is a different document: the next Save does not go there.
        const keepAccess = adapter.features.saveInPlace && !flattened;
        const result = await adapter.saveFileAs({
          suggestedName: doc.fileName,
          bytes,
          ...(keepAccess ? { keepAccess } : {}),
        });
        if (result.status === 'cancelled') return false;
        const current = workspace.getState();
        if (!flattened) current.markSaved(key);
        if (result.status === 'saved' && result.handle) {
          const handle = result.handle;
          current.setSaveTarget(
            key,
            { handle, name: result.name },
            { sha256: await sha256Hex(bytes), byteLength: bytes.byteLength },
            () => adapter.releaseHandle(handle),
          );
        }
        current.showNotice(
          [
            result.status === 'saved' ? `Saved as ${result.name}.` : `Downloading ${result.name}.`,
            ...saveNotes(warnings, doc.info?.hasSignatures ?? false),
          ].join(' '),
        );
        return true;
      } catch (error) {
        workspace.getState().showNotice(exportFailureMessage(error));
        return false;
      } finally {
        saving.current = false;
      }
    },
    [adapter, workspace],
  );
}
