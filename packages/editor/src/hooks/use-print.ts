import type { PageId } from '@folio/document-model';
import { useCallback } from 'react';
import { create } from 'zustand';
import { useWorkspaceContext } from '../context';

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

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** One print job at a time: the layout holds a single job. */
let printing = false;

/**
 * Prints pages of a document: writes them (with comments flattened if
 * wanted) to an in-memory PDF, draws each page at print resolution, shows
 * the images in a layout only print styles reveal, and opens the system's
 * print dialog. Nothing is written to disk.
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
      if (printing) return;
      printing = true;
      const urls: string[] = [];
      const cleanUp = () => {
        usePrintJob.getState().set(null);
        for (const url of urls) URL.revokeObjectURL(url);
        printing = false;
      };
      try {
        // An in-memory copy with the comments burnt in, or without them.
        const { bytes } = await state.exportDocument(key, {
          pageIds: options.pageIds,
          flatten: options.includeComments,
          withoutAnnotations: !options.includeComments,
          unprotected: true,
        });
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
          usePrintJob.getState().set({ pages });
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
        const afterPrint = new Promise<void>((resolve) =>
          window.addEventListener('afterprint', () => resolve(), { once: true }),
        );
        await adapter.print();
        // Some print dialogs return while still open (macOS sheets, Windows);
        // the layout stays until the browser says printing is over.
        await Promise.race([afterPrint, new Promise((resolve) => setTimeout(resolve, 60_000))]);
      } catch {
        workspace.getState().showNotice('The document could not be printed.');
      } finally {
        cleanUp();
      }
    },
    [adapter, workspace],
  );
}
