import {
  applyOperation,
  createDocumentModel,
  newAnnotationId,
  newAssetId,
  newPageId,
  type Annotation,
  type AssetId,
  type DocumentModel,
  type PageModel,
  type SourceId,
} from '@folio/document-model';
import {
  decodePDFRawStream,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  StandardFonts,
} from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PASSWORD,
  makePng,
  nodeWorkerSrc,
  qpdfCheck,
  readFixture,
  type FixtureName,
} from '../../../../tests/setup/fixtures';
import { toSourceDescriptor } from '../descriptor';
import { createPdfEngine } from '../engine';
import { sha256Hex } from '../hash';
import { exportPdf, originalSourceId, type ExportSource } from './export';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const NOW = new Date('2026-03-01T12:00:00Z');

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

async function fixtureModel(name: FixtureName, password?: string) {
  const bytes = readFixture(name);
  const model = await modelFrom(bytes, name, password);
  const id = originalSourceId(model)!;
  const sources = new Map<SourceId, ExportSource>([
    [id, password === undefined ? { bytes } : { bytes, password }],
  ]);
  return { model, sources, sourceId: id };
}

async function open(bytes: Uint8Array, password?: string) {
  const task = getDocument({
    data: bytes.slice(),
    ...(password === undefined ? {} : { password }),
  });
  const doc = await task.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push({
      text,
      rotate: page.rotate,
      view: page.view,
      annotations: (await page.getAnnotations()) as Array<Record<string, unknown>>,
    });
  }
  const outline = await doc.getOutline();
  const metadata = await doc.getMetadata();
  const permissions = await doc.getPermissions();
  const labels = await doc.getPageLabels();
  await task.destroy();
  return { pages, outline, metadata, permissions, labels };
}

const latin1 = new TextDecoder('latin1');

/** Hex strings (how pdf-lib writes standard-font text) decoded in place. */
const withHexDecoded = (content: string) =>
  content.replace(/<([0-9A-Fa-f\s]+)>/g, (_, hex: string) => {
    const digits = hex.replace(/\s/g, '');
    let out = '';
    for (let i = 0; i + 1 < digits.length; i += 2) {
      out += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2), 16));
    }
    return out;
  });

/** Every object's decoded text, to prove what is (not) in the file. */
async function allObjectText(bytes: Uint8Array, password?: string): Promise<string> {
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ...(password === undefined ? {} : { password }),
  });
  let text = '';
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      try {
        text += latin1.decode(decodePDFRawStream(object).decode());
      } catch {
        // Images and fonts may use filters that are not decoded here.
      }
    } else if (object instanceof PDFStream) {
      text += latin1.decode(object.getContents());
    } else {
      text += object.toString();
    }
    text += '\n';
  }
  // UTF-16 strings read as Latin-1 have a NUL before every ASCII character.
  return withHexDecoded(text).replace(/\0/g, '');
}

/** An entry of the first page's annotation with the given subtype, as written. */
async function rawAnnotationEntry(bytes: Uint8Array, subtype: string, key: string) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = doc.getPage(0).node.Annots();
  for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
    const annot = annots!.lookup(index, PDFDict);
    if (annot.get(PDFName.of('Subtype'))?.toString() === `/${subtype}`) {
      return annot.get(PDFName.of(key))?.toString();
    }
  }
  return undefined;
}

/** `qpdf --check` must pass; qpdf is required on CI and optional locally. */
async function expectValidPdf(bytes: Uint8Array) {
  const result = await qpdfCheck(bytes);
  if (!result) {
    expect(process.env.CI, 'qpdf must be installed on CI').toBeFalsy();
    return;
  }
  expect(result.ok, result.output).toBe(true);
}

const base = (pageId: PageModel['id']) => ({
  id: newAnnotationId(),
  pageId,
  author: 'Ada',
  createdAt: '2026-02-01T10:00:00.000Z',
  modifiedAt: '2026-02-02T10:00:00.000Z',
  color: '#ff0000',
  opacity: 1,
});

function blankPage(width = 300, height = 400): PageModel {
  return {
    id: newPageId(),
    source: { kind: 'blank' },
    size: { width, height },
    userUnit: 1,
    sourceRotation: 0,
    rotation: 0,
  };
}

describe('exportPdf: pages', () => {
  it('writes pages in model order with rotation, duplicates and blank pages', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const [one, two, three] = model.pages as [PageModel, PageModel, PageModel];
    const duplicate: PageModel = { ...two, id: newPageId() };
    let edited = applyOperation(model, {
      type: 'pages/reorder',
      order: [three.id, one.id, two.id],
    }).model;
    edited = applyOperation(edited, {
      type: 'pages/insert',
      entries: [
        { index: 3, page: duplicate },
        { index: 4, page: blankPage() },
      ],
      annotations: [],
      sources: [],
    }).model;
    edited = applyOperation(edited, { type: 'pages/rotate', pageIds: [one.id], delta: 90 }).model;

    const { bytes, warnings } = await exportPdf({
      model: edited,
      sources,
      assets: new Map(),
      now: NOW,
    });
    expect(warnings).toEqual([]);
    const result = await open(bytes);
    expect(result.pages.map((page) => page.text.match(/page \d/)?.[0] ?? 'blank')).toEqual([
      'page 3',
      'page 1',
      'page 2',
      'page 2',
      'blank',
    ]);
    expect(result.pages.map((page) => page.rotate)).toEqual([0, 90, 0, 0, 0]);
    expect(result.pages[4]?.view).toEqual([0, 0, 300, 400]);
    await expectValidPdf(bytes);
  });

  it('leaves removed pages and everything only they used out of the file', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    expect(await allObjectText(readFixture('basic-3-pages.pdf'))).toContain('page 2');
    const edited = applyOperation(model, {
      type: 'pages/remove',
      pageIds: [model.pages[1]!.id],
    }).model;
    const { bytes } = await exportPdf({ model: edited, sources, assets: new Map(), now: NOW });
    const result = await open(bytes);
    expect(result.pages).toHaveLength(2);
    const streams = await allObjectText(bytes);
    expect(streams).toContain('page 1');
    expect(streams).not.toContain('page 2');
  });

  it('keeps bookmarks, dropping the destinations of removed pages', async () => {
    const { model, sources } = await fixtureModel('outline-and-text.pdf');
    // Remove page 3 (Section 1.1's destination).
    const edited = applyOperation(model, {
      type: 'pages/remove',
      pageIds: [model.pages[2]!.id],
    }).model;
    const { bytes } = await exportPdf({ model: edited, sources, assets: new Map(), now: NOW });
    const handle = await engine.open(bytes);
    const outline = await handle.getOutline();
    await handle.destroy();
    const byTitle = new Map(
      outline.flatMap((item) => [item, ...item.children]).map((i) => [i.title, i]),
    );
    expect(byTitle.get('Introduction')?.pageIndex).toBe(0);
    expect(byTitle.get('Chapter 1: Foxes')?.pageIndex).toBe(1);
    expect(byTitle.get('Section 1.1: Habitat')?.pageIndex).toBeNull();
    // Named destinations still resolve, to the page's new position.
    expect(byTitle.get('Chapter 2: Plants')?.pageIndex).toBe(3);
    await expectValidPdf(bytes);
  });

  it('extracts pages into a new document without the original structure', async () => {
    const { model, sources } = await fixtureModel('outline-and-text.pdf');
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      pageIds: [model.pages[4]!.id, model.pages[1]!.id],
      now: NOW,
    });
    const result = await open(bytes);
    // Document order, whatever order the pages were selected in.
    expect(result.pages.map((page) => page.text.split(' ').slice(0, 2).join(' '))).toEqual([
      'Chapter 1:',
      'Chapter 2:',
    ]);
    expect(result.outline).toBeNull();
    // Pages copied along with links or bookmarks do not come with them.
    expect(await allObjectText(bytes)).not.toContain('Introduction');
  });

  it('combines pages from several documents', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const other = await fixtureModel('outline-and-text.pdf');
    const [otherSourceId, otherSource] = [...other.sources][0]!;
    const inserted = other.model.pages.slice(0, 2).map((page) => ({ ...page, id: newPageId() }));
    const edited = applyOperation(model, {
      type: 'pages/insert',
      entries: inserted.map((page, offset) => ({ index: 1 + offset, page })),
      annotations: [],
      sources: [other.model.sources[otherSourceId]!],
    }).model;
    const { bytes } = await exportPdf({
      model: edited,
      sources: new Map([...sources, [otherSourceId, otherSource]]),
      assets: new Map(),
      now: NOW,
    });
    const result = await open(bytes);
    expect(result.pages.map((page) => page.text.slice(0, 20))).toEqual([
      expect.stringContaining('page 1'),
      expect.stringContaining('Introduction'),
      expect.stringContaining('Chapter 1'),
      expect.stringContaining('page 2'),
      expect.stringContaining('page 3'),
    ]);
    await expectValidPdf(bytes);
  });
});

/** Three pages; page 1 links to page 3 and has a note, page 2 holds a form field. */
async function linkedFormPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [1, 2, 3].map((number) => {
    const page = pdf.addPage([400, 400]);
    page.drawText(`linked page ${number}`, { x: 40, y: 340, size: 18, font });
    return page;
  });
  const { context } = pdf;
  const link = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [40, 300, 200, 330],
      Border: [0, 0, 0],
      Dest: [pages[2]!.ref, 'Fit'],
    }),
  );
  const note = context.register(
    context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [300, 300, 320, 320],
      P: pages[0]!.ref,
      Contents: PDFHexString.fromText('note on page one'),
    }),
  );
  pages[0]!.node.set(PDFName.of('Annots'), context.obj([link, note]));
  const field = pdf.getForm().createTextField('ssn');
  field.setText('secret-ssn-value');
  field.addToPage(pages[1]!, { x: 40, y: 200, width: 200, height: 30 });
  return pdf.save({ useObjectStreams: false });
}

describe('exportPdf: copies and removals', () => {
  it('duplicates pages without duplicating what they share, and keeps additions apart', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const first = model.pages[0]!;
    const copies = [newPageId(), newPageId()].map((id) => ({ ...first, id }));
    let edited = applyOperation(model, {
      type: 'pages/insert',
      entries: copies.map((page, offset) => ({ index: 1 + offset, page })),
      annotations: [],
      sources: [],
    }).model;
    edited = applyOperation(edited, {
      type: 'annotations/add',
      annotations: [
        {
          ...base(copies[0]!.id),
          kind: 'added-text',
          rect: { x: 72, y: 300, width: 300, height: 40 },
          text: 'only on the first copy',
          fontSize: 14,
          fontFamily: 'sans',
          rotation: 0,
        },
      ],
    }).model;
    const plain = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const { bytes } = await exportPdf({
      model: edited,
      sources,
      assets: new Map(),
      flatten: true,
      now: NOW,
    });
    const result = await open(bytes);
    expect(result.pages.map((page) => page.text.includes('fixture page 1'))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(result.pages.map((page) => page.text.includes('only on the first copy'))).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    // Two more pages cost a page dictionary each, not another copy of the content.
    expect(bytes.byteLength - plain.bytes.byteLength).toBeLessThan(2500);
    await expectValidPdf(bytes);
  });

  it('copies pages of another file without the pages they link to', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const otherBytes = await linkedFormPdf();
    const other = await modelFrom(otherBytes, 'linked.pdf');
    const otherId = originalSourceId(other)!;
    const page = { ...other.pages[0]!, id: newPageId() };
    const edited = applyOperation(model, {
      type: 'pages/insert',
      entries: [{ index: 3, page }],
      annotations: [],
      sources: [other.sources[otherId]!],
    }).model;
    const { bytes } = await exportPdf({
      model: edited,
      sources: new Map([...sources, [otherId, { bytes: otherBytes }]]),
      assets: new Map(),
      now: NOW,
    });
    const result = await open(bytes);
    expect(result.pages).toHaveLength(4);
    expect(result.pages[3]!.text).toBe('linked page 1');
    const subtypes = result.pages[3]!.annotations.map((annotation) => annotation.subtype);
    expect(subtypes.sort()).toEqual(['Link', 'Text']);
    const text = await allObjectText(bytes);
    expect(text).toContain('note on page one');
    expect(text).not.toContain('linked page 3');
    expect(text).not.toContain('secret-ssn-value');
    await expectValidPdf(bytes);
  });

  it('copies two linked pages together with the link between them intact', async () => {
    const otherBytes = await linkedFormPdf();
    const model = await modelFrom(otherBytes, 'linked.pdf');
    const sources = new Map([[originalSourceId(model)!, { bytes: otherBytes }]]);
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      pageIds: [model.pages[0]!.id, model.pages[2]!.id],
      now: NOW,
    });
    const [first] = (await open(bytes)).pages;
    const link = first!.annotations.find((annotation) => annotation.subtype === 'Link')!;
    const handle = await engine.open(bytes);
    const outline = await import('../outline');
    const target = await outline.resolveDestination(link.dest as unknown[], {
      getDestination: async () => null,
      getPageIndex: async (ref) => {
        const task = getDocument({ data: bytes.slice() });
        const doc = await task.promise;
        const index = await doc.getPageIndex(ref);
        await task.destroy();
        return index;
      },
      pageCount: handle.info.pageCount,
    });
    await handle.destroy();
    expect(target.pageIndex).toBe(1);
  });

  it('removes form fields, and their values, with the pages that showed them', async () => {
    const otherBytes = await linkedFormPdf();
    expect(await allObjectText(otherBytes)).toContain('secret-ssn-value');
    const model = await modelFrom(otherBytes, 'linked.pdf');
    const edited = applyOperation(model, {
      type: 'pages/remove',
      pageIds: [model.pages[1]!.id],
    }).model;
    const { bytes } = await exportPdf({
      model: edited,
      sources: new Map([[originalSourceId(model)!, { bytes: otherBytes }]]),
      assets: new Map(),
      now: NOW,
    });
    expect(await allObjectText(bytes)).not.toContain('secret-ssn-value');
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getForm().getFields()).toHaveLength(0);
    await expectValidPdf(bytes);
  });

  it('keeps page labels only while the original pages keep their positions', async () => {
    const pdf = await PDFDocument.load(readFixture('basic-3-pages.pdf'), { updateMetadata: false });
    pdf.catalog.set(
      PDFName.of('PageLabels'),
      pdf.context.obj({ Nums: [0, pdf.context.obj({ S: 'r' })] }),
    );
    const labelled = await pdf.save();
    const model = await modelFrom(labelled, 'labelled.pdf');
    const sources = new Map([[originalSourceId(model)!, { bytes: labelled }]]);
    const appended = applyOperation(model, {
      type: 'pages/insert',
      entries: [{ index: 3, page: blankPage() }],
      annotations: [],
      sources: [],
    }).model;
    const kept = await exportPdf({ model: appended, sources, assets: new Map(), now: NOW });
    expect((await open(kept.bytes)).labels).toEqual(['i', 'ii', 'iii', 'iv']);
    const moved = applyOperation(model, {
      type: 'pages/reorder',
      order: [model.pages[2]!.id, model.pages[0]!.id, model.pages[1]!.id],
    }).model;
    const dropped = await exportPdf({ model: moved, sources, assets: new Map(), now: NOW });
    expect((await open(dropped.bytes)).labels).toBeNull();
  });

  it('copies pages out of a password-protected file', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const locked = await fixtureModel('encrypted-user-password.pdf', FIXTURE_PASSWORD);
    const [lockedId, lockedSource] = [...locked.sources][0]!;
    const page = { ...locked.model.pages[2]!, id: newPageId() };
    const edited = applyOperation(model, {
      type: 'pages/insert',
      entries: [{ index: 0, page }],
      annotations: [],
      sources: [locked.model.sources[lockedId]!],
    }).model;
    const { bytes } = await exportPdf({
      model: edited,
      sources: new Map([...sources, [lockedId, lockedSource]]),
      assets: new Map(),
      now: NOW,
    });
    const result = await open(bytes);
    expect(result.pages[0]!.text).toContain('Folio fixture page 3');
    await expectValidPdf(bytes);
  });

  it('reports a wrong or missing password for a source', async () => {
    const locked = await fixtureModel('encrypted-user-password.pdf', FIXTURE_PASSWORD);
    const [id] = [...locked.sources][0]!;
    await expect(
      exportPdf({
        model: locked.model,
        sources: new Map([[id, { bytes: readFixture('encrypted-user-password.pdf') }]]),
        assets: new Map(),
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
    await expect(
      exportPdf({ model: locked.model, sources: new Map(), assets: new Map() }),
    ).rejects.toMatchObject({ code: 'missing-source' });
  });
});

describe('exportPdf: annotations', () => {
  async function annotated(flatten: boolean) {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const pageId = model.pages[0]!.id;
    const assetId = newAssetId() as AssetId;
    const png = await makePng(4, 4);
    const annotations: Annotation[] = [
      {
        ...base(pageId),
        kind: 'highlight',
        rects: [{ x: 72, y: 700, width: 100, height: 14 }],
        text: 'hi',
        color: '#ffd400',
        opacity: 0.5,
      },
      {
        ...base(pageId),
        kind: 'underline',
        rects: [{ x: 72, y: 680, width: 80, height: 12 }],
        text: '',
      },
      {
        ...base(pageId),
        kind: 'strikeout',
        rects: [{ x: 72, y: 660, width: 60, height: 12 }],
        text: '',
      },
      { ...base(pageId), kind: 'note', position: { x: 400, y: 700 }, contents: 'Check this ✓' },
      {
        ...base(pageId),
        kind: 'ink',
        paths: [
          [
            { x: 100, y: 500 },
            { x: 150, y: 520 },
            { x: 200, y: 480 },
          ],
        ],
        strokeWidth: 2,
      },
      {
        ...base(pageId),
        kind: 'shape',
        shape: 'rectangle',
        rect: { x: 300, y: 400, width: 100, height: 50 },
        strokeWidth: 2,
        fill: '#00ff00',
      },
      {
        ...base(pageId),
        kind: 'shape',
        shape: 'ellipse',
        rect: { x: 300, y: 300, width: 80, height: 40 },
        strokeWidth: 1,
        fill: null,
      },
      {
        ...base(pageId),
        kind: 'shape',
        shape: 'arrow',
        rect: { x: 100, y: 300, width: 100, height: -50 },
        strokeWidth: 2,
        fill: null,
      },
      {
        ...base(pageId),
        kind: 'added-text',
        rect: { x: 72, y: 200, width: 200, height: 60 },
        text: 'Hello flattened world, this wraps',
        fontSize: 14,
        fontFamily: 'serif',
        color: '#000080',
        rotation: 0,
      },
      {
        ...base(pageId),
        kind: 'added-image',
        rect: { x: 400, y: 100, width: 40, height: 40 },
        assetId,
        rotation: 0,
      },
    ];
    const edited = applyOperation(
      {
        ...model,
        assets: {
          [assetId]: {
            id: assetId,
            mimeType: 'image/png',
            byteLength: png.byteLength,
            sha256: await sha256Hex(png),
          },
        },
      } as DocumentModel,
      { type: 'annotations/add', annotations },
    ).model;
    const result = await exportPdf({
      model: edited,
      sources,
      assets: new Map([[assetId, png]]),
      flatten,
      now: NOW,
    });
    return { ...result, annotations };
  }

  it('writes standard annotations with appearances other viewers can show', async () => {
    const { bytes, annotations } = await annotated(false);
    const [first] = (await open(bytes)).pages;
    const byType = new Map(
      first!.annotations.map((annotation) => [annotation.subtype, annotation]),
    );
    expect([...byType.keys()].sort()).toEqual(
      [
        'Circle',
        'FreeText',
        'Highlight',
        'Line',
        'Square',
        'Stamp',
        'StrikeOut',
        'Text',
        'Underline',
        'Ink',
      ].sort(),
    );
    for (const annotation of first!.annotations) expect(annotation.hasAppearance).toBe(true);
    const highlight = byType.get('Highlight')!;
    expect(Array.from(highlight.color as Uint8ClampedArray)).toEqual([255, 212, 0]);
    expect(Array.from(highlight.quadPoints as Float32Array)).toEqual([
      72, 714, 172, 714, 72, 700, 172, 700,
    ]);
    expect((byType.get('Text')!.contentsObj as { str: string }).str).toBe('Check this ✓');
    expect((byType.get('FreeText')!.contentsObj as { str: string }).str).toBe(
      'Hello flattened world, this wraps',
    );
    // PDF.js normalizes /L, so read the arrow's direction from the file itself.
    expect(Array.from(byType.get('Line')!.lineCoordinates as Float32Array)).toEqual([
      100, 250, 200, 300,
    ]);
    expect(await rawAnnotationEntry(bytes, 'Line', 'L')).toBe('[ 100 300 200 250 ]');
    expect(await rawAnnotationEntry(bytes, 'Line', 'LE')).toBe('[ /None /OpenArrow ]');
    expect((byType.get('Ink')!.inkLists as Float32Array[]).map((list) => Array.from(list))).toEqual(
      [[100, 500, 150, 520, 200, 480]],
    );
    expect((byType.get('Square')!.titleObj as { str: string }).str).toBe('Ada');
    // Folio's ids travel with the annotations.
    const ids = new Set(annotations.map((annotation) => annotation.id));
    const streams = await allObjectText(bytes);
    expect(streams).toContain('/GS0 gs');
    expect(first!.annotations.length).toBe(ids.size);
    await expectValidPdf(bytes);
  });

  it('flattens annotations into the page content', async () => {
    const { bytes } = await annotated(true);
    const [first] = (await open(bytes)).pages;
    expect(first!.annotations).toEqual([]);
    expect(first!.text).toContain('Hello flattened world,');
    expect(first!.text).toContain('this wraps');
    await expectValidPdf(bytes);
  });

  it('places annotations relative to the crop box', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([600, 800]);
    page.setCropBox(50, 60, 500, 700);
    const bytes = await pdf.save();
    const model = await modelFrom(bytes, 'cropped.pdf');
    expect(model.pages[0]?.size).toEqual({ width: 500, height: 700 });
    const edited = applyOperation(model, {
      type: 'annotations/add',
      annotations: [
        {
          ...base(model.pages[0]!.id),
          kind: 'shape',
          shape: 'rectangle',
          rect: { x: 10, y: 20, width: 30, height: 40 },
          strokeWidth: 0,
          fill: '#000000',
        },
      ],
    }).model;
    const out = await exportPdf({
      model: edited,
      sources: new Map([[originalSourceId(model)!, { bytes }]]),
      assets: new Map(),
      now: NOW,
    });
    const [annotation] = (await open(out.bytes)).pages[0]!.annotations;
    expect(Array.from(annotation!.rect as number[])).toEqual([60, 80, 90, 120]);
  });

  it('keeps text added to a turned page level with how the page is shown', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const turned = applyOperation(model, {
      type: 'pages/rotate',
      pageIds: [model.pages[0]!.id],
      delta: 90,
    }).model;
    const edited = applyOperation(turned, {
      type: 'annotations/add',
      annotations: [
        {
          ...base(model.pages[0]!.id),
          kind: 'added-text',
          rect: { x: 300, y: 200, width: 40, height: 300 },
          text: 'Level on a turned page',
          fontSize: 14,
          fontFamily: 'sans',
          rotation: 90,
        },
      ],
    }).model;
    for (const flatten of [false, true]) {
      const { bytes } = await exportPdf({
        model: edited,
        sources,
        assets: new Map(),
        flatten,
        now: NOW,
      });
      const task = getDocument({ data: bytes.slice() });
      const doc = await task.promise;
      const page = await doc.getPage(1);
      expect(page.rotate).toBe(90);
      if (flatten) {
        const content = await page.getTextContent();
        const item = content.items.find(
          (entry) => 'str' in entry && entry.str.includes('Level on a turned page'),
        );
        // Baseline along the page's +y axis, which shows as left to right,
        // and glyphs rotated rather than mirrored.
        const [a, b, c, d] = (item as { transform: number[] }).transform;
        expect(a).toBeCloseTo(0);
        expect(b).toBeGreaterThan(0);
        expect(c).toBeLessThan(0);
        expect(d).toBeCloseTo(0);
      } else {
        const [annotation] = await page.getAnnotations();
        expect(annotation?.rotation).toBe(90);
      }
      await task.destroy();
    }
  });

  it('reports added text that the standard fonts cannot show', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const edited = applyOperation(model, {
      type: 'annotations/add',
      annotations: [
        {
          ...base(model.pages[0]!.id),
          kind: 'added-text',
          rect: { x: 72, y: 200, width: 200, height: 40 },
          text: 'Café 你好',
          fontSize: 12,
          fontFamily: 'sans',
          rotation: 0,
        },
      ],
    }).model;
    const { warnings, bytes } = await exportPdf({
      model: edited,
      sources,
      assets: new Map(),
      flatten: true,
      now: NOW,
    });
    expect(warnings).toEqual(['unsupported-characters']);
    expect((await open(bytes)).pages[0]!.text).toContain('Café ??');
  });
});

describe('exportPdf: document', () => {
  it('writes the metadata, keeping XMP consistent', async () => {
    const { model, sources } = await fixtureModel('basic-3-pages.pdf');
    const edited = applyOperation(model, {
      type: 'metadata/update',
      patch: { title: 'Quarterly “report”', author: 'Ada; Grace', keywords: ['finance', 'q1'] },
    }).model;
    const { bytes } = await exportPdf({ model: edited, sources, assets: new Map(), now: NOW });
    const handle = await engine.open(bytes);
    expect(handle.info.metadata).toMatchObject({
      title: 'Quarterly “report”',
      author: 'Ada; Grace',
      keywords: ['finance', 'q1'],
      producer: 'Folio',
      modificationDate: NOW.toISOString(),
    });
    await handle.destroy();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const xmpRef = doc.catalog.get(PDFName.of('Metadata'));
    if (xmpRef) {
      const xmp = new TextDecoder().decode((doc.context.lookup(xmpRef) as PDFStream).getContents());
      expect(xmp).toContain('Quarterly “report”');
      expect(xmp).not.toContain('Folio Basic Fixture');
    }
  });

  it('keeps protected documents protected with the same password and permissions', async () => {
    const { model, sources } = await fixtureModel('encrypted-user-password.pdf', FIXTURE_PASSWORD);
    const permissions = {
      print: true,
      copy: false,
      modify: false,
      annotate: true,
      fillForms: true,
      assemble: false,
    };
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      protection: { userPassword: FIXTURE_PASSWORD, permissions },
      now: NOW,
    });
    await expect(open(bytes)).rejects.toThrow(/password/i);
    const result = await open(bytes, FIXTURE_PASSWORD);
    expect(result.pages).toHaveLength(3);
    expect(result.permissions).not.toBeNull();
    const handle = await engine.open(bytes, { password: FIXTURE_PASSWORD });
    expect(handle.info.permissions).toEqual(permissions);
    await handle.destroy();
  });

  it('opens owner-restricted documents with the empty password and keeps their restrictions', async () => {
    const { model, sources } = await fixtureModel('encrypted-owner-restricted.pdf', '');
    const handle = await engine.open(readFixture('encrypted-owner-restricted.pdf'));
    const permissions = handle.info.permissions;
    await handle.destroy();
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      protection: { userPassword: '', permissions },
      now: NOW,
    });
    const reopened = await engine.open(bytes);
    expect(reopened.info.permissions).toEqual(permissions);
    await reopened.destroy();
  });
});
