/// <reference types="vite/client" />
import { TESSERACT_ASSET_DIR } from '../../vite/constants';
import type { OcrLanguage } from './languages';

/** A word found in an image. */
export interface ImageWord {
  text: string;
  /** In pixels from the image's top-left corner; x1 and y1 are exclusive. */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** 0–100. */
  confidence: number;
  /** The word's line, numbered in reading order. */
  line: number;
}

/** Reads text in images, one at a time, in a worker. */
export interface Recognizer {
  /** The words in a PNG image, in reading order. */
  recognize(png: Uint8Array): Promise<ImageWord[]>;
  /** Stops the worker at once, also in the middle of an image. */
  terminate(): Promise<void>;
}

/** Where Tesseract.js finds its worker script, cores and language data. */
export interface TesseractPaths {
  workerPath?: string;
  corePath?: string;
  langPath: string;
}

/**
 * The files bundled with a Vite-built page (desktop webview or extension
 * page): they load from the app's own origin, never from the network.
 */
export function bundledTesseractPaths(): TesseractPaths {
  const base = new URL(
    `${import.meta.env.BASE_URL}${TESSERACT_ASSET_DIR}/`,
    globalThis.location.href,
  ).href;
  return { workerPath: `${base}worker.min.js`, corePath: base, langPath: base };
}

/** Loading the core and the language data takes seconds; anything longer has failed. */
const START_TIMEOUT_MS = 60_000;

export class RecognizerError extends Error {
  override readonly name = 'RecognizerError';
}

/**
 * Starts Tesseract (LSTM engine) in a worker for the given languages. Its
 * language data is used as bundled and never cached elsewhere (IndexedDB).
 * `onProgress` hears how far the current image is read (0–1).
 */
export async function createTesseractRecognizer(
  languages: readonly OcrLanguage[],
  paths: TesseractPaths,
  onProgress?: (fraction: number) => void,
): Promise<Recognizer> {
  const { createWorker, OEM } = await import('tesseract.js');
  // Tesseract.js reports some failures (language data that cannot be read)
  // only to the error handler and then never settles; without a handler it
  // throws them where nothing can catch them.
  let fail: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RecognizerError('Text recognition did not start.')),
      START_TIMEOUT_MS,
    );
  });
  const starting = createWorker(
    [...languages],
    OEM.LSTM_ONLY,
    {
      ...paths,
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
      logger: (message) => {
        if (message.status === 'recognizing text') onProgress?.(message.progress);
      },
      errorHandler: () => fail(new RecognizerError('Text recognition failed.')),
    },
    // The Chinese models ask for their vertical-text models too, which are not
    // bundled: looking for them fails, takes time and keeps a second Chinese
    // model from being used.
    'tessedit_load_sublangs ',
  );
  let worker: Awaited<typeof starting>;
  try {
    worker = await Promise.race([starting, failed, timeout]);
  } catch (error) {
    // A worker that starts after all must not keep running.
    void starting.then((late) => late.terminate()).catch(() => undefined);
    throw error instanceof RecognizerError
      ? error
      : new RecognizerError('Text recognition could not start.');
  } finally {
    clearTimeout(timer);
  }
  return {
    async recognize(png) {
      // Tesseract.js takes an encoded image's bytes as they are, in browsers
      // and in Node, though its types leave typed arrays out.
      const image = png as unknown as Parameters<typeof worker.recognize>[0];
      let data;
      try {
        ({ data } = await worker.recognize(image, {}, { text: false, blocks: true }));
      } catch {
        // Its errors are strings from inside the engine; this one says what matters.
        throw new RecognizerError('Text recognition failed.');
      }
      const words: ImageWord[] = [];
      let line = 0;
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const row of paragraph.lines) {
            for (const word of row.words) {
              words.push({
                text: word.text,
                box: word.bbox,
                confidence: word.confidence,
                line,
              });
            }
            if (row.words.length > 0) line += 1;
          }
        }
      }
      return words;
    },
    async terminate() {
      await worker.terminate();
    },
  };
}
