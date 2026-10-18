import {
  isDirty,
  serializeRecoverySnapshot,
  type AssetId,
  type DocumentViewState,
  type EditorDocumentState,
} from '@folio/document-model';
import { useEffect } from 'react';
import { useWorkspaceContext } from '../context';
import type { WorkspaceDocument } from '../store/workspace';
import { claimRecord, recordsInUse, releaseRecord } from '../store/recovery-locks';

/** Unsaved work is written this long after the last change. */
const AUTOSAVE_DELAY_MS = 2000;
/** Scrolling alone (no edit) refreshes the record at most this often. */
const VIEW_REFRESH_MS = 60_000;

interface Written {
  editor: EditorDocumentState;
  view: DocumentViewState;
  at: number;
}

/**
 * Crash recovery (where the platform keeps recovery data): documents with
 * unsaved changes are written to the platform's recovery store shortly after
 * each change, with the source files and images they need, and offered
 * again after a crash. Records go as soon as a document is saved or closed;
 * nothing is kept for documents without unsaved changes.
 */
export function useRecovery(): void {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const enabled = adapter.features.crashRecovery;

  // Work left by an earlier session is offered once, when Folio starts.
  // Records another open window is working on are not left over.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void Promise.all([adapter.recovery.list(), recordsInUse()]).then(
      ([records, inUse]) => {
        const left = records.filter((record) => !inUse.has(record.id));
        if (active && left.length > 0) ui.getState().openDialog({ kind: 'recover', records: left });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [adapter, ui, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const { recovery } = adapter;
    const written = new Map<string, Written>();
    /** Records known not to exist (documents without unsaved changes). */
    const absent = new Set<string>();
    /** Records of documents open in this session (restored ones included). */
    const owned = new Set<string>();
    /** Files already stored, as `record:key`. */
    const stored = new Set<string>();
    /** Records another window has (the same work restored twice): left alone. */
    const foreign = new Set<string>();
    const remove = async (id: string) => {
      written.delete(id);
      for (const file of [...stored]) if (file.startsWith(`${id}:`)) stored.delete(file);
      await recovery.remove(id).catch(() => undefined);
      absent.add(id);
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    /** A flush asked for while one was running: run again, at once if urgent. */
    let again: 'no' | 'later' | 'now' = 'no';
    let warned = false;

    const flush = async (urgent: boolean) => {
      if (running) {
        if (urgent || again === 'no') again = urgent ? 'now' : 'later';
        return;
      }
      running = true;
      try {
        const live = new Set<string>();
        for (const doc of workspace.getState().documents) {
          if (doc.status !== 'ready' || !doc.editor || !doc.view) continue;
          const id = doc.recoveryId;
          live.add(id);
          if (!owned.has(id)) {
            owned.add(id);
            if (!(await claimRecord(id))) foreign.add(id);
          }
          if (foreign.has(id)) continue;
          if (!isDirty(doc.editor)) {
            // Saved (or never changed): including records restored from a crash.
            if (!absent.has(id)) await remove(id);
            continue;
          }
          absent.delete(id);
          const last = written.get(id);
          if (
            last?.editor === doc.editor &&
            (last.view === doc.view || Date.now() - last.at < VIEW_REFRESH_MS)
          ) {
            continue;
          }
          // Files first: a snapshot never refers to a file that is not stored.
          const { model } = doc.editor;
          const files: Array<[string, Uint8Array | null]> = [
            ...Object.values(model.sources).map(
              (source) =>
                [source.sha256, workspace.getSourceBytes(doc.key, source.id)] as [
                  string,
                  Uint8Array | null,
                ],
            ),
            ...(Object.keys(model.assets) as AssetId[]).map(
              (assetId) =>
                [assetId, workspace.getAssetBytes(doc.key, assetId)] as [string, Uint8Array | null],
            ),
          ];
          for (const [key, bytes] of files) {
            if (!bytes || stored.has(`${id}:${key}`)) continue;
            await recovery.saveFile(id, key, bytes);
            stored.add(`${id}:${key}`);
          }
          await recovery.saveSnapshot(
            { id, title: doc.fileName },
            serializeRecoverySnapshot(doc.editor, doc.view),
          );
          written.set(id, { editor: doc.editor, view: doc.view, at: Date.now() });
        }
        // Closed documents leave nothing behind.
        for (const id of [...owned]) {
          if (live.has(id)) continue;
          owned.delete(id);
          if (foreign.delete(id)) continue;
          if (!absent.has(id)) await remove(id);
          releaseRecord(id);
        }
      } catch {
        // Recovery is a safety net: it never interrupts editing.
        if (!warned) {
          warned = true;
          workspace
            .getState()
            .showNotice('Unsaved changes could not be kept for recovery (no space left?).');
        }
      } finally {
        running = false;
        if (again !== 'no') {
          schedule(again === 'now');
          again = 'no';
        }
      }
    };

    let timerUrgent = false;
    const schedule = (urgent: boolean) => {
      if (timer) {
        // A flush about to run covers later changes too.
        if (timerUrgent) return;
        clearTimeout(timer);
      }
      timerUrgent = urgent;
      timer = setTimeout(
        () => {
          timer = null;
          void flush(urgent);
        },
        urgent ? 0 : AUTOSAVE_DELAY_MS,
      );
    };
    const unsaved = (documents: readonly WorkspaceDocument[]) =>
      new Set(documents.filter((doc) => doc.editor && isDirty(doc.editor)).map((doc) => doc.key));
    const unsubscribe = workspace.subscribe((state, previous) => {
      if (state.documents === previous.documents) return;
      // Saved and closed documents give their records up at once, so their
      // work is not offered again when the window closes right afterwards.
      const now = unsaved(state.documents);
      schedule([...unsaved(previous.documents)].some((key) => !now.has(key)));
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      for (const id of owned) if (!foreign.has(id)) releaseRecord(id);
    };
  }, [adapter, workspace, enabled]);
}
