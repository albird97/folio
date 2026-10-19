import {
  applyOperation,
  createDocumentModel,
  newAnnotationId,
  newPageId,
  pageStamps,
  type DocumentModel,
  type DocumentStamps,
  type PageNumberStamp,
  type SourceId,
  type WatermarkStamp,
} from '@folio/document-model';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
} from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PASSWORD,
  nodeWorkerSrc,
  qpdfCheck,
  readFixture,
  type FixtureName,
} from '../../../../tests/setup/fixtures';
import { toSourceDescriptor } from '../descriptor';
import { createPdfEngine } from '../engine';
import { sha256Hex } from '../hash';
import { exportPdf, originalSourceId, type ExportSource } from './export';

/*
 * Page numbers and watermarks drawn into saved pages. Every result is opened
 * again with PDF.js, which must find the text where the shared layout puts
 * it, and checked with qpdf.
 */

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const NOW = new Date('2026-03-01T12:00:00Z');

const NUMBERS: PageNumberStamp = {
  format: 'Page {page} of {total}',
  position: 'bottom-center',
  fontFamily: 'sans',
  fontSize: 10,
  color: '#1f2328',
  margin: 36,
  startNumber: 1,
  pages: { from: 1, to: null },
};

const WATERMARK: WatermarkStamp = {
  text: 'CONFIDENTIAL',
  position: 'center',
  fontFamily: 'serif',
  fontSize: 72,
  color: '#e03131',
  opacity: 0.25,
  angle: 45,
  layer: 'under',
  margin: 36,
  pages: { from: 1, to: null },
};

async function modelFrom(bytes: Uint8Array, fileName: string, password?: string) {
  const handle = await engine.open(bytes, password === undefined ? {} : { password });
  const model = createDocumentModel(
    toSourceDescriptor(handle.info, {
      fileName,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      origin: { kind: 'generated' },
    }),
  );
  await handle.destroy();
  return model;
}

/** A fixture with stamps set through the model's own operation. */
async function stamped(
  name: FixtureName | Uint8Array,
  stamps: Partial<DocumentStamps>,
  password?: string,
) {
  const bytes = typeof name === 'string' ? readFixture(name) : name;
  const opened = await modelFrom(bytes, typeof name === 'string' ? name : 'made.pdf', password);
  const model = applyOperation(opened, { type: 'stamps/set', stamps }).model;
  const sources = new Map<SourceId, ExportSource>([
    [originalSourceId(model)!, password === undefined ? { bytes } : { bytes, password }],
  ]);
  return { model, sources };
}

interface TextItem {
  str: string;
  transform: number[];
}

/** Each page's text items as PDF.js reads them. */
async function textOf(bytes: Uint8Array, password?: string): Promise<TextItem[][]> {
  const task = getDocument({
    data: bytes.slice(),
    ...(password === undefined ? {} : { password }),
  });
  const doc = await task.promise;
  const pages: TextItem[][] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const content = await (await doc.getPage(number)).getTextContent();
    pages.push(
      content.items.flatMap((item) =>
        'str' in item && item.str !== '' ? [{ str: item.str, transform: item.transform }] : [],
      ),
    );
  }
  await task.destroy();
  return pages;
}

const pageText = (items: readonly TextItem[]) => items.map((item) => item.str).join(' ');

const latin1 = new TextDecoder('latin1');

/** Hex strings (how standard-font text is written) decoded in place. */
const withHexDecoded = (content: string) =>
  content.replace(/<([0-9A-Fa-f\s]+)>/g, (_, hex: string) => {
    const digits = hex.replace(/\s/g, '');
    let out = '';
    for (let i = 0; i + 1 < digits.length; i += 2) {
      out += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2), 16));
    }
    return out;
  });

/** The decoded streams of a written page's /Contents, in order. */
async function contentStreams(bytes: Uint8Array, pageIndex: number): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex).node;
  const contents = page.lookup(PDFName.of('Contents'));
  const refs =
    contents instanceof PDFArray ? contents.asArray() : [page.get(PDFName.of('Contents'))];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) throw new Error('Expected a content stream.');
    return withHexDecoded(latin1.decode(decodePDFRawStream(stream).decode()));
  });
}

/** `qpdf --check` must pass; qpdf is required on CI and optional locally. */
async function expectValidPdf(bytes: Uint8Array, password?: string) {
  const result = await qpdfCheck(bytes, password);
  if (!result) {
    expect(process.env.CI, 'qpdf must be installed on CI').toBeFalsy();
    return;
  }
  expect(result.ok, result.output).toBe(true);
}

/**
 * Checks that PDF.js finds the stamp's text where the layout puts it: the
 * start of its baseline, its direction and its size (PDF.js reports the text
 * matrix times the font size, in user space, which starts `origin` away from
 * the corner of the visible page area).
 */
function expectAt(
  item: TextItem | undefined,
  model: DocumentModel,
  position: number,
  kind: keyof DocumentStamps,
  origin = { x: 0, y: 0 },
) {
  const page = model.pages[position]!;
  const layout = pageStamps(page, model.stamps, position, model.pages.length).find(
    (stamp) => stamp.kind === kind,
  )!;
  expect(item, `${kind} on page ${position + 1}`).toBeDefined();
  const [a, b, c, d, e, f] = layout.matrix;
  const expected = [a, b, c, d]
    .map((value) => value * layout.fontSize)
    .concat([e + origin.x, f + origin.y]);
  item!.transform.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 2));
}

describe('exportPdf: page numbers and watermarks', () => {
  it('draws them into every page, where the layout puts them', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      pageNumbers: NUMBERS,
      watermark: WATERMARK,
    });
    const { bytes, warnings } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    expect(warnings).toEqual([]);
    const pages = await textOf(bytes);
    expect(pageText(pages[1]!)).toContain('Page 2 of 3');
    expect(pageText(pages[1]!)).toContain('CONFIDENTIAL');
    pages.forEach((items, position) => {
      expect(pageText(items)).toContain(`Folio fixture page ${position + 1}`);
      expectAt(
        items.find((item) => item.str === `Page ${position + 1} of 3`),
        model,
        position,
        'pageNumbers',
      );
      expectAt(
        items.find((item) => item.str === 'CONFIDENTIAL'),
        model,
        position,
        'watermark',
      );
    });
    await expectValidPdf(bytes);
  });

  it('keeps page numbers level on pages shown turned, whatever their /Rotate', async () => {
    const { model, sources } = await stamped('rotated-pages.pdf', {
      pageNumbers: { ...NUMBERS, position: 'top-right' },
      watermark: { ...WATERMARK, layer: 'over' },
    });
    expect(model.pages.map((page) => page.sourceRotation)).toEqual([0, 90, 180, 270]);
    const { bytes } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const pages = await textOf(bytes);
    pages.forEach((items, position) => {
      expect(pageText(items)).toContain(`Stored rotation ${position * 90}`);
      expectAt(
        items.find((item) => item.str === `Page ${position + 1} of 4`),
        model,
        position,
        'pageNumbers',
      );
      expectAt(
        items.find((item) => item.str === 'CONFIDENTIAL'),
        model,
        position,
        'watermark',
      );
    });
    // On the page shown turned 90° clockwise, reading left to right runs up the page,
    // and its top right corner as shown is the page's top left corner.
    const turned = pages[1]!.find((item) => item.str === 'Page 2 of 4')!;
    expect(turned.transform.slice(0, 4).map((value) => Math.round(value))).toEqual([0, 10, -10, 0]);
    expect(turned.transform[4]).toBeLessThan(306);
    expect(turned.transform[5]).toBeGreaterThan(396);
    await expectValidPdf(bytes);
  });

  it('draws watermarks under the content before it, and over it after it', async () => {
    for (const layer of ['under', 'over'] as const) {
      const { model, sources } = await stamped('basic-3-pages.pdf', {
        watermark: { ...WATERMARK, layer },
      });
      const { bytes } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
      const streams = await contentStreams(bytes, 0);
      const watermark = streams.findIndex((stream) => stream.includes('CONFIDENTIAL'));
      const original = streams.findIndex((stream) => stream.includes('Folio fixture page 1'));
      expect(watermark).not.toBe(-1);
      expect(original).not.toBe(-1);
      if (layer === 'under') expect(watermark).toBe(0);
      expect(watermark < original).toBe(layer === 'under');
      // Marked as a pagination artifact, with its opacity from a graphics state.
      expect(streams[watermark]).toMatch(
        /\/Artifact <<\/Type \/Pagination \/Subtype \/Watermark \/BBox \[[\d. -]+\]>> BDC\nq\n\/FolioStamp-\d+ gs/,
      );
      // A page's streams are read as one: none may run into the next.
      expect(streams[watermark]).toMatch(/EMC\n$/);
      expect(streams.join('')).not.toMatch(/EMC\S/);
      await expectValidPdf(bytes);
    }
  });

  it('marks page numbers as headers or footers and keeps their graphics state to themselves', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      pageNumbers: { ...NUMBERS, position: 'top-left' },
    });
    const top = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const streams = await contentStreams(top.bytes, 0);
    const numbers = streams.at(-1)!;
    expect(numbers).toContain('Page 1 of 3');
    expect(numbers).toContain('/Artifact <</Type /Pagination /Subtype /Header /BBox');
    // Fully opaque text needs no graphics state; q/Q keep the text's state in.
    expect(numbers).not.toContain(' gs');
    expect(numbers.startsWith('/Artifact')).toBe(true);
    expect(numbers.split('\n').slice(1, 2)).toEqual(['q']);
    // The page's own content is wrapped in q/Q before anything is added after it.
    expect(streams[0]!.trim()).toBe('q');
    expect(streams.at(-2)!.trim()).toBe('Q');

    const bottom = await stamped('basic-3-pages.pdf', { pageNumbers: NUMBERS });
    const { bytes } = await exportPdf({ ...bottom, assets: new Map(), now: NOW });
    expect((await contentStreams(bytes, 0)).at(-1)).toContain('/Subtype /Footer');
  });

  it('numbers pages by their place in the whole document when only some are written', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      pageNumbers: NUMBERS,
      watermark: WATERMARK,
    });
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      pageIds: [model.pages[1]!.id],
      now: NOW,
    });
    const [only] = await textOf(bytes);
    expect(pageText(only!)).toContain('Page 2 of 3');
    expect(pageText(only!)).toContain('Folio fixture page 2');
    await expectValidPdf(bytes);
  });

  it('stamps only the pages in range, counting from the start number', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      pageNumbers: { ...NUMBERS, startNumber: 10, pages: { from: 2, to: null } },
      watermark: { ...WATERMARK, pages: { from: 1, to: 1 } },
    });
    const { bytes } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const pages = (await textOf(bytes)).map(pageText);
    expect(pages[0]).toContain('CONFIDENTIAL');
    expect(pages[0]).not.toContain(' of 11');
    expect(pages[1]).toContain('Page 10 of 11');
    expect(pages[1]).not.toContain('CONFIDENTIAL');
    expect(pages[2]).toContain('Page 11 of 11');
  });

  it('gives a duplicated page its own number, not its original’s', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', { pageNumbers: NUMBERS });
    const copy = { ...model.pages[0]!, id: newPageId() };
    const edited = applyOperation(model, {
      type: 'pages/insert',
      entries: [{ index: 1, page: copy }],
      annotations: [],
      sources: [],
    }).model;
    const { bytes } = await exportPdf({ model: edited, sources, assets: new Map(), now: NOW });
    const pages = (await textOf(bytes)).map(pageText);
    expect(pages[0]).toContain('Page 1 of 4');
    expect(pages[0]).not.toContain('Page 2 of 4');
    expect(pages[1]).toContain('Folio fixture page 1');
    expect(pages[1]).toContain('Page 2 of 4');
    expect(pages[1]).not.toContain('Page 1 of 4');
    await expectValidPdf(bytes);
  });

  it('embeds each standard font once for stamps and added text', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      pageNumbers: { ...NUMBERS, fontFamily: 'mono' },
      watermark: { ...WATERMARK, fontFamily: 'mono' },
    });
    const edited = applyOperation(model, {
      type: 'annotations/add',
      annotations: [
        {
          id: newAnnotationId(),
          pageId: model.pages[2]!.id,
          author: '',
          createdAt: NOW.toISOString(),
          modifiedAt: NOW.toISOString(),
          color: '#000000',
          opacity: 1,
          kind: 'added-text',
          rect: { x: 72, y: 300, width: 200, height: 40 },
          text: 'Typed in Courier',
          fontSize: 12,
          fontFamily: 'mono',
          rotation: 0,
        },
      ],
    }).model;
    const { bytes } = await exportPdf({
      model: edited,
      sources,
      assets: new Map(),
      flatten: true,
      now: NOW,
    });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const couriers = [...doc.context.enumerateIndirectObjects()].filter(
      ([, object]) =>
        object instanceof PDFDict && object.get(PDFName.of('BaseFont'))?.toString() === '/Courier',
    );
    expect(couriers).toHaveLength(1);
    expect(pageText((await textOf(bytes))[2]!)).toMatch(/Typed\s+in\s+Courier/);
  });

  it('keeps a protected document protected', async () => {
    const { model, sources } = await stamped(
      'encrypted-user-password.pdf',
      { pageNumbers: NUMBERS, watermark: WATERMARK },
      FIXTURE_PASSWORD,
    );
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      protection: { userPassword: FIXTURE_PASSWORD, permissions: null },
      now: NOW,
    });
    await expect(textOf(bytes)).rejects.toThrow(/password/i);
    const pages = await textOf(bytes, FIXTURE_PASSWORD);
    expect(pageText(pages[1]!)).toContain('Page 2 of 3');
    expect(pageText(pages[1]!)).toContain('CONFIDENTIAL');
    await expectValidPdf(bytes, FIXTURE_PASSWORD);
  });

  it('reports text the standard fonts cannot show', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      watermark: { ...WATERMARK, text: '机密 draft' },
    });
    const { bytes, warnings } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    expect(warnings).toEqual(['unsupported-characters']);
    expect(pageText((await textOf(bytes))[0]!)).toContain('?? draft');
  });

  it('keeps sizes in points on pages with a user unit and a crop box', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([400, 500]);
    page.setCropBox(50, 60, 300, 400);
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const { model, sources } = await stamped(await pdf.save(), { pageNumbers: NUMBERS });
    expect(model.pages[0]).toMatchObject({ size: { width: 600, height: 800 }, userUnit: 2 });
    const { bytes } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const [items] = await textOf(bytes);
    const item = items!.find((entry) => entry.str === 'Page 1 of 1');
    expectAt(item, model, 0, 'pageNumbers', { x: 50, y: 60 });
    // A 10-point font is 5 units of a 2-point user unit, and sits in the crop box.
    expect(item!.transform[0]).toBeCloseTo(5, 2);
    expect(item!.transform[5]).toBeGreaterThan(60);
    expect(item!.transform[5]).toBeLessThan(60 + 36);
    await expectValidPdf(bytes);
  });

  it('stamps blank pages, which have no content of their own', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      pageNumbers: NUMBERS,
      watermark: WATERMARK,
    });
    const blank = {
      id: newPageId(),
      source: { kind: 'blank' as const },
      size: { width: 300, height: 400 },
      userUnit: 1,
      sourceRotation: 0 as const,
      rotation: 90 as const,
    };
    const edited = applyOperation(model, {
      type: 'pages/insert',
      entries: [{ index: 3, page: blank }],
      annotations: [],
      sources: [],
    }).model;
    const { bytes } = await exportPdf({ model: edited, sources, assets: new Map(), now: NOW });
    const pages = await textOf(bytes);
    expect(pageText(pages[3]!)).toBe('CONFIDENTIAL Page 4 of 4');
    expectAt(
      pages[3]!.find((item) => item.str === 'Page 4 of 4'),
      edited,
      3,
      'pageNumbers',
    );
    expect((await contentStreams(bytes, 3))[0]).toContain('/Subtype /Watermark');
    await expectValidPdf(bytes);
  });

  it('leaves the content of pages without stamps as it was', async () => {
    const { model, sources } = await stamped('basic-3-pages.pdf', {
      pageNumbers: { ...NUMBERS, pages: { from: 3, to: 3 } },
    });
    const { bytes } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const original = readFixture('basic-3-pages.pdf');
    for (const index of [0, 1]) {
      expect(await contentStreams(bytes, index)).toEqual(await contentStreams(original, index));
    }
    expect((await contentStreams(bytes, 2)).at(-1)).toContain('Page 1 of 1');
  });
});
