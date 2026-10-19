import type { PageId } from '@folio/document-model';
import type { PdfEngine, PdfPermissions } from '@folio/pdf-core';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import {
  createMemoryPlatformAdapter,
  type IncomingFile,
  type PlatformAdapter,
} from '@folio/platform-adapters';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context';
import { createUiStore } from '../store/ui';
import { createWorkspaceStore, type ExportRequest } from '../store/workspace';
import { PRINT_LAYOUT_TIMEOUT_MS, usePrint, usePrintJob } from './use-print';

const EXPORTED = new TextEncoder().encode('%PDF-1.7 exported');
const NO_PRINTING: PdfPermissions = {
  print: false,
  copy: true,
  modify: true,
  annotate: true,
  fillForms: true,
  assemble: true,
};

interface Setup {
  /** Prints PDFs itself, like the macOS desktop adapter. */
  printPdf?: PlatformAdapter['printPdf'];
  /** Opens the print dialog for the print layout. */
  openDialog?: PlatformAdapter['print'];
  permissions?: PdfPermissions;
}

async function setup({ printPdf, openDialog, permissions }: Setup = {}) {
  const memory = createMemoryPlatformAdapter();
  const adapter: PlatformAdapter = {
    ...memory.adapter,
    ...(printPdf && { printPdf }),
    ...(openDialog && { print: openDialog }),
  };
  const opened: Uint8Array[] = [];
  const engine: PdfEngine = {
    open: async (bytes) => {
      opened.push(bytes);
      return fakeDocumentHandle({ info: { pageCount: 3, permissions: permissions ?? null } });
    },
    destroy: () => undefined,
  };
  const workspace = createWorkspaceStore(engine);
  const ui = createUiStore(adapter.storage);
  const original = new TextEncoder().encode('%PDF-1.7 original');
  const file: IncomingFile = {
    name: 'Report.pdf',
    size: original.byteLength,
    origin: { kind: 'local-file', handle: null },
    read: async () => original,
  };
  await act(() => workspace.getState().openFiles([file]));
  opened.length = 0;
  const key = workspace.getState().documents[0]!.key;
  // Exporting is covered by the exporter's tests; here only what printing
  // asks for and does with the result matter.
  const exports: ExportRequest[] = [];
  workspace.setState({
    exportDocument: async (_key, options = {}) => {
      exports.push(options);
      return { bytes: EXPORTED, warnings: [] };
    },
  });
  const pages = workspace.getState().documents[0]!.editor!.model.pages;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkspaceProvider
      adapter={adapter}
      engine={engine}
      profile="desktop"
      stores={{ workspace, ui }}
    >
      {children}
    </WorkspaceProvider>
  );
  const { result } = renderHook(() => usePrint(), { wrapper });
  const start = (pageIds: PageId[] = [pages[0]!.id, pages[2]!.id], includeComments = true) =>
    result.current(key, { pageIds, includeComments });
  const print: typeof start = (...args) => act(() => start(...args));
  const notice = () => workspace.getState().notice?.message;
  return { start, print, memory, exports, opened, notice };
}

describe('printing', () => {
  beforeEach(() => {
    // jsdom draws nothing: every page becomes an empty image.
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob()),
    );
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:page-${(next += 1)}`);
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    // Let go of any layout a test left waiting for `afterprint`.
    window.dispatchEvent(new Event('afterprint'));
  });

  it('hands platforms that print PDFs exactly the exported pages', async () => {
    const printPdf = vi.fn(async (_bytes: Uint8Array, _name: string) => undefined);
    const { print, memory, exports, opened, notice } = await setup({ printPdf });
    await print(undefined, false);
    expect(exports).toEqual([
      {
        pageIds: [expect.any(String), expect.any(String)],
        flatten: false,
        withoutAnnotations: true,
        unprotected: true,
      },
    ]);
    expect(printPdf).toHaveBeenCalledTimes(1);
    expect(printPdf.mock.calls[0]![0]).toBe(EXPORTED);
    expect(printPdf.mock.calls[0]![1]).toBe('Report.pdf');
    // No pages drawn, no layout, no print of the window.
    expect(opened).toEqual([]);
    expect(usePrintJob.getState().job).toBeNull();
    expect(memory.printed).toBe(0);
    expect(notice()).toBeUndefined();
  });

  it('prints one PDF at a time while the platform’s dialog is open', async () => {
    let close = () => undefined as void;
    const printPdf = vi
      .fn<(bytes: Uint8Array, name: string) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            close = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    // Outside `act`: the first print stays pending while the second runs.
    const { start } = await setup({ printPdf });
    const first = start();
    await vi.waitFor(() => expect(printPdf).toHaveBeenCalledTimes(1));
    await start();
    expect(printPdf).toHaveBeenCalledTimes(1);
    close();
    await first;
    await start();
    expect(printPdf).toHaveBeenCalledTimes(2);
  });

  it('elsewhere lays the pages out as images until printing is over', async () => {
    const { print, memory, exports, opened } = await setup();
    await print();
    expect(exports[0]).toMatchObject({ flatten: true, withoutAnnotations: false });
    expect(opened).toEqual([EXPORTED]);
    expect(memory.printed).toBe(1);
    expect(usePrintJob.getState().job?.pages.map((page) => page.url)).toEqual([
      'blob:page-1',
      'blob:page-2',
      'blob:page-3',
    ]);
    // A dialog left open for long keeps its pages.
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(usePrintJob.getState().job).not.toBeNull();
    act(() => void window.dispatchEvent(new Event('afterprint')));
    await act(() => Promise.resolve());
    expect(usePrintJob.getState().job).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('lets go of a layout the platform never reported printed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { print, memory } = await setup();
    await print();
    // The next print replaces it.
    await print();
    expect(memory.printed).toBe(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(usePrintJob.getState().job?.pages[0]?.url).toBe('blob:page-4');
    // And at the latest, it goes after a long while.
    await act(() => vi.advanceTimersByTimeAsync(PRINT_LAYOUT_TIMEOUT_MS - 1));
    expect(usePrintJob.getState().job).not.toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(usePrintJob.getState().job).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(6);
  });

  it('respects the document’s print permission', async () => {
    const printPdf = vi.fn(async () => undefined);
    const { print, memory, exports, notice } = await setup({
      printPdf,
      permissions: NO_PRINTING,
    });
    await print();
    expect(notice()).toBe('The author of this document does not allow printing it.');
    expect(exports).toEqual([]);
    expect(printPdf).not.toHaveBeenCalled();
    expect(memory.printed).toBe(0);
  });

  it('says when the document could not be printed, and can print again', async () => {
    const printPdf = vi
      .fn<(bytes: Uint8Array, name: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The print dialog could not be opened.'))
      .mockResolvedValue(undefined);
    const { print, notice } = await setup({ printPdf });
    await print();
    expect(notice()).toBe('The document could not be printed.');
    await print();
    expect(printPdf).toHaveBeenCalledTimes(2);
  });

  it('clears the layout when the print dialog cannot open', async () => {
    const { print, notice } = await setup({
      openDialog: async () => {
        throw new Error('No printer dialog.');
      },
    });
    await print();
    expect(notice()).toBe('The document could not be printed.');
    await act(() => Promise.resolve());
    expect(usePrintJob.getState().job).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });
});
