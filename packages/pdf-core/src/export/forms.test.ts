import {
  applyOperation,
  createDocumentModel,
  newAnnotationId,
  newPageId,
  type DocumentModel,
  type SourceId,
} from '@folio/document-model';
import {
  decodePDFRawStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  type PDFArray,
} from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeWorkerSrc, qpdfCheck, readFixture } from '../../../../tests/setup/fixtures';
import { toSourceDescriptor } from '../descriptor';
import { createPdfEngine } from '../engine';
import { sha256Hex } from '../hash';
import { exportPdf, originalSourceId, type ExportSource } from './export';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const NOW = new Date('2026-03-01T12:00:00Z');

async function expectValidPdf(bytes: Uint8Array) {
  const result = await qpdfCheck(bytes);
  if (!result) {
    expect(process.env.CI, 'qpdf must be installed on CI').toBeFalsy();
    return;
  }
  expect(result.ok, result.output).toBe(true);
}

/** A model of `bytes` and its sources, as the workspace makes them. */
async function document(bytes: Uint8Array, fileName: string) {
  const handle = await engine.open(bytes);
  const model = createDocumentModel({
    ...toSourceDescriptor(handle.info, {
      fileName,
      byteLength: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      origin: { kind: 'generated' },
    }),
    formFields: await handle.getFormFields(),
  });
  await handle.destroy();
  const id = originalSourceId(model)!;
  return { model, sources: new Map<SourceId, ExportSource>([[id, { bytes }]]), sourceId: id };
}

/** The form fixture filled in through the engine, as the workspace saves it. */
async function filledForm(): Promise<Uint8Array> {
  const handle = await engine.open(readFixture('form-fields.pdf'));
  await handle.getFormFields();
  handle.setFormValues([
    ['name', 'Ada Lovelace'],
    ['notes', 'Flattened notes'],
    ['agree', true],
    ['size', 'L'],
    ['country', 'Netherlands'],
    ['colors', ['Blue']],
  ]);
  const bytes = (await handle.saveFormValues())!;
  await handle.destroy();
  return bytes;
}

/** Text and widget annotations of every page, and whether the file still has a form. */
async function read(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const pages = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    const annotations = (await page.getAnnotations()) as Array<{ subtype: string }>;
    pages.push({
      text: content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' '),
      widgets: annotations.filter((annotation) => annotation.subtype === 'Widget').length,
      annotations: annotations.map((annotation) => annotation.subtype),
    });
  }
  const { info } = await pdf.getMetadata();
  await task.destroy();
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    pages,
    acroForm: (info as { IsAcroFormPresent?: boolean }).IsAcroFormPresent === true,
    catalogForm: doc.catalog.get(PDFName.of('AcroForm')) !== undefined,
  };
}

function duplicateFirstPage(model: DocumentModel): DocumentModel {
  const copy = { ...model.pages[0]!, id: newPageId() };
  return applyOperation(model, {
    type: 'pages/insert',
    entries: [{ index: 1, page: copy }],
    annotations: [],
    sources: [],
  }).model;
}

describe('exportPdf: forms', () => {
  it('keeps filled-in fields fillable unless asked to flatten them', async () => {
    const { model, sources } = await document(await filledForm(), 'form.pdf');
    const { bytes } = await exportPdf({ model, sources, assets: new Map(), now: NOW });
    const result = await read(bytes);
    expect(result.acroForm).toBe(true);
    expect(result.pages.map((page) => page.widgets)).toEqual([8, 4]);
    const form = (await PDFDocument.load(bytes, { updateMetadata: false })).getForm();
    expect(form.getTextField('name').getText()).toBe('Ada Lovelace');
    expect(form.getRadioGroup('size').getSelected()).toBe('L');
    expect(form.getOptionList('colors').getSelected()).toEqual(['Blue']);
    await expectValidPdf(bytes);
  });

  it('draws the fields into the pages and leaves the form out', async () => {
    const { model, sources } = await document(await filledForm(), 'form.pdf');
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      flattenForms: true,
      now: NOW,
    });
    const result = await read(bytes);
    expect(result.acroForm).toBe(false);
    expect(result.catalogForm).toBe(false);
    expect(result.pages.map((page) => page.widgets)).toEqual([0, 0]);
    // The values are now page content.
    expect(result.pages[0]!.text).toContain('Ada Lovelace');
    expect(result.pages[0]!.text).toContain('Flattened notes');
    expect(result.pages[1]!.text).toContain('Netherlands');
    expect(result.pages[1]!.text).toContain('A-17');
    // The fields' dictionaries went with the form.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict) expect(object.get(PDFName.of('FT'))).toBeUndefined();
    }
    await expectValidPdf(bytes);
  });

  it('flattens every copy of a duplicated page', async () => {
    const { model, sources } = await document(await filledForm(), 'form.pdf');
    const { bytes } = await exportPdf({
      model: duplicateFirstPage(model),
      sources,
      assets: new Map(),
      flattenForms: true,
      now: NOW,
    });
    const result = await read(bytes);
    expect(result.pages.map((page) => page.widgets)).toEqual([0, 0, 0]);
    expect(result.pages.map((page) => page.text.includes('Ada Lovelace'))).toEqual([
      true,
      true,
      false,
    ]);
    await expectValidPdf(bytes);
  });

  it('flattens fields on pages inserted from other files', async () => {
    const { model, sources } = await document(readFixture('basic-3-pages.pdf'), 'basic.pdf');
    const other = await document(readFixture('filled-form.pdf'), 'filled.pdf');
    const page = { ...other.model.pages[0]!, id: newPageId() };
    const edited = applyOperation(model, {
      type: 'pages/insert',
      entries: [{ index: 1, page }],
      annotations: [],
      sources: [other.model.sources[other.sourceId]!],
    }).model;
    const { bytes } = await exportPdf({
      model: edited,
      sources: new Map([...sources, ...other.sources]),
      assets: new Map(),
      flattenForms: true,
      now: NOW,
    });
    const result = await read(bytes);
    expect(result.pages).toHaveLength(4);
    expect(result.pages[1]!.widgets).toBe(0);
    expect(result.pages[1]!.text).toContain('Ada Lovelace');
    await expectValidPdf(bytes);
  });

  it('draws comments flattened with the form over its fields', async () => {
    const { model, sources } = await document(await filledForm(), 'form.pdf');
    const pageId = model.pages[0]!.id;
    const edited = applyOperation(model, {
      type: 'annotations/add',
      annotations: [
        {
          id: newAnnotationId(),
          pageId,
          author: '',
          createdAt: NOW.toISOString(),
          modifiedAt: NOW.toISOString(),
          color: '#1f2328',
          opacity: 1,
          kind: 'added-text',
          rect: { x: 360, y: 640, width: 200, height: 24 },
          text: 'Checked by Grace',
          fontSize: 12,
          fontFamily: 'sans',
          rotation: 0,
        },
      ],
    }).model;
    const { bytes } = await exportPdf({
      model: edited,
      sources,
      assets: new Map(),
      flatten: true,
      flattenForms: true,
      now: NOW,
    });
    const result = await read(bytes);
    expect(result.pages[0]!.annotations).toEqual([]);
    const text = result.pages[0]!.text;
    expect(text.indexOf('Ada Lovelace')).toBeLessThan(text.indexOf('Checked by Grace'));
    await expectValidPdf(bytes);
  });

  it('leaves hidden fields out and keeps fields on optional content layers', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const form = pdf.getForm();
    const hidden = form.createTextField('hidden');
    hidden.setText('invisible value');
    hidden.addToPage(page, { x: 72, y: 700, width: 200, height: 24, font, hidden: true });
    const layered = form.createTextField('layered');
    layered.setText('layered value');
    layered.addToPage(page, { x: 72, y: 600, width: 200, height: 24, font });
    form.updateFieldAppearances(font);
    const group = pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: 'Answers' }));
    layered.acroField.getWidgets()[0]!.dict.set(PDFName.of('OC'), group);
    const source = await pdf.save();
    const { model, sources } = await document(source, 'layers.pdf');
    const { bytes } = await exportPdf({
      model,
      sources,
      assets: new Map(),
      flattenForms: true,
      now: NOW,
    });
    const result = await read(bytes);
    expect(result.pages[0]!.widgets).toBe(0);
    expect(result.pages[0]!.text).not.toContain('invisible value');
    expect(result.pages[0]!.text).toContain('layered value');
    const flat = await PDFDocument.load(bytes, { updateMetadata: false });
    const contents = flat.getPage(0).node.Contents() as PDFArray;
    const last = contents.lookup(contents.size() - 1) as PDFRawStream;
    expect(new TextDecoder().decode(decodePDFRawStream(last).decode())).toMatch(
      /^\/OC \/FlatOC[\w-]* BDC q .* cm \/FlatField[\w-]* Do Q EMC$/,
    );
    await expectValidPdf(bytes);
  });

  it('draws the fields of forms that leave drawing them to the reader', async () => {
    // A form without appearances, as some tools write them (NeedAppearances).
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([612, 792]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const form = pdf.getForm();
    for (const [index, name] of ['kept', 'typed', 'foreign'].entries()) {
      const field = form.createTextField(name);
      if (name === 'kept') field.setText('value from the file');
      field.addToPage(page, { x: 72, y: 700 - index * 60, width: 260, height: 24, font });
    }
    form.updateFieldAppearances(font);
    for (const field of form.getFields()) {
      for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of('AP'));
    }
    form.acroForm.dict.set(PDFName.of('NeedAppearances'), pdf.context.obj(true));
    const source = await pdf.save({ updateFieldAppearances: false });

    // PDF.js saves what is typed without appearances into such forms.
    const handle = await engine.open(source);
    await handle.getFormFields();
    handle.setFormValues([
      ['typed', 'typed in Folio'],
      ['foreign', 'Grüße 你好'],
    ]);
    const filled = (await handle.saveFormValues())!;
    await handle.destroy();
    const { model, sources } = await document(filled, 'drawn-by-readers.pdf');

    const flat = await exportPdf({ model, sources, assets: new Map(), flattenForms: true });
    const text = (await read(flat.bytes)).pages[0]!.text;
    expect(text).toContain('value from the file');
    expect(text).toContain('typed in Folio');
    // Characters the standard font cannot show become "?", and the save says so.
    expect(text).toContain('Grüße ??');
    expect(flat.warnings).toEqual(['unsupported-form-characters']);
    await expectValidPdf(flat.bytes);

    // Printing copies the pages out, without the form: the widgets carry what they show.
    const copied = await exportPdf({
      model,
      sources,
      assets: new Map(),
      pageIds: [model.pages[0]!.id],
    });
    const doc = await PDFDocument.load(copied.bytes, { updateMetadata: false });
    const drawn = doc
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((ref) => {
        const ap = (doc.context.lookup(ref) as PDFDict).lookupMaybe(PDFName.of('AP'), PDFDict);
        const normal = ap && doc.context.lookup(ap.get(PDFName.of('N')));
        return normal instanceof PDFRawStream
          ? new TextDecoder('latin1').decode(decodePDFRawStream(normal).decode())
          : '';
      })
      .join('\n')
      // pdf-lib writes the text as hex strings.
      .replace(/<([0-9A-F]+)> Tj/g, (_, hex: string) =>
        String.fromCharCode(...(hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16))),
      );
    expect(drawn).toContain('value from the file');
    expect(drawn).toContain('typed in Folio');
    await expectValidPdf(copied.bytes);
  });
});
