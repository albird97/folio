import {
  applyOperation,
  createDocumentModel,
  newAssetId,
  newPageId,
  serializeRecognizedText,
  sourcePageKey,
  type AssetId,
  type DocumentModel,
  type RecognizedTextData,
  type RecognizedWord,
  type Rotation,
  type SourceId,
} from '@folio/document-model';
import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFRawStream,
  PDFStream,
} from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createNodeCanvas,
  FIXTURE_PASSWORD,
  nodeWorkerSrc,
  qpdfCheck,
  readFixture,
} from '../../../../tests/setup/fixtures';
import { toSourceDescriptor } from '../descriptor';
import { createPdfEngine } from '../engine';
import { sha256Hex } from '../hash';
import { exportPdf, originalSourceId, type ExportSource } from './export';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const NOW = new Date('2026-03-01T12:00:00Z');

async function modelOf(bytes: Uint8Array, password?: string) {
  const handle = await engine.open(bytes, password === undefined ? {} : { password });
  const model = createDocumentModel(
    toSourceDescriptor(handle.info, {
      fileName: 'scan.pdf',
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      origin: { kind: 'generated' },
    }),
  );
  await handle.destroy();
  const sourceId = originalSourceId(model)!;
  const sources = new Map<SourceId, ExportSource>([
    [sourceId, password === undefined ? { bytes } : { bytes, password }],
  ]);
  return { model, sourceId, sources };
}

const word = (text: string, line: number, x: number, y: number, width: number, height = 16) =>
  ({ text, box: { x, y, width, height }, confidence: 92, line }) satisfies RecognizedWord;

/** Gives source pages recognized text, as the workspace does after OCR. */
function withText(
  model: DocumentModel,
  pages: Array<{ sourceId: SourceId; pageIndex: number; data: RecognizedTextData }>,
) {
  const assets = new Map<AssetId, Uint8Array>();
  const refs = pages.map(({ data }) => {
    const bytes = serializeRecognizedText(data);
    const id = newAssetId();
    assets.set(id, bytes);
    return {
      id,
      mimeType: 'application/json' as const,
      byteLength: bytes.byteLength,
      sha256: 'c'.repeat(64),
    };
  });
  const edited = applyOperation(model, {
    type: 'text-layers/set',
    entries: pages.map(({ sourceId, pageIndex, data }, index) => ({
      key: sourcePageKey(sourceId, pageIndex),
      layer: { assetId: refs[index]!.id, languages: data.languages, wordCount: data.words.length },
    })),
    assets: refs,
  }).model;
  return { model: edited, assets };
}

const textData = (words: RecognizedWord[], rotation: Rotation = 0): RecognizedTextData => ({
  version: 1,
  languages: 'eng+ind+chi_sim',
  rotation,
  words,
});

/** English, Indonesian and Chinese lines on an upright Letter page. */
const SAMPLE = textData([
  word('The', 0, 72, 600, 34),
  word('lighthouse', 0, 112, 600, 86),
  word('keeper', 0, 204, 600, 54),
  word('Kucing', 1, 72, 570, 58),
  word('tidur', 1, 136, 570, 40),
  word('文字', 2, 72, 540, 32),
  word('识别', 2, 104, 540, 32),
]);

interface Item {
  str: string;
  transform: number[];
  width: number;
}

async function textItems(bytes: Uint8Array, pageNumber = 1, password?: string) {
  const task = getDocument({
    data: bytes.slice(),
    ...(password === undefined ? {} : { password }),
  });
  const doc = await task.promise;
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const items = content.items.filter((item): item is Item & typeof item => 'str' in item);
  const text = items
    .map((item) => item.str + ((item as { hasEOL?: boolean }).hasEOL ? '\n' : ''))
    .join('');
  await task.destroy();
  return { items: items as Item[], text };
}

/** The item a string starts in, and where in it. */
function find(items: readonly Item[], needle: string) {
  const item = items.find((entry) => entry.str.includes(needle));
  if (!item) throw new Error(`"${needle}" was not extracted`);
  return item;
}

async function expectValidPdf(bytes: Uint8Array) {
  const result = await qpdfCheck(bytes);
  if (!result) {
    expect(process.env.CI, 'qpdf must be installed on CI').toBeFalsy();
    return;
  }
  expect(result.ok, result.output).toBe(true);
}

/** Every pixel of a page, drawn by PDF.js. */
async function pixels(bytes: Uint8Array, pageIndex = 0) {
  const handle = await engine.open(bytes);
  const canvas = createNodeCanvas();
  await handle.renderPage(pageIndex, canvas, {
    scale: 1,
    devicePixelRatio: 1,
    styleCanvas: false,
  }).promise;
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  await handle.destroy();
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

describe('exportPdf: recognized text', () => {
  it('writes invisible text that PDF.js extracts where the words are', async () => {
    const { model, sourceId, sources } = await modelOf(readFixture('scanned-pages.pdf'));
    const edited = withText(model, [{ sourceId, pageIndex: 0, data: SAMPLE }]);
    const { bytes } = await exportPdf({ ...edited, sources, now: NOW });

    const { items, text } = await textItems(bytes);
    expect(text).toContain('The lighthouse keeper');
    expect(text).toContain('Kucing tidur');
    expect(text).toContain('文字识别');
    // Each line starts at its first word, on a baseline a fifth of the line above its bottom.
    for (const [needle, x, y] of [
      ['The', 72, 600],
      ['Kucing', 72, 570],
      ['文字', 72, 540],
    ] as const) {
      const item = find(items, needle);
      expect(item.transform[4], needle).toBeCloseTo(x, 1);
      expect(item.transform[5], needle).toBeCloseTo(y + 16 * 0.2, 1);
      // Text the size of the line, upright (stretched sideways to the word).
      const [a, b, c, d] = item.transform;
      expect(a, needle).toBeGreaterThan(0);
      expect([b, c, d], needle).toEqual([0, 0, 16]);
    }
    // The words are stretched to their boxes: the first line ends where "keeper" does.
    const first = find(items, 'The');
    const last = items.find(
      (item) => item.str.endsWith('keeper') && item.transform[5] === first.transform[5],
    )!;
    expect(last.transform[4]! + last.width).toBeCloseTo(204 + 54, 0);
    await expectValidPdf(bytes);
  });

  it('paints nothing: the page looks the same with and without the text', async () => {
    const { model, sourceId, sources } = await modelOf(readFixture('scanned-pages.pdf'));
    const plain = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const edited = withText(model, [{ sourceId, pageIndex: 0, data: SAMPLE }]);
    const { bytes } = await exportPdf({ ...edited, sources, now: NOW });
    expect(bytes.byteLength).toBeGreaterThan(plain.bytes.byteLength);
    expect((await pixels(bytes)).equals(await pixels(plain.bytes))).toBe(true);
  });

  it('writes the words in an invisible text block with a glyph-less Unicode font', async () => {
    const { model, sourceId, sources } = await modelOf(readFixture('scanned-pages.pdf'));
    const edited = withText(model, [{ sourceId, pageIndex: 0, data: SAMPLE }]);
    const { bytes } = await exportPdf({ ...edited, sources, now: NOW });
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPage(0).node;
    const fonts = page.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const [fontName] = fonts.keys();
    const font = fonts.lookup(fontName!, PDFDict);
    expect(font.get(PDFName.of('Subtype'))).toBe(PDFName.of('Type0'));
    expect(font.get(PDFName.of('Encoding'))).toBe(PDFName.of('Identity-H'));
    expect(font.get(PDFName.of('ToUnicode'))).toBeDefined();
    const descendant = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict);
    expect(descendant.get(PDFName.of('Subtype'))).toBe(PDFName.of('CIDFontType2'));
    // Every character shows glyph 1, which has no outline.
    const glyphMap = decodePDFRawStream(
      descendant.lookup(PDFName.of('CIDToGIDMap'), PDFStream) as PDFRawStream,
    ).decode();
    expect(glyphMap.length).toBe(0x20000);
    expect(glyphMap.every((byte, index) => byte === (index % 2 === 1 ? 1 : 0))).toBe(true);

    // The text is the last content stream: q BT 3 Tr … ET Q, so nothing leaks out.
    const contents = page.Contents() as PDFArray;
    const stream = contents.lookup(contents.size() - 1, PDFStream) as PDFRawStream;
    const ops = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    expect(ops.startsWith(`q\nBT\n3 Tr\n${fontName!.asString()} 16 Tf\n`)).toBe(true);
    expect(ops.endsWith('ET\nQ\n')).toBe(true);
    // "The" as UTF-16 character codes.
    expect(ops).toContain('<005400680065> Tj');
  });

  it('places text read on a turned page along the page, relative to the crop box', async () => {
    // A landscape page shown upright with /Rotate 90 (like the scanned
    // fixture's second page), cropped away from the media box origin.
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([900, 700]);
    page.setCropBox(50, 40, 792, 612);
    page.setRotation(degrees(90));
    const source = await pdf.save();
    const { model, sourceId, sources } = await modelOf(source);
    // Read at 90°: the line runs up the page (+y), its top towards -x.
    const data = textData(
      [word('Halaman', 0, 300, 100, 16, 80), word('kedua', 0, 300, 190, 16, 56)],
      90,
    );
    const edited = withText(model, [{ sourceId, pageIndex: 0, data }]);
    const { bytes } = await exportPdf({ ...edited, sources, now: NOW });
    const { items, text } = await textItems(bytes);
    expect(text).toContain('Halaman kedua');
    const item = find(items, 'Halaman');
    const [a, b, c, d, e, f] = item.transform;
    expect(a).toBeCloseTo(0);
    expect(b).toBeGreaterThan(0);
    expect(c).toBeCloseTo(-16);
    expect(d).toBeCloseTo(0);
    // Page space starts at the crop box corner (50, 40): the baseline runs a
    // fifth of the line inside the word's right edge, from its bottom.
    expect(e).toBeCloseTo(50 + 316 - 16 * 0.2, 1);
    expect(f).toBeCloseTo(40 + 100, 1);
    await expectValidPdf(bytes);
  });

  it('keeps the text on copies, extracts and protected files', async () => {
    const locked = readFixture('encrypted-user-password.pdf');
    const { model, sourceId, sources } = await modelOf(locked, FIXTURE_PASSWORD);
    const words = textData([word('Recognized', 0, 72, 300, 90), word('again', 0, 170, 300, 50)]);
    const edited = withText(model, [{ sourceId, pageIndex: 1, data: words }]);
    const copy = { ...edited.model.pages[1]!, id: newPageId() };
    const duplicated = applyOperation(edited.model, {
      type: 'pages/insert',
      entries: [{ index: 3, page: copy }],
      annotations: [],
      sources: [],
    }).model;

    const saved = await exportPdf({
      model: duplicated,
      sources,
      assets: edited.assets,
      protection: { userPassword: FIXTURE_PASSWORD, permissions: null },
      now: NOW,
    });
    for (const pageNumber of [2, 4]) {
      const { text } = await textItems(saved.bytes, pageNumber, FIXTURE_PASSWORD);
      expect(text, `page ${pageNumber}`).toContain('Recognized again');
    }
    expect((await textItems(saved.bytes, 1, FIXTURE_PASSWORD)).text).not.toContain('Recognized');

    const extracted = await exportPdf({
      model: duplicated,
      sources,
      assets: edited.assets,
      pageIds: [copy.id],
      now: NOW,
    });
    expect((await textItems(extracted.bytes, 1, FIXTURE_PASSWORD)).text).toContain(
      'Recognized again',
    );
    await expectValidPdf(extracted.bytes);
  });

  it('goes with page numbers on the same page', async () => {
    const { model, sourceId, sources } = await modelOf(readFixture('scanned-pages.pdf'));
    const edited = withText(model, [{ sourceId, pageIndex: 0, data: SAMPLE }]);
    const stamped = applyOperation(edited.model, {
      type: 'stamps/set',
      stamps: {
        pageNumbers: {
          format: 'Page {page} of {total}',
          position: 'bottom-center',
          fontFamily: 'sans',
          fontSize: 10,
          color: '#1f2328',
          margin: 24,
          startNumber: 1,
          pages: { from: 1, to: null },
        },
      },
    }).model;
    const { bytes } = await exportPdf({ model: stamped, sources, assets: edited.assets, now: NOW });
    const { text } = await textItems(bytes);
    expect(text).toContain('The lighthouse keeper');
    expect(text).toContain('Page 1 of 2');
    await expectValidPdf(bytes);
  });

  it('writes characters beyond the Basic Multilingual Plane as U+FFFD', async () => {
    const { model, sourceId, sources } = await modelOf(readFixture('scanned-pages.pdf'));
    const data = textData([word('𝒜lpha', 0, 72, 600, 60), word('𠀀字', 1, 72, 570, 32)]);
    const edited = withText(model, [{ sourceId, pageIndex: 0, data }]);
    const { bytes } = await exportPdf({ ...edited, sources, now: NOW });
    const { text } = await textItems(bytes);
    expect(text).toContain('\ufffdlpha');
    expect(text).toContain('\ufffd字');
    await expectValidPdf(bytes);
  });

  it('saves without the text of a page whose stored data is damaged', async () => {
    const { model, sourceId, sources } = await modelOf(readFixture('scanned-pages.pdf'));
    const edited = withText(model, [{ sourceId, pageIndex: 0, data: SAMPLE }]);
    const [assetId] = [...edited.assets.keys()];
    const damaged = new Map([[assetId!, new TextEncoder().encode('{"version":1,')]]);
    const { bytes } = await exportPdf({ model: edited.model, sources, assets: damaged, now: NOW });
    expect((await textItems(bytes)).text).toBe('');
  });
});
