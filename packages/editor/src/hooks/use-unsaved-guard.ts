import { isDirty } from '@folio/document-model';
import { useEffect } from 'react';
import { useWorkspaceContext } from '../context';

/**
 * Tells the platform whether closing would lose work (the browser's leave
 * page prompt, the desktop window's close guard) and, on desktop, asks the
 * user before the window closes with unsaved changes.
 */
export function useUnsavedGuard(): void {
  const { adapter, workspace, ui } = useWorkspaceContext();

  useEffect(() => {
    const unsaved = () =>
      workspace.getState().documents.some((doc) => doc.editor !== null && isDirty(doc.editor));
    let last = unsaved();
    adapter.setUnsavedChanges(last);
    return workspace.subscribe(() => {
      const next = unsaved();
      if (next === last) return;
      last = next;
      adapter.setUnsavedChanges(next);
    });
  }, [adapter, workspace]);

  useEffect(
    () =>
      adapter.onCloseRequested?.(async () => {
        const dirty = workspace
          .getState()
          .documents.filter((doc) => doc.editor !== null && isDirty(doc.editor));
        if (dirty.length === 0) return true;
        const close = await new Promise<boolean>((resolve) =>
          ui.getState().openDialog({ kind: 'quit', resolve }),
        );
        if (close) {
          // Discarding is deliberate: drop the recovery copies too.
          await Promise.all(
            dirty.map((doc) => adapter.recovery.remove(doc.recoveryId).catch(() => undefined)),
          );
        }
        return close;
      }),
    [adapter, workspace, ui],
  );
}
