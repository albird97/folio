import type { PdfDocumentHandle } from './engine';
import { pageTextToString } from './text';

export interface ExtractTextOptions {
  /** Pages to read, 0-based, in the order given. Default: every page. */
  pageIndexes?: readonly number[];
  /** Called after each page with the number of pages read so far. */
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
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
  const pages: string[] = [];
  for (const [done, index] of indexes.entries()) {
    options.signal?.throwIfAborted();
    pages.push(pageTextToString(await handle.getPageText(index)));
    options.onProgress?.(done + 1, indexes.length);
  }
  return pages.join('\n\n').trim();
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
