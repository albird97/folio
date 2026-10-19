import type { PdfDocumentHandle } from './engine';
import { pageTextToString, type PageText } from './text';
import { createZip } from './zip';

export interface ProgressOptions {
  /** Called after each page with the number of pages done so far. */
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

export interface ExtractTextOptions extends ProgressOptions {
  /** Pages to read, 0-based, in the order given. Default: every page. */
  pageIndexes?: readonly number[];
}

/**
 * The text of pages as plain text, page after page with a blank line between
 * pages, each read by `read` (pages from several files, pages with
 * recognized text).
 */
export async function joinPageTexts<Page>(
  pages: readonly Page[],
  read: (page: Page) => Promise<PageText>,
  options: ProgressOptions = {},
): Promise<string> {
  const texts: string[] = [];
  for (const [done, page] of pages.entries()) {
    options.signal?.throwIfAborted();
    texts.push(pageTextToString(await read(page)));
    options.onProgress?.(done + 1, pages.length);
  }
  return texts.join('\n\n').trim();
}

/**
 * The text of a document as plain text, page after page with a blank line
 * between pages. Only text the PDF contains is found: scanned pages without
 * a text layer give nothing (that needs OCR).
 */
export async function extractText(
  handle: PdfDocumentHandle,
  options: ExtractTextOptions = {},
): Promise<string> {
  const indexes =
    options.pageIndexes ?? Array.from({ length: handle.info.pageCount }, (_, index) => index);
  return joinPageTexts(indexes, (index) => handle.getPageText(index), options);
}

export type PageImageFormat = 'png' | 'jpeg';

export interface PageImageOptions {
  /** Pixels per inch (72 points). */
  dpi: number;
  format: PageImageFormat;
  /** JPEG quality between 0 and 1. */
  quality?: number;
  /** Largest image to make, in pixels; larger pages are drawn at a lower resolution. */
  maxPixels?: number;
  /** Where canvases come from (tests, workers). */
  createCanvas?: () => HTMLCanvasElement;
}

export interface PageImage {
  blob: Blob;
  width: number;
  height: number;
}

/** 6000 × 6000 pixels: about 144 MB while drawing, within every browser's canvas limits. */
const DEFAULT_MAX_IMAGE_PIXELS = 36_000_000;

/** Draws a page as a PNG or JPEG image, the way it shows on screen. */
export async function renderPageImage(
  handle: PdfDocumentHandle,
  pageIndex: number,
  options: PageImageOptions,
): Promise<PageImage> {
  const canvas = options.createCanvas?.() ?? document.createElement('canvas');
  try {
    const completed = await handle.renderPage(pageIndex, canvas, {
      scale: options.dpi / 72,
      devicePixelRatio: 1,
      maxCanvasPixels: options.maxPixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      styleCanvas: false,
    }).promise;
    if (!completed) throw new Error('Drawing the page was cancelled.');
    const type = options.format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(
        resolve,
        type,
        options.format === 'jpeg' ? (options.quality ?? 0.9) : undefined,
      ),
    );
    if (!blob) throw new Error('The page could not be turned into an image.');
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    handle.releasePage(pageIndex);
  }
}

/** "Report" page 7 of 120 → "Report-page-007.png". */
export function pageImageName(
  baseName: string,
  pageNumber: number,
  pageCount: number,
  format: PageImageFormat,
): string {
  const digits = String(pageCount).length;
  return `${baseName}-page-${String(pageNumber).padStart(digits, '0')}.${format === 'png' ? 'png' : 'jpg'}`;
}

/**
 * Page images are made in memory before they are zipped (and saving needs
 * the whole archive at once); this keeps that bounded.
 */
export const MAX_IMAGE_PAGES = 300;

export interface PageImagesOptions extends PageImageOptions, ProgressOptions {
  /**
   * The pages to draw, in order: their index in the handle and the page
   * number their image is named after.
   */
  pages: ReadonlyArray<{ index: number; number: number }>;
  /** Pages in the whole document, for the digits of page numbers in names. */
  pageCount: number;
  /** The document's name without ".pdf", which the files are named after. */
  baseName: string;
}

/** A file made from a document: a page image or a ZIP archive of them. */
export interface PageImagesFile {
  name: string;
  bytes: Uint8Array;
  kind: PageImageFormat | 'zip';
}

/**
 * Draws pages as PNG or JPEG images: one page gives one image
 * ("Report-page-3.png"), several a ZIP archive of them ("Report
 * (images).zip"). At most {@link MAX_IMAGE_PAGES} pages at a time.
 */
export async function exportPageImages(
  handle: PdfDocumentHandle,
  options: PageImagesOptions,
): Promise<PageImagesFile> {
  const { pages } = options;
  if (pages.length === 0) throw new Error('There are no pages to draw.');
  if (pages.length > MAX_IMAGE_PAGES) {
    throw new Error(`Choose up to ${MAX_IMAGE_PAGES} pages at a time.`);
  }
  const entries: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const [done, page] of pages.entries()) {
    options.signal?.throwIfAborted();
    const image = await renderPageImage(handle, page.index, options);
    entries.push({
      name: pageImageName(options.baseName, page.number, options.pageCount, options.format),
      bytes: new Uint8Array(await image.blob.arrayBuffer()),
    });
    options.onProgress?.(done + 1, pages.length);
  }
  options.signal?.throwIfAborted();
  const [only] = entries;
  if (entries.length === 1 && only) return { ...only, kind: options.format };
  return { name: `${options.baseName} (images).zip`, bytes: createZip(entries), kind: 'zip' };
}
