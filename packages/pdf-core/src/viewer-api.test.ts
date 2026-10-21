import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { makeLargePdf, nodeWorkerSrc, readFixture } from '../../../tests/setup/fixtures';
import { createPdfEngine, EAGER_PAGE_COUNT } from './engine';
import type { PageInfoUpdate } from './page-info';
import { applyTransform } from './text';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

describe('page info streaming', () => {
  it('reads small documents completely before opening', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    expect(handle.info.exactPageCount).toBe(3);
    expect(handle.pagesComplete).toBe(true);
    await expect(handle.pagesReady).resolves.toBeUndefined();
    await handle.destroy();
  });

  it('opens large documents early and delivers the remaining page sizes', async () => {
    // Portrait pages, except every page after the eager batch whose index is a
    // multiple of 50, which is landscape: the estimate is right for most pages.
    const bytes = await makeLargePdf(300, (index) =>
      index >= EAGER_PAGE_COUNT && index % 50 === 0 ? [792, 612] : [612, 792],
    );
    const handle = await engine.open(bytes);
    expect(handle.info.pageCount).toBe(300);
    expect(handle.info.exactPageCount).toBe(EAGER_PAGE_COUNT);
    expect(handle.info.pages).toHaveLength(300);
    // Unread pages are estimated from the most common page read so far.
    expect(handle.info.pages[250]?.size).toEqual({ width: 612, height: 792 });

    const updates: PageInfoUpdate[] = [];
    handle.onPageInfo((batch) => updates.push(...batch));
    await handle.pagesReady;
    expect(handle.pagesComplete).toBe(true);
    // Only pages whose estimate was wrong are reported.
    expect(updates.map((update) => update.index).sort((a, b) => a - b)).toEqual([
      100, 150, 200, 250,
    ]);
    expect(updates.every((update) => update.info.size.width === 792)).toBe(true);
    await handle.destroy();
  });

  it('replays corrections made before a listener subscribed', async () => {
    const bytes = await makeLargePdf(300, (index) => (index >= 150 ? [842, 595] : [612, 792]));
    const handle = await engine.open(bytes);
    // Subscribe only after every page has been read.
    await handle.pagesReady;
    const updates: PageInfoUpdate[] = [];
    handle.onPageInfo((batch) => updates.push(...batch));
    expect(updates.map((update) => update.index)).toEqual(
      Array.from({ length: 150 }, (_, offset) => 150 + offset),
    );
    // Later subscribers get the same picture; nothing is reported twice.
    const again: PageInfoUpdate[] = [];
    handle.onPageInfo((batch) => again.push(...batch));
    expect(again).toEqual(updates);
    await handle.destroy();
  });

  it('reports a page read on demand before the background reaches it', async () => {
    const bytes = await makeLargePdf(400, (index) => (index === 399 ? [400, 400] : [612, 792]));
    const handle = await engine.open(bytes);
    const updates: PageInfoUpdate[] = [];
    handle.onPageInfo((batch) => updates.push(...batch));
    await handle.getViewport(399, { scale: 1 });
    expect(updates).toContainEqual({
      index: 399,
      info: { size: { width: 400, height: 400 }, rotation: 0, userUnit: 1 },
    });
    await handle.pagesReady;
    expect(updates.filter((update) => update.index === 399)).toHaveLength(1);
    await handle.destroy();
  });
});

describe('text extraction', () => {
  it('returns text runs in reading order', async () => {
    const handle = await engine.open(readFixture('outline-and-text.pdf'));
    const text = await handle.getPageText(2);
    const joined = text.items.map((item) => item.str).join(' ');
    expect(joined).toContain('Foxes visit the Café at dawn.');
    expect(joined).toContain('Only a naïve fox stays long.');
    const heading = text.items.find((item) => item.str === 'Section 1.1: Habitat');
    expect(heading?.transform[5]).toBeCloseTo(700, 0);
    await handle.destroy();
  });

  it('keeps separately drawn runs separate', async () => {
    const handle = await engine.open(readFixture('outline-and-text.pdf'));
    const strings = (await handle.getPageText(4)).items.map((item) => item.str);
    expect(strings.join('')).toContain('photosynthesis');
    await handle.destroy();
  });

  it('reads text where streams cannot be iterated with for await (WebKit)', async () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const iterate = Object.getOwnPropertyDescriptor(proto, Symbol.asyncIterator);
    delete proto[Symbol.asyncIterator];
    try {
      const handle = await engine.open(readFixture('outline-and-text.pdf'));
      const text = await handle.getPageText(2);
      expect(text.items.map((item) => item.str).join(' ')).toContain(
        'Foxes visit the Café at dawn.',
      );
      await handle.destroy();
    } finally {
      if (iterate) Object.defineProperty(proto, Symbol.asyncIterator, iterate);
    }
  });

  it('rejects pages that do not exist', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    await expect(handle.getPageText(3)).rejects.toThrow(RangeError);
    await handle.destroy();
  });
});

describe('outline', () => {
  it('resolves explicit, named and fit destinations', async () => {
    const handle = await engine.open(readFixture('outline-and-text.pdf'));
    const outline = await handle.getOutline();
    expect(outline.map((item) => [item.title, item.pageIndex, item.top])).toEqual([
      ['Introduction', 0, 792],
      ['Chapter 1: Foxes', 1, 720],
      ['Chapter 2: Plants', 4, null],
      ['Appendix', 5, 400],
      ['Folio on the web', null, null],
    ]);
    expect(outline[1]?.children).toEqual([
      expect.objectContaining({ title: 'Section 1.1: Habitat', pageIndex: 2, left: 72, top: 540 }),
    ]);
    expect(outline[4]?.url).toBe('https://example.com/folio');
    await handle.destroy();
  });

  it('is empty for documents without one', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    expect(await handle.getOutline()).toEqual([]);
    await handle.destroy();
  });
});

describe('viewports', () => {
  it('maps PDF points into the rotated, scaled page box', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    const upright = await handle.getViewport(0, { scale: 2 });
    expect([upright.width, upright.height]).toEqual([1224, 1584]);
    // PDF origin is bottom-left; the page box origin is top-left.
    expect(applyTransform(upright.transform, 0, 792)).toEqual([0, 0]);
    expect(applyTransform(upright.transform, 612, 0)).toEqual([1224, 1584]);

    const turned = await handle.getViewport(0, { scale: 1, rotation: 90 });
    expect([turned.width, turned.height]).toEqual([792, 612]);
    // After a quarter turn clockwise, the top-left corner of the page sits top-right.
    const [x, y] = applyTransform(turned.transform, 0, 792);
    expect([Math.round(x), Math.round(y)]).toEqual([792, 0]);
    await handle.destroy();
  });

  it('reports where page space starts: the corner of the crop box', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.addPage([600, 800]).setCropBox(50, 60, 500, 700);
    const handle = await engine.open(await pdf.save());
    const viewport = await handle.getViewport(0, { scale: 2, rotation: 90 });
    expect(viewport.origin).toEqual({ x: 50, y: 60 });
    // Turned a quarter clockwise, the lower-left corner shows top-left.
    expect(applyTransform(viewport.transform, 50, 60).map((value) => value + 0)).toEqual([0, 0]);
    expect(applyTransform(viewport.transform, 550, 760)).toEqual([1400, 1000]);
    const plain = await engine.open(readFixture('basic-3-pages.pdf'));
    expect((await plain.getViewport(0, { scale: 1 })).origin).toEqual({ x: 0, y: 0 });
    await Promise.all([handle.destroy(), plain.destroy()]);
  });

  it('combines the stored rotation with the view rotation', async () => {
    const handle = await engine.open(readFixture('rotated-pages.pdf'));
    const stored90 = await handle.getViewport(1, { scale: 1 });
    expect([stored90.width, stored90.height]).toEqual([792, 612]);
    const back = await handle.getViewport(1, { scale: 1, rotation: 270 });
    expect([back.width, back.height]).toEqual([612, 792]);
    await handle.destroy();
  });

  it('releases pages without failing for pages never loaded', async () => {
    const handle = await engine.open(readFixture('basic-3-pages.pdf'));
    handle.releasePage(2);
    handle.releasePage(99);
    await handle.getPageText(1);
    handle.releasePage(1);
    await expect(handle.getPageText(1)).resolves.toBeDefined();
    await handle.destroy();
  });
});
