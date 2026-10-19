import { afterAll, describe, expect, it } from 'vitest';
import { createNodeCanvas, nodeWorkerSrc, readFixture } from '../../../tests/setup/fixtures';
import { createPdfEngine } from './engine';
import {
  exportPageImages,
  extractText,
  joinPageTexts,
  MAX_IMAGE_PAGES,
  pageImageName,
} from './extract';
import { pageTextToString } from './text';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

describe('text extraction', () => {
  it('joins runs into lines and pages into paragraphs', async () => {
    const handle = await engine.open(readFixture('outline-and-text.pdf'));
    const progress: number[] = [];
    const text = await extractText(handle, { onProgress: (done) => progress.push(done) });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    const pages = text.split('\n\n');
    expect(pages).toHaveLength(6);
    expect(pages[0]).toBe(
      'Introduction\nThe Quick brown fox opens this guide.\nIt is a field guide.',
    );
    // Accented text survives, and words drawn in pieces read as one.
    expect(pages[2]).toContain('Foxes visit the Café at dawn.\nOnly a naïve fox stays long.');
    expect(pages[4]).toContain('photosynthesis turns light into sugar.');
    await handle.destroy();
  });

  it('reads chosen pages in the order given and stops when cancelled', async () => {
    const handle = await engine.open(readFixture('outline-and-text.pdf'));
    const text = await extractText(handle, { pageIndexes: [5, 0] });
    expect(text.split('\n\n').map((page) => page.split('\n')[0])).toEqual([
      'Appendix',
      'Introduction',
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(extractText(handle, { signal: controller.signal })).rejects.toThrow();
    await handle.destroy();
  });

  it('drops trailing spaces at line ends', () => {
    expect(
      pageTextToString({
        items: [
          { str: 'one  ', hasEOL: true, transform: [], width: 0, height: 0 },
          { str: 'two', hasEOL: false, transform: [], width: 0, height: 0 },
          { str: ' ', hasEOL: true, transform: [], width: 0, height: 0 },
        ],
      }),
    ).toBe('one\ntwo');
  });

  it('reads pages of any kind through a reader', async () => {
    const texts: Record<string, string[]> = { a: ['first line', 'second  '], b: [], c: ['last'] };
    const progress: Array<[number, number]> = [];
    const text = await joinPageTexts(
      ['a', 'b', 'c'],
      async (key) => ({
        items: texts[key]!.map((str) => ({
          str,
          hasEOL: true,
          transform: [],
          width: 0,
          height: 0,
        })),
      }),
      { onProgress: (done, total) => progress.push([done, total]) },
    );
    expect(text).toBe('first line\nsecond\n\n\n\nlast');
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('names page images so they sort in page order', () => {
    expect(pageImageName('Report', 7, 120, 'png')).toBe('Report-page-007.png');
    expect(pageImageName('Report', 3, 9, 'jpeg')).toBe('Report-page-3.jpg');
  });
});

describe('page images', () => {
  const latin1 = new TextDecoder('latin1');

  it('draws one page as an image file named after its page number', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    const png = await exportPageImages(handle, {
      pages: [{ index: 1, number: 2 }],
      pageCount: 3,
      baseName: 'Report',
      dpi: 36,
      format: 'png',
      createCanvas: createNodeCanvas,
    });
    expect(png.name).toBe('Report-page-2.png');
    expect(png.kind).toBe('png');
    expect([...png.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpeg = await exportPageImages(handle, {
      pages: [{ index: 0, number: 1 }],
      pageCount: 3,
      baseName: 'Report',
      dpi: 36,
      format: 'jpeg',
      quality: 0.7,
      createCanvas: createNodeCanvas,
    });
    expect(jpeg).toMatchObject({ name: 'Report-page-1.jpg', kind: 'jpeg' });
    expect([...jpeg.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    await handle.destroy();
  });

  it('puts several pages into one ZIP archive, and stops when cancelled', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    const progress: number[] = [];
    const zip = await exportPageImages(handle, {
      // Pages of an exported selection keep the numbers they have in the document.
      pages: [
        { index: 0, number: 2 },
        { index: 1, number: 12 },
      ],
      pageCount: 12,
      baseName: 'Report',
      dpi: 24,
      format: 'png',
      createCanvas: createNodeCanvas,
      onProgress: (done) => progress.push(done),
    });
    expect(zip.name).toBe('Report (images).zip');
    expect(zip.kind).toBe('zip');
    expect(latin1.decode(zip.bytes.subarray(0, 4))).toBe('PK\x03\x04');
    const content = latin1.decode(zip.bytes);
    expect(content).toContain('Report-page-02.png');
    expect(content).toContain('Report-page-12.png');
    expect(progress).toEqual([1, 2]);

    const controller = new AbortController();
    const cancelled = exportPageImages(handle, {
      pages: [
        { index: 0, number: 1 },
        { index: 1, number: 2 },
      ],
      pageCount: 3,
      baseName: 'Report',
      dpi: 24,
      format: 'png',
      createCanvas: createNodeCanvas,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(cancelled).rejects.toThrow();
    await handle.destroy();
  });

  it('refuses no pages and more pages than it keeps in memory', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    const request = { pageCount: 3, baseName: 'R', dpi: 72, format: 'png' as const };
    await expect(exportPageImages(handle, { ...request, pages: [] })).rejects.toThrow(/no pages/);
    const many = Array.from({ length: MAX_IMAGE_PAGES + 1 }, () => ({ index: 0, number: 1 }));
    await expect(exportPageImages(handle, { ...request, pages: many })).rejects.toThrow(
      `Choose up to ${MAX_IMAGE_PAGES} pages at a time.`,
    );
    await handle.destroy();
  });
});
