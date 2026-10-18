import type { PageId } from '@folio/document-model';
import type { IncomingFile } from '@folio/platform-adapters';
import { useCallback, useMemo } from 'react';
import type { StoreApi } from 'zustand';
import { useWorkspaceContext } from '../context';
import { inDocumentOrder, pagesLabel, PERMISSION_MESSAGES, targetPages } from '../store/editing';
import type { UiState } from '../store/ui';
import { baseName, type WorkspaceDocument, type WorkspaceStore } from '../store/workspace';

export interface PageCommands {
  /** The pages commands act on: the selected ones, or the current page. */
  targets(): PageId[];
  rotate(delta: 90 | -90): void;
  deletePages(): void;
  duplicate(): void;
  insertBlank(): void;
  /** Asks for PDF files and inserts their pages after the targets. */
  insertFromFile(): void;
  insertFiles(files: IncomingFile[], index: number): Promise<void>;
  extract(): void;
  split(): void;
}

/** "pages 2–4" / "page 7" / "5 pages", for file names. */
function pagesName(positions: readonly number[]): string {
  if (positions.length === 1) return `page ${positions[0]! + 1}`;
  const contiguous = positions.every(
    (value, index) => index === 0 || value === positions[index - 1]! + 1,
  );
  return contiguous
    ? `pages ${positions[0]! + 1}–${positions.at(-1)! + 1}`
    : `${positions.length} pages`;
}

/**
 * Inserts the pages of PDF files one after the other at `index`. A protected
 * file stops the run with a password dialog, which carries on with the rest.
 */
export async function insertFiles(
  workspace: WorkspaceStore,
  ui: StoreApi<UiState>,
  key: string,
  files: readonly IncomingFile[],
  index: number,
  password?: string,
): Promise<void> {
  let at = index;
  for (const [position, file] of files.entries()) {
    const outcome = await workspace
      .getState()
      .insertPagesFromFile(key, file, at, position === 0 ? password : undefined);
    if (outcome.status === 'needs-password') {
      ui.getState().openDialog({
        kind: 'insert-password',
        docKey: key,
        file,
        index: at,
        rejected: outcome.rejected,
        rest: files.slice(position + 1),
      });
      return;
    }
    if (outcome.status === 'failed') {
      workspace.getState().showNotice(`${file.name}: ${outcome.message}`);
      continue;
    }
    at += outcome.count;
  }
}

/**
 * Page commands for a document, shared by the pages panel, menus and the
 * keyboard so they behave the same everywhere.
 */
export function usePageCommands(doc: WorkspaceDocument | null): PageCommands {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const key = doc?.key ?? null;

  const current = useCallback(
    () => (key ? workspace.getState().documents.find((entry) => entry.key === key) : undefined),
    [workspace, key],
  );

  const targets = useCallback((): PageId[] => {
    const latest = current();
    const model = latest?.editor?.model;
    if (!latest || !model) return [];
    return targetPages(model, latest.selection.pages, latest.view?.currentPageId ?? null);
  }, [current]);

  /** Index right after the last target page. */
  const afterTargets = useCallback(() => {
    const model = current()?.editor?.model;
    if (!model) return 0;
    const wanted = new Set(targets());
    let last = -1;
    model.pages.forEach((page, index) => {
      if (wanted.has(page.id)) last = index;
    });
    return last + 1;
  }, [current, targets]);

  const insert = useCallback(
    async (files: IncomingFile[], index: number) => {
      if (key) await insertFiles(workspace, ui, key, files, index);
    },
    [workspace, ui, key],
  );

  return useMemo<PageCommands>(
    () => ({
      targets,
      rotate(delta) {
        if (key) workspace.getState().rotatePages(key, targets(), delta);
      },
      deletePages() {
        if (key) workspace.getState().deletePages(key, targets());
      },
      duplicate() {
        if (key) workspace.getState().duplicatePages(key, targets());
      },
      insertBlank() {
        if (key) workspace.getState().insertBlankPage(key, afterTargets());
      },
      insertFromFile() {
        if (!key) return;
        if (!current()?.permissions.assemble) {
          workspace.getState().showNotice(PERMISSION_MESSAGES.assemble);
          return;
        }
        const index = afterTargets();
        void adapter.pickPdfFiles({ multiple: true }).then(
          (files) => insert(files, index),
          () => workspace.getState().showNotice('The file picker could not be opened.'),
        );
      },
      insertFiles: insert,
      extract() {
        const latest = current();
        const model = latest?.editor?.model;
        if (!key || !latest || !model) return;
        if (!latest.permissions.extract) {
          workspace.getState().showNotice(PERMISSION_MESSAGES.extract);
          return;
        }
        const pageIds = inDocumentOrder(model, targets());
        const positions = pageIds.map((id) => model.pages.findIndex((page) => page.id === id));
        const name = `${baseName(latest.fileName)} (${pagesName(positions)}).pdf`;
        void workspace
          .getState()
          .exportDocument(key, { pageIds })
          .then((result) => adapter.saveFileAs({ suggestedName: name, bytes: result.bytes }))
          .then(
            (saved) => {
              if (saved.status === 'saved') {
                workspace
                  .getState()
                  .showNotice(`Saved ${pagesLabel(pageIds.length)} as ${saved.name}.`);
              } else if (saved.status === 'downloaded') {
                workspace
                  .getState()
                  .showNotice(`Downloading ${pagesLabel(pageIds.length)} as ${saved.name}.`);
              }
            },
            () => workspace.getState().showNotice('The pages could not be saved.'),
          );
      },
      split() {
        if (key) ui.getState().openDialog({ kind: 'split', docKey: key });
      },
    }),
    [adapter, workspace, ui, key, current, targets, afterTargets, insert],
  );
}
