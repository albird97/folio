import type { PageId } from '@folio/document-model';
import type { PlatformAdapter } from '@folio/platform-adapters';
import { useCallback } from 'react';
import { create } from 'zustand';
import { useWorkspaceContext } from '../context';
import type { WorkspaceStore } from '../store/workspace';

/** Pages laid out for printing, as images in a print-only container. */
export interface PrintJob {
  pages: Array<{ url: string; width: number; height: number }>;
}

/** The current print job; the print layout shows it. */
export const usePrintJob = create<{ job: PrintJob | null; set(job: PrintJob | null): void }>(
  (set) => ({ job: null, set: (job) => set({ job }) }),
);

export interface PrintOptions {
  pageIds: PageId[];
  /** Print annotations (they are flattened into the printed pages). */
  includeComments: boolean;
}

/** Resolution of printed pages, lowered for long documents to bound memory. */
export function printDpi(pageCount: number): number {
  if (pageCount <= 100) return 150;
  if (pageCount <= 300) return 110;
  return 72;
}

/**
 * How long a print layout waits for `afterprint`. Browsers send it once the
 * print dialog is closed, however long that stays open, and the layout must
 * stay until then: the dialog's preview and the printer read it. A webview
 * that never sent it would keep the page images forever, so a layout is let
 * go after this long, or as soon as the next print starts.
 */
export const PRINT_LAYOUT_TIMEOUT_MS = 30 * 60_000;

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** One print at a time while it is prepared or a platform dialog is up. */
let busy = false;
/** Lets go of a layout still waiting for `afterprint`. */
let releaseLayout: (() => void) | null = null;

/**
 * Prints pages of a document: writes them (with comments flattened if
 * wanted) to an in-memory PDF and, where the platform prints PDFs itself
 * (macOS), hands it that PDF. Elsewhere it draws each page at print
 * resolution, shows the images in a layout only print styles reveal, and
 * opens the system's print dialog. Nothing is written to disk.
 */
export function usePrint(): (key: string, options: PrintOptions) => Promise<void> {
  const { adapter, workspace } = useWorkspaceContext();
  return useCallback(
    async (key: string, options: PrintOptions) => {
      const state = workspace.getState();
      const doc = state.documents.find((entry) => entry.key === key);
      if (!doc?.editor || doc.status !== 'ready' || options.pageIds.length === 0) return;
      if (doc.info?.permissions && !doc.info.permissions.print) {
        state.showNotice('The author of this document does not allow printing it.');
        return;
      }
      if (busy) return;
      busy = true;
      // The platform never said the previous layout was printed.
      releaseLayout?.();
      try {
        // An in-memory copy with the comments burnt in, or without them.
        const { bytes } = await state.exportDocument(key, {
          pageIds: options.pageIds,
          flatten: options.includeComments,
          withoutAnnotations: !options.includeComments,
          unprotected: true,
        });
        if (adapter.printPdf) {
          await adapter.printPdf(bytes, doc.fileName);
        } else {
          await printLayout(adapter, workspace, bytes);
        }
      } catch {
        workspace.getState().showNotice('The document could not be printed.');
      } finally {
        busy = false;
      }
    },
    [adapter, workspace],
  );
}

/**
 * Draws the pages of `bytes` as images in the print layout and opens the
 * print dialog. Resolves once the platform opened it; the layout stays
 * until the browser says printing is over.
 */
async function printLayout(
  adapter: PlatformAdapter,
  workspace: WorkspaceStore,
  bytes: Uint8Array,
): Promise<void> {
  const urls: string[] = [];
  let job: PrintJob | null = null;
  const cleanUp = () => {
    if (usePrintJob.getState().job === job) usePrintJob.getState().set(null);
    for (const url of urls) URL.revokeObjectURL(url);
  };
  try {
    const handle = await workspace.engine.open(bytes);
    try {
      const dpi = printDpi(handle.info.pageCount);
      const pages: PrintJob['pages'] = [];
      for (let index = 0; index < handle.info.pageCount; index += 1) {
        workspace
          .getState()
          .showNotice(`Preparing page ${index + 1} of ${handle.info.pageCount} for printing…`);
        const canvas = document.createElement('canvas');
        const completed = await handle.renderPage(index, canvas, {
          scale: dpi / 72,
          styleCanvas: false,
          intent: 'print',
        }).promise;
        if (!completed) throw new Error('Rendering was cancelled.');
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        const width = canvas.width;
        const height = canvas.height;
        canvas.width = 0;
        canvas.height = 0;
        if (!blob) throw new Error('A page could not be drawn.');
        const url = URL.createObjectURL(blob);
        urls.push(url);
        pages.push({ url, width, height });
        handle.releasePage(index);
      }
      job = { pages };
      usePrintJob.getState().set(job);
    } finally {
      await handle.destroy();
    }
    workspace.getState().dismissNotice();
    // Let the layout render and its images decode before the dialog opens.
    await nextFrame();
    await Promise.all(
      Array.from(document.querySelectorAll<HTMLImageElement>('#folio-print img')).map((image) =>
        image.decode().catch(() => undefined),
      ),
    );
  } catch (error) {
    cleanUp();
    throw error;
  }
  // Listening before the dialog opens: Chrome's blocks until it closes.
  // Some dialogs return while still open (Windows); either way the layout
  // stays until `afterprint` (or see PRINT_LAYOUT_TIMEOUT_MS).
  void new Promise<void>((resolve) => {
    const release = () => {
      clearTimeout(timeout);
      window.removeEventListener('afterprint', release);
      if (releaseLayout === release) releaseLayout = null;
      resolve();
    };
    const timeout = setTimeout(release, PRINT_LAYOUT_TIMEOUT_MS);
    window.addEventListener('afterprint', release);
    releaseLayout = release;
  }).then(cleanUp);
  try {
    await adapter.print();
  } catch (error) {
    releaseLayout?.();
    throw error;
  }
}
