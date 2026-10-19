import {
  MAX_RECOGNIZED_WORD_LENGTH,
  MAX_RECOGNIZED_WORDS,
  RECOGNIZED_TEXT_VERSION,
  type RecognizedTextData,
  type RecognizedWord,
  type Rect,
  type Rotation,
} from '@folio/document-model';
import {
  applyTransform,
  type PageText,
  type PageViewportInfo,
  type PdfDocumentHandle,
} from '@folio/pdf-core';
import { invertTransform } from '../viewer/geometry';
import type { OcrLanguage } from './languages';
import type { ImageWord, Recognizer } from './tesseract';

/** Pages are read at about 300 dpi, the resolution OCR engines are tuned for… */
const RECOGNITION_DPI = 300;
/** …in images of at most 16.7 megapixels (larger pages are read at a lower resolution). */
const MAX_RECOGNITION_PIXELS = 4096 * 4096;
/** A recognized word is left out when this much of it overlaps the page's own text. */
const OWN_TEXT_OVERLAP = 0.5;

/** A page to read: a page of a source file, turned as it is saved, so its text is upright. */
export interface PageToRecognize {
  /** The engine document of the page's file. */
  handle: PdfDocumentHandle;
  /** The page in that file, from 0. */
  pageIndex: number;
  /** Rotation the user added on top of the page's own (/Rotate). */
  rotation: Rotation;
}

export interface RecognitionProgress {
  /** Pages finished. */
  done: number;
  total: number;
  /** Starting the recognizer, or reading a page. */
  stage: 'starting' | 'reading';
  /** How far the whole run is, 0–1. */
  fraction: number;
}

export interface RecognizeOptions {
  languages: readonly OcrLanguage[];
  /** Starts the recognizer; it reports how far it is through the image it reads (0–1). */
  createRecognizer(onProgress: (fraction: number) => void): Promise<Recognizer>;
  /** Where page images are drawn (Node tests); a new canvas element by default. */
  createCanvas?: () => HTMLCanvasElement;
  onProgress?(progress: RecognitionProgress): void;
  signal?: AbortSignal;
}

/**
 * Maps a box in the pixels of a page image drawn with `viewport` (from the
 * image's top-left corner) back into page space: the inverse of the drawing
 * transform, then from user space to the corner of the visible area.
 */
export function pixelBoxToPage(box: ImageWord['box'], viewport: PageViewportInfo): Rect {
  const inverse = invertTransform(viewport.transform);
  const [ax, ay] = applyTransform(inverse, box.x0, box.y0);
  const [bx, by] = applyTransform(inverse, box.x1, box.y1);
  return {
    x: Math.min(ax, bx) - viewport.origin.x,
    y: Math.min(ay, by) - viewport.origin.y,
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/** The clockwise rotation a viewport shows its page at (its transform is a quarter-turn matrix). */
export function viewportRotation(transform: readonly number[]): Rotation {
  const [a = 1, b = 0] = transform;
  if (Math.abs(a) >= Math.abs(b)) return a > 0 ? 0 : 180;
  return b > 0 ? 90 : 270;
}

/**
 * Where the page's own text runs are, in page space: each run's box from a
 * little below its baseline to its full height, for telling recognized words
 * that repeat them apart.
 */
function ownTextBoxes(text: PageText, origin: { x: number; y: number }): Rect[] {
  const boxes: Rect[] = [];
  for (const item of text.items) {
    if (item.str.trim() === '') continue;
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
    const along = Math.hypot(a, b) || 1;
    const up = Math.hypot(c, d) || 1;
    const ux = (a / along) * item.width;
    const uy = (b / along) * item.width;
    const vx = (c / up) * item.height;
    const vy = (d / up) * item.height;
    const corners = [-0.25, 1].flatMap((share) => [
      [e + vx * share, f + vy * share],
      [e + ux + vx * share, f + uy + vy * share],
    ]);
    const xs = corners.map(([x]) => x!);
    const ys = corners.map(([, y]) => y!);
    boxes.push({
      x: Math.min(...xs) - origin.x,
      y: Math.min(...ys) - origin.y,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    });
  }
  return boxes;
}

/** How much of `box` lies inside `other`, from 0 to 1. */
function overlapShare(box: Rect, other: Rect): number {
  const width = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
  const height = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
  return width <= 0 || height <= 0 ? 0 : (width * height) / (box.width * box.height);
}

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Turns the words found in a page image into recognized text: boxes in page
 * space, without words that repeat text the page already has (so its text is
 * never doubled), lines numbered again from 0. Null when nothing is left.
 */
function recognizedText(
  words: readonly ImageWord[],
  viewport: PageViewportInfo,
  ownText: PageText,
  languages: readonly OcrLanguage[],
): RecognizedTextData | null {
  const own = ownTextBoxes(ownText, viewport.origin);
  const kept: RecognizedWord[] = [];
  let line = -1;
  let sourceLine: number | null = null;
  for (const word of words) {
    const text = Array.from(word.text.trim()).slice(0, MAX_RECOGNIZED_WORD_LENGTH).join('');
    if (text === '') continue;
    const raw = pixelBoxToPage(word.box, viewport);
    const box = {
      x: round(raw.x, 2),
      y: round(raw.y, 2),
      width: round(raw.width, 2),
      height: round(raw.height, 2),
    };
    if (box.width <= 0 || box.height <= 0) continue;
    if (own.some((other) => overlapShare(box, other) > OWN_TEXT_OVERLAP)) continue;
    if (word.line !== sourceLine) {
      sourceLine = word.line;
      line += 1;
    }
    kept.push({
      text,
      box,
      confidence: round(Math.min(100, Math.max(0, word.confidence)), 1),
      line,
    });
    if (kept.length === MAX_RECOGNIZED_WORDS) break;
  }
  if (kept.length === 0) return null;
  return {
    version: RECOGNIZED_TEXT_VERSION,
    languages: languages.join('+'),
    rotation: viewportRotation(viewport.transform),
    words: kept,
  };
}

/**
 * Draws a page as it is saved (turned, so its text is upright) without
 * Folio's annotations, as a PNG at about 300 dpi; and the viewport it was
 * drawn with.
 */
async function drawPage(
  page: PageToRecognize,
  createCanvas: () => HTMLCanvasElement,
): Promise<{ png: Uint8Array; viewport: PageViewportInfo }> {
  const { handle, pageIndex, rotation } = page;
  const size = await handle.getViewport(pageIndex, { scale: 1, rotation });
  const scale = Math.min(
    RECOGNITION_DPI / 72,
    Math.sqrt(MAX_RECOGNITION_PIXELS / (size.width * size.height)),
  );
  const viewport = await handle.getViewport(pageIndex, { scale, rotation });
  const canvas = createCanvas();
  try {
    const completed = await handle.renderPage(pageIndex, canvas, {
      scale,
      rotation,
      devicePixelRatio: 1,
      // The scale above keeps the image within its own limit.
      maxCanvasPixels: Number.POSITIVE_INFINITY,
      styleCanvas: false,
    }).promise;
    if (!completed) throw new Error('Drawing the page was cancelled.');
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The page could not be turned into an image.');
    return { png: new Uint8Array(await blob.arrayBuffer()), viewport };
  } finally {
    // Gives the canvas memory back at once: one page at a time is held.
    canvas.width = 0;
    canvas.height = 0;
    handle.releasePage(pageIndex);
  }
}

/** Settles with `promise`, or rejects as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Recognizes the text of pages, one at a time to bound memory, with one
 * recognizer started when needed and stopped when done (or cancelled: an
 * aborted signal stops it at once, also in the middle of a page). Returns
 * one result per page, in order: null where no text was found.
 */
export async function recognizePages(
  pages: readonly PageToRecognize[],
  options: RecognizeOptions,
): Promise<Array<RecognizedTextData | null>> {
  const { signal } = options;
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));
  const results: Array<RecognizedTextData | null> = [];
  let starting: Promise<Recognizer> | null = null;
  const report = (stage: RecognitionProgress['stage'], within: number) =>
    options.onProgress?.({
      done: results.length,
      total: pages.length,
      stage,
      fraction: pages.length === 0 ? 1 : (results.length + within) / pages.length,
    });
  try {
    for (const page of pages) {
      signal?.throwIfAborted();
      if (!starting) {
        report('starting', 0);
        // The recognizer loads while the first page is drawn.
        starting = options.createRecognizer((fraction) => report('reading', fraction));
        starting.catch(() => undefined);
      }
      const [image, ownText] = await unlessAborted(
        Promise.all([
          drawPage(page, createCanvas),
          // Text that cannot be read is no text to keep apart from.
          page.handle.getPageText(page.pageIndex).catch((): PageText => ({ items: [] })),
        ]),
        signal,
      );
      const recognizer = await unlessAborted(starting, signal);
      report('reading', 0);
      const words = await unlessAborted(recognizer.recognize(image.png), signal);
      results.push(recognizedText(words, image.viewport, ownText, options.languages));
    }
    report('reading', 0);
    return results;
  } finally {
    // Also a recognizer still starting: it is stopped once it has.
    void starting?.then((recognizer) => recognizer.terminate()).catch(() => undefined);
  }
}
