/**
 * Stand-ins for engine objects in UI tests that do not load PDF.js.
 * Test-only: imported as `@folio/pdf-core/testing`, never by app code.
 */
import { EMPTY_METADATA } from '@folio/document-model';
import type { PdfDocumentHandle, PdfDocumentInfo } from './engine';

export function fakeDocumentInfo(overrides: Partial<PdfDocumentInfo> = {}): PdfDocumentInfo {
  const pageCount = overrides.pageCount ?? overrides.pages?.length ?? 1;
  return {
    pageCount,
    exactPageCount: pageCount,
    pdfVersion: '1.7',
    metadata: EMPTY_METADATA,
    pages: Array.from({ length: pageCount }, () => ({
      size: { width: 612, height: 792 },
      rotation: 0 as const,
      userUnit: 1,
    })),
    encryption: 'none',
    permissions: null,
    isLinearized: false,
    forms: 'none',
    hasSignatures: false,
    ...overrides,
  };
}

/** A handle whose renders succeed at once and whose pages have no text. */
export function fakeDocumentHandle(
  overrides: Omit<Partial<PdfDocumentHandle>, 'info'> & { info?: Partial<PdfDocumentInfo> } = {},
): PdfDocumentHandle {
  const { info, ...rest } = overrides;
  return {
    info: fakeDocumentInfo(info),
    pagesComplete: true,
    pagesReady: Promise.resolve(),
    onPageInfo: () => () => undefined,
    renderPage: () => ({ promise: Promise.resolve(true), cancel: () => undefined }),
    getPageText: async () => ({ items: [] }),
    renderTextLayer: () => ({
      promise: Promise.resolve({ textDivs: [] }),
      cancel: () => undefined,
    }),
    getViewport: async (_pageIndex, { scale }) => ({
      width: 612 * scale,
      height: 792 * scale,
      transform: [scale, 0, 0, -scale, 0, 792 * scale],
      origin: { x: 0, y: 0 },
    }),
    getOutline: async () => [],
    getFormFields: async () => [],
    getFormWidgets: async () => [],
    setFormValues: () => [],
    saveFormValues: async () => null,
    releasePage: () => undefined,
    destroy: async () => undefined,
    ...rest,
  };
}
