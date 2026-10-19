import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import type { Rect, Rotation } from '@folio/document-model';
import { applyTransform, createPdfEngine, type PdfDocumentHandle } from '@folio/pdf-core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createNodeCanvas, nodeWorkerSrc, readFixture } from '../../../../tests/setup/fixtures';
import { TESSERACT_ASSET_DIR } from '../../vite/constants';
import { ocrAssets } from '../../vite/plugin';
import type { OcrLanguage } from './languages';
import {
  pixelBoxToPage,
  recognizePages,
  viewportRotation,
  type RecognitionProgress,
} from './recognize';
import { createTesseractRecognizer, type ImageWord, type Recognizer } from './tesseract';

type Hook = (this: unknown, ...args: unknown[]) => unknown;

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
let bundle: { root: string; assets: string } | null = null;
afterAll(async () => {
  engine.destroy();
  if (bundle) await rm(bundle.root, { recursive: true, force: true });
});

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

/** The OCR files as the apps ship them: written by the Vite plugin into a temporary folder. */
async function bundledAssets(): Promise<string> {
  if (!bundle) {
    const root = await mkdtemp(join(tmpdir(), 'folio-ocr-'));
    const plugin = ocrAssets();
    await (plugin.configResolved as Hook).call(undefined, { root, build: { outDir: 'dist' } });
    await (plugin.writeBundle as Hook).call(undefined);
    bundle = { root, assets: join(root, 'dist', TESSERACT_ASSET_DIR) };
  }
  return bundle.assets;
}

/**
 * Tesseract in a Node worker thread (its own worker script and core), with
 * the language data Folio bundles.
 */
const tesseract =
  (languages: readonly OcrLanguage[] = ['eng']) =>
  async (onProgress: (fraction: number) => void) =>
    createTesseractRecognizer(languages, { langPath: await bundledAssets() }, onProgress);

/** A page 600 × 800 pt whose crop box (the visible area) starts at (50, 60). */
async function croppedPage(): Promise<PdfDocumentHandle> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.addPage([600, 800]).setCropBox(50, 60, 500, 700);
  return engine.open(await pdf.save());
}

describe('page images and page space', () => {
  it('maps pixel boxes back into page space at every rotation, from the crop box', async () => {
    const handle = await croppedPage();
    const word: Rect = { x: 120, y: 300, width: 80, height: 14 };
    for (const rotation of ROTATIONS) {
      const viewport = await handle.getViewport(0, { scale: 300 / 72, rotation });
      expect(viewportRotation(viewport.transform), `${rotation}`).toBe(rotation);
      // Where the word shows in the image: its corners, drawn.
      const corners = [
        applyTransform(viewport.transform, 50 + word.x, 60 + word.y),
        applyTransform(viewport.transform, 50 + word.x + word.width, 60 + word.y + word.height),
      ];
      const box = {
        x0: Math.min(corners[0]![0], corners[1]![0]),
        y0: Math.min(corners[0]![1], corners[1]![1]),
        x1: Math.max(corners[0]![0], corners[1]![0]),
        y1: Math.max(corners[0]![1], corners[1]![1]),
      };
      const back = pixelBoxToPage(box, viewport);
      for (const side of ['x', 'y', 'width', 'height'] as const) {
        expect(back[side], `${rotation} ${side}`).toBeCloseTo(word[side], 6);
      }
    }
    // Upright at 300 dpi, the image's top-left pixel is the top-left of the visible area.
    const upright = await handle.getViewport(0, { scale: 300 / 72 });
    const corner = pixelBoxToPage({ x0: 0, y0: 0, x1: 300, y1: 150 }, upright);
    expect(corner.x).toBeCloseTo(0, 6);
    expect(corner.y).toBeCloseTo(700 - 36, 6);
    expect(corner.width).toBeCloseTo(72, 6);
    expect(corner.height).toBeCloseTo(36, 6);
    await handle.destroy();
  });
});

describe('recognizing pages with Tesseract', () => {
  it('reads scanned pages, upright and turned, and places the words where they show', async () => {
    const pdf = await PDFDocument.create();
    const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
    const width = (text: string) => helvetica.widthOfTextAtSize(text, 16);
    const handle = await engine.open(readFixture('scanned-pages.pdf'));
    const progress: RecognitionProgress[] = [];
    const [first, second] = await recognizePages(
      [
        { handle, pageIndex: 0, rotation: 0 },
        { handle, pageIndex: 1, rotation: 0 },
      ],
      {
        languages: ['eng'],
        createRecognizer: tesseract(),
        createCanvas: createNodeCanvas,
        onProgress: (entry) => progress.push(entry),
      },
    );
    await handle.destroy();
    const words = (page: typeof first) => page!.words.map((word) => word.text);
    expect(first!.languages).toBe('eng');
    expect(first!.rotation).toBe(0);
    expect(words(first)).toEqual(
      expect.arrayContaining(['lighthouse', 'keeper', 'ships', 'Recognized', 'searchable.']),
    );
    // "The lighthouse" was drawn from x = 72 on the baseline y = 640, in 16 pt
    // Helvetica: "The" stands on the baseline, the "g" goes 3.4 pt below it,
    // and capitals and ascenders reach 11.5 pt above it.
    const the = first!.words.find((word) => word.text === 'The')!;
    expect(the.box.x).toBeCloseTo(72, -0.5);
    expect(the.box.y).toBeCloseTo(640, -0.5);
    expect(the.box.y + the.box.height).toBeCloseTo(640 + 11.5, -0.5);
    const lighthouse = first!.words.find((word) => word.text === 'lighthouse')!;
    expect(lighthouse.box.x).toBeCloseTo(72 + width('The '), -0.5);
    expect(lighthouse.box.x + lighthouse.box.width).toBeCloseTo(72 + width('The lighthouse'), -0.5);
    expect(lighthouse.box.y).toBeCloseTo(640 - 3.4, -0.5);
    expect(lighthouse.line).toBe(first!.words.find((word) => word.text === 'keeper')!.line);

    // The second page is stored turned (/Rotate 90): read as shown, its text
    // runs up the page, from the baseline at x = 792 − 640.
    expect(second!.rotation).toBe(90);
    expect(words(second)).toEqual(expect.arrayContaining(['Kucing', 'tidur', 'mangga.']));
    const kucing = second!.words.find((word) => word.text === 'Kucing')!;
    expect(kucing.box.y).toBeCloseTo(72, -0.5);
    expect(kucing.box.y + kucing.box.height).toBeCloseTo(72 + width('Kucing'), -0.5);
    // From the descender of the "g" to the top of the "K".
    expect(kucing.box.x).toBeCloseTo(792 - 640 - 11.5, -0.5);
    expect(kucing.box.x + kucing.box.width).toBeCloseTo(792 - 640 + 3.4, -0.5);

    expect(progress[0]).toMatchObject({ stage: 'starting', done: 0, total: 2 });
    expect(progress.at(-1)).toMatchObject({ done: 2, total: 2, fraction: 1 });
    expect(progress.some((entry) => entry.stage === 'reading' && entry.done === 1)).toBe(true);
  }, 30_000);

  it('loads every bundled language together', async () => {
    const recognizer = await tesseract(['eng', 'ind', 'chi_sim', 'chi_tra'])(() => undefined);
    await recognizer.terminate();
  }, 30_000);
});

/** A recognizer that finds the given words (in image pixels) on every image. */
function fakeRecognizer(words: ImageWord[] | ((index: number) => Promise<ImageWord[]>)) {
  let images = 0;
  const recognizer: Recognizer & { terminated: boolean } = {
    terminated: false,
    recognize: vi.fn(async () => {
      const index = images;
      images += 1;
      return typeof words === 'function' ? words(index) : words;
    }),
    terminate: vi.fn(async () => {
      recognizer.terminated = true;
    }),
  };
  return recognizer;
}

/** Image pixels of a page-space box on an upright Letter page read at 300 dpi. */
const pixels = (box: Rect, line = 0, text = 'word'): ImageWord => {
  const scale = 300 / 72;
  return {
    text,
    line,
    confidence: 88.66,
    box: {
      x0: box.x * scale,
      y0: (792 - box.y - box.height) * scale,
      x1: (box.x + box.width) * scale,
      y1: (792 - box.y) * scale,
    },
  };
};

describe('recognizing pages', () => {
  it('starts one recognizer for all pages and stops it when done', async () => {
    const handle = await engine.open(readFixture('scanned-pages.pdf'));
    const recognizer = fakeRecognizer(async (index) =>
      index === 0 ? [pixels({ x: 72, y: 600, width: 40, height: 12 }, 0, 'Halo')] : [],
    );
    const createRecognizer = vi.fn(async () => recognizer);
    const results = await recognizePages(
      [
        { handle, pageIndex: 0, rotation: 0 },
        { handle, pageIndex: 1, rotation: 0 },
      ],
      { languages: ['ind', 'eng'], createRecognizer, createCanvas: createNodeCanvas },
    );
    await vi.waitFor(() => expect(recognizer.terminated).toBe(true));
    expect(createRecognizer).toHaveBeenCalledTimes(1);
    expect(recognizer.recognize).toHaveBeenCalledTimes(2);
    expect(results[0]).toEqual({
      version: 1,
      languages: 'ind+eng',
      rotation: 0,
      words: [
        { text: 'Halo', box: { x: 72, y: 600, width: 40, height: 12 }, confidence: 88.7, line: 0 },
      ],
    });
    // Nothing was found on the second page.
    expect(results[1]).toBeNull();
    await handle.destroy();
  });

  it('leaves out words the page already has as text, and renumbers lines', async () => {
    // "Folio fixture page 1" is real text at (54, 712), 24 pt.
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    const recognizer = fakeRecognizer([
      pixels({ x: 54, y: 708, width: 60, height: 22 }, 0, 'Folio'),
      pixels({ x: 54, y: 300, width: 50, height: 12 }, 3, 'stamped'),
      pixels({ x: 110, y: 300, width: 50, height: 12 }, 3, 'note'),
      pixels({ x: 54, y: 280, width: 50, height: 12 }, 4, ' '),
    ]);
    const [result] = await recognizePages([{ handle, pageIndex: 0, rotation: 0 }], {
      languages: ['eng'],
      createRecognizer: async () => recognizer,
      createCanvas: createNodeCanvas,
    });
    expect(result!.words.map((word) => [word.text, word.line])).toEqual([
      ['stamped', 0],
      ['note', 0],
    ]);
    await handle.destroy();
  });

  it('stops at once when cancelled, also in the middle of a page', async () => {
    const handle = await engine.open(readFixture('scanned-pages.pdf'));
    const recognizer = fakeRecognizer(() => new Promise<ImageWord[]>(() => undefined));
    const controller = new AbortController();
    const running = recognizePages([{ handle, pageIndex: 0, rotation: 0 }], {
      languages: ['eng'],
      createRecognizer: async () => recognizer,
      createCanvas: createNodeCanvas,
      onProgress: (progress) => {
        if (progress.stage === 'reading') controller.abort();
      },
      signal: controller.signal,
    });
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(recognizer.terminated).toBe(true));
    await handle.destroy();
  });

  it('reports a recognizer that cannot start', async () => {
    const handle = await engine.open(readFixture('scanned-pages.pdf'));
    await expect(
      recognizePages([{ handle, pageIndex: 0, rotation: 0 }], {
        languages: ['eng'],
        createRecognizer: () => Promise.reject(new Error('no worker')),
        createCanvas: createNodeCanvas,
      }),
    ).rejects.toThrow('no worker');
    await handle.destroy();
  });
});
