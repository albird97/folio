import { afterAll, describe, expect, it } from 'vitest';
import { nodeWorkerSrc, readFixture } from '../../../tests/setup/fixtures';
import { createPdfEngine } from './engine';
import { extractText, pageImageName } from './extract';
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

  it('names page images so they sort in page order', () => {
    expect(pageImageName('Report', 7, 120, 'png')).toBe('Report-page-007.png');
    expect(pageImageName('Report', 3, 9, 'jpeg')).toBe('Report-page-3.jpg');
  });
});
