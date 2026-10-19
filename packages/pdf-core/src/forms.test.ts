import {
  decodePDFRawStream,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
} from '@cantoo/pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeWorkerSrc, qpdfCheck, readFixture } from '../../../tests/setup/fixtures';
import { createPdfEngine } from './engine';
import { PdfError } from './errors';
import {
  indexFields,
  sameFieldValue,
  storedValues,
  widgetFrom,
  type FieldObjectLike,
  type FormFieldEntry,
} from './forms';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const FORM_PASSWORD = 'folio-form';

/** `qpdf --check` must pass; qpdf is required on CI and optional locally. */
async function expectValidPdf(bytes: Uint8Array) {
  const result = await qpdfCheck(bytes);
  if (!result) {
    expect(process.env.CI, 'qpdf must be installed on CI').toBeFalsy();
    return;
  }
  expect(result.ok, result.output).toBe(true);
}

/** The form fixture, encrypted (in object streams, which keep pdf-lib's strings readable). */
async function encryptedForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(readFixture('form-fields.pdf'), { updateMetadata: false });
  doc.encrypt({
    userPassword: FORM_PASSWORD,
    ownerPassword: `${FORM_PASSWORD}-owner`,
    permissions: { fillingForms: true, printing: 'highResolution' },
  });
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

const latin1 = new TextDecoder('latin1');

/** The decoded normal appearance of a field's first widget, or its state name for buttons. */
function appearanceOf(doc: PDFDocument, name: string): string {
  const widget = doc.getForm().getField(name).acroField.getWidgets()[0]!;
  const normal = widget.getAppearances()?.normal;
  if (normal instanceof PDFRawStream) return latin1.decode(decodePDFRawStream(normal).decode());
  return widget.getAppearanceState()?.decodeText() ?? '';
}

describe('form fields: reading', () => {
  it('reads every field of a form with its first page and value', async () => {
    const handle = await engine.open(readFixture('form-fields.pdf'));
    expect(handle.info.forms).toBe('acroform');
    expect(await handle.getFormFields()).toEqual([
      { name: 'name', type: 'text', pageIndex: 0, value: '', readOnly: false },
      { name: 'notes', type: 'text', pageIndex: 0, value: '', readOnly: false },
      { name: 'code', type: 'text', pageIndex: 0, value: '', readOnly: false },
      { name: 'pin', type: 'text', pageIndex: 0, value: '', readOnly: false },
      { name: 'agree', type: 'checkbox', pageIndex: 0, value: false, readOnly: false },
      { name: 'size', type: 'radio', pageIndex: 0, value: null, readOnly: false },
      { name: 'country', type: 'choice', pageIndex: 1, value: null, readOnly: false },
      { name: 'colors', type: 'choice', pageIndex: 1, value: [], readOnly: false },
      { name: 'id', type: 'text', pageIndex: 1, value: 'A-17', readOnly: true },
      { name: 'signature', type: 'signature', pageIndex: 1, value: null, readOnly: false },
    ]);
    await handle.destroy();
  });

  it('reads the values a filled-in form was saved with', async () => {
    const handle = await engine.open(readFixture('filled-form.pdf'));
    expect(await handle.getFormFields()).toEqual([
      { name: 'name', type: 'text', pageIndex: 0, value: 'Ada Lovelace', readOnly: false },
      { name: 'agree', type: 'checkbox', pageIndex: 0, value: true, readOnly: false },
    ]);
    await handle.destroy();
  });

  it('reads no fields from documents without a form or with an XFA form', async () => {
    for (const name of ['basic-3-pages.pdf', 'xfa-form.pdf'] as const) {
      const handle = await engine.open(readFixture(name));
      expect(handle.info.forms).toBe(name === 'xfa-form.pdf' ? 'xfa' : 'none');
      expect(await handle.getFormFields()).toEqual([]);
      // Nothing can be filled in either.
      expect(handle.setFormValues([['form1[0].name[0]', 'Changed']])).toEqual([]);
      expect(await handle.saveFormValues()).toBeNull();
      await handle.destroy();
    }
  });

  it('reads the widgets of a page in annotation order, in page space', async () => {
    const handle = await engine.open(readFixture('form-fields.pdf'));
    const one = await handle.getFormWidgets(0);
    expect(one.map((widget) => [widget.fieldName, widget.type])).toEqual([
      ['name', 'text'],
      ['notes', 'text'],
      ['code', 'text'],
      ['pin', 'text'],
      ['agree', 'checkbox'],
      ['size', 'radio'],
      ['size', 'radio'],
      ['size', 'radio'],
    ]);
    expect(one[0]).toMatchObject({
      description: 'Full name',
      rect: { x: 71.5, y: 639.5, width: 261, height: 25 },
      rotation: 0,
      hidden: false,
      multiLine: false,
      password: false,
      comb: false,
      maxLength: null,
      alignment: 'left',
      fontSize: 12,
      color: '#000000',
    });
    expect(one[1]).toMatchObject({ multiLine: true, fontSize: 11, description: '' });
    expect(one[2]).toMatchObject({ comb: true, maxLength: 5 });
    expect(one[3]).toMatchObject({ password: true });
    expect(one[4]).toMatchObject({ exportValue: 'Yes' });
    expect(one.slice(5).map((widget) => 'exportValue' in widget && widget.exportValue)).toEqual([
      'S',
      'M',
      'L',
    ]);
    // Each widget is its own annotation.
    expect(new Set(one.map((widget) => widget.id)).size).toBe(one.length);

    const two = await handle.getFormWidgets(1);
    expect(two.map((widget) => [widget.fieldName, widget.type])).toEqual([
      ['country', 'choice'],
      ['colors', 'choice'],
      ['id', 'text'],
      ['signature', 'signature'],
    ]);
    expect(two[0]).toMatchObject({
      combo: true,
      multiSelect: false,
      options: [
        { value: 'Indonesia', label: 'Indonesia' },
        { value: 'Japan', label: 'Japan' },
        { value: 'Netherlands', label: 'Netherlands' },
      ],
    });
    expect(two[1]).toMatchObject({ combo: false, multiSelect: true });
    expect(two[3]!.rect).toEqual({ x: 72, y: 376, width: 220, height: 64 });
    await expect(handle.getFormWidgets(2)).rejects.toThrow(RangeError);
    await handle.destroy();
  });

  it('places widgets relative to the visible area of the page', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([612, 792]);
    page.setCropBox(50, 100, 512, 592);
    const field = pdf.getForm().createTextField('cropped');
    field.addToPage(page, { x: 150, y: 400, width: 100, height: 20, borderWidth: 0 });
    pdf.getForm().updateFieldAppearances(await pdf.embedFont(StandardFonts.Helvetica));
    const handle = await engine.open(await pdf.save());
    const [widget] = await handle.getFormWidgets(0);
    expect(widget?.rect).toEqual({ x: 100, y: 300, width: 100, height: 20 });
    await handle.destroy();
  });

  it('treats signed signature fields as read-only', async () => {
    const doc = await PDFDocument.load(readFixture('form-fields.pdf'), { updateMetadata: false });
    const field = doc.getForm().getField('signature').acroField.dict;
    // A signature value as signing tools write it (the bytes do not need to verify here).
    field.set(
      PDFName.of('V'),
      doc.context.obj({
        Type: 'Sig',
        Filter: 'Adobe.PPKLite',
        SubFilter: 'adbe.pkcs7.detached',
        ByteRange: [0, 100, 200, 100],
        Contents: PDFString.of('signature bytes'),
      }),
    );
    doc.getForm().acroForm.dict.set(PDFName.of('SigFlags'), doc.context.obj(3));
    const handle = await engine.open(await doc.save({ updateFieldAppearances: false }));
    expect(handle.info.hasSignatures).toBe(true);
    const fields = await handle.getFormFields();
    expect(fields.find((entry) => entry.name === 'signature')?.readOnly).toBe(true);
    expect(fields.find((entry) => entry.name === 'name')?.readOnly).toBe(false);
    await handle.destroy();
  });
});

describe('form fields: filling in and saving', () => {
  it('fills in every kind of field and saves the values with their appearances', async () => {
    const original = readFixture('form-fields.pdf');
    const handle = await engine.open(original);
    await handle.getFormFields();
    expect(await handle.saveFormValues()).toBeNull();
    expect(
      handle.setFormValues([
        ['name', 'Ada Lovelace'],
        ['notes', 'Line one\nLine two'],
        ['code', 'AB12'],
        ['agree', true],
        ['size', 'M'],
        ['country', 'Japan'],
        ['colors', ['Green', 'Yellow']],
      ]),
    ).toEqual([0, 1]);
    const saved = (await handle.saveFormValues())!;
    await handle.destroy();

    // An incremental update: the original file is kept as it was, before the changes.
    expect(saved.subarray(0, original.length)).toEqual(original);
    await expectValidPdf(saved);

    const doc = await PDFDocument.load(saved, { updateMetadata: false });
    const form = doc.getForm();
    expect(form.getTextField('name').getText()).toBe('Ada Lovelace');
    expect(form.getTextField('notes').getText()).toBe('Line one\nLine two');
    expect(form.getTextField('code').getText()).toBe('AB12');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
    expect(form.getRadioGroup('size').getSelected()).toBe('M');
    expect(form.getDropdown('country').getSelected()).toEqual(['Japan']);
    expect(form.getOptionList('colors').getSelected()).toEqual(['Green', 'Yellow']);
    // Other readers show the values: they have appearances to draw.
    expect(appearanceOf(doc, 'name')).toContain('Ada Lovelace');
    expect(appearanceOf(doc, 'notes')).toContain('Line two');
    expect(appearanceOf(doc, 'country')).toContain('Japan');
    expect(appearanceOf(doc, 'agree')).toBe('Yes');
    // pdf-lib names the radio buttons' "on" states by position (/Opt holds S, M, L).
    const radios = form.getRadioGroup('size').acroField.getWidgets();
    expect(radios.map((widget) => widget.getAppearanceState()?.decodeText() !== 'Off')).toEqual([
      false,
      true,
      false,
    ]);

    // Folio reads them back, including every option of the list box.
    const reopened = await engine.open(saved);
    const values = Object.fromEntries(
      (await reopened.getFormFields()).map((field) => [field.name, field.value]),
    );
    expect(values).toMatchObject({
      name: 'Ada Lovelace',
      notes: 'Line one\nLine two',
      code: 'AB12',
      agree: true,
      size: 'M',
      country: 'Japan',
      colors: ['Green', 'Yellow'],
      id: 'A-17',
    });
    await reopened.destroy();
  });

  it('leaves the file as it was once fields have its values again', async () => {
    const handle = await engine.open(readFixture('filled-form.pdf'));
    await handle.getFormFields();
    expect(handle.setFormValues([['agree', false]])).toEqual([0]);
    expect(await handle.saveFormValues()).not.toBeNull();
    // Back to the file's value: still a change on the page, but nothing to save.
    expect(handle.setFormValues([['agree', true]])).toEqual([0]);
    expect(await handle.saveFormValues()).toBeNull();
    await handle.destroy();
  });

  it('ignores unknown and read-only fields and values that do not fit', async () => {
    const handle = await engine.open(readFixture('form-fields.pdf'));
    // Values set before the fields are read cannot be placed.
    expect(handle.setFormValues([['name', 'Too early']])).toEqual([]);
    await handle.getFormFields();
    expect(
      handle.setFormValues([
        ['unknown', 'x'],
        ['agree', 'yes'],
        ['name', true],
        ['size', ['S']],
        ['colors', 'Red'],
        ['id', 'B-18'],
        ['signature', 'x'],
      ]),
    ).toEqual([]);
    expect(await handle.saveFormValues()).toBeNull();
    await handle.destroy();
  });

  it('never writes what is typed into password fields', async () => {
    const handle = await engine.open(readFixture('form-fields.pdf'));
    await handle.getFormFields();
    handle.setFormValues([
      ['pin', 'secret-pin'],
      ['name', 'Grace'],
    ]);
    const saved = (await handle.saveFormValues())!;
    await handle.destroy();
    const form = (await PDFDocument.load(saved, { updateMetadata: false })).getForm();
    expect(form.getTextField('name').getText()).toBe('Grace');
    expect(form.getTextField('pin').getText()).toBeUndefined();
    expect(latin1.decode(saved)).not.toContain('secret-pin');
  });

  it('keeps an encrypted form encrypted with the same password', async () => {
    const handle = await engine.open(await encryptedForm(), { password: FORM_PASSWORD });
    expect(handle.info.encryption).toBe('password-protected');
    await handle.getFormFields();
    handle.setFormValues([
      ['name', 'Ada Lovelace'],
      ['agree', true],
    ]);
    const saved = (await handle.saveFormValues())!;
    await handle.destroy();
    await expect(engine.open(saved)).rejects.toBeInstanceOf(PdfError);
    const reopened = await engine.open(saved, { password: FORM_PASSWORD });
    expect(reopened.info.encryption).toBe('password-protected');
    const values = Object.fromEntries(
      (await reopened.getFormFields()).map((field) => [field.name, field.value]),
    );
    expect(values).toMatchObject({ name: 'Ada Lovelace', agree: true });
    await reopened.destroy();
    const doc = await PDFDocument.load(saved, { password: FORM_PASSWORD, updateMetadata: false });
    expect(doc.getForm().getTextField('name').getText()).toBe('Ada Lovelace');
    // The value is not readable without the password.
    expect(latin1.decode(saved)).not.toContain('Ada Lovelace');
  });
});

describe('form field helpers', () => {
  const objects = (entries: Record<string, FieldObjectLike[]>) => new Map(Object.entries(entries));

  it('normalizes field values from field objects', () => {
    const fields = indexFields(
      objects({
        parent: [{ id: '1R', type: '', kidIds: ['2R'] } as FieldObjectLike],
        'parent.check': [
          { id: '2R', type: 'checkbox', value: 'Off', exportValues: 'Yes', editable: true },
          {
            id: '3R',
            type: 'checkbox',
            value: 'Yes',
            exportValues: 'Yes',
            editable: true,
            page: 2,
          },
        ],
        stale: [
          { id: '4R', type: 'radiobutton', value: 'Gone', exportValues: 'A', editable: true },
          { id: '5R', type: 'radiobutton', value: 'Gone', exportValues: 'B', editable: true },
        ],
        mixed: [
          { id: '6R', type: 'text', value: 'kept', editable: false },
          { id: '7R', type: 'checkbox', value: 'Yes', exportValues: 'Yes', editable: true },
        ],
        list: [{ id: '8R', type: 'listbox', value: 'a', multipleSelection: true, numItems: 2 }],
      }),
      new Set(),
      new Map([['list', ['a', 'c']]]),
    );
    expect(fields.map(({ name, type, value, readOnly }) => [name, type, value, readOnly])).toEqual([
      ['parent.check', 'checkbox', true, false],
      ['stale', 'radio', null, false],
      ['mixed', 'text', 'kept', true],
      ['list', 'choice', ['a', 'c'], false],
    ]);
    // A field of one type keeps only the widgets of that type.
    expect(fields[2]!.widgets.map((widget) => widget.id)).toEqual(['6R']);
    expect(fields[0]!.widgets.map((widget) => widget.pageIndex)).toEqual([-1, 2]);
  });

  it('stores what PDF.js draws and saves for each widget', () => {
    const field = (type: FormFieldEntry['type'], multiSelect = false): FormFieldEntry => ({
      name: 'f',
      type,
      multiSelect,
      widgets: [
        { id: '1R', pageIndex: 0, exportValue: 'A' },
        { id: '2R', pageIndex: 1, exportValue: 'B' },
      ],
      value: null,
      readOnly: false,
    });
    expect(storedValues(field('radio'), 'B')).toEqual([
      ['1R', { value: false }],
      ['2R', { value: true }],
    ]);
    expect(storedValues(field('radio'), null)?.map(([, entry]) => entry.value)).toEqual([
      false,
      false,
    ]);
    expect(storedValues(field('choice'), null)?.[0]).toEqual(['1R', { value: '' }]);
    expect(storedValues(field('choice', true), null)?.[0]).toEqual(['1R', { value: [] }]);
    expect(storedValues(field('checkbox'), true)?.[1]).toEqual(['2R', { value: true }]);
    expect(storedValues(field('text'), 1 as never)).toBeNull();
    expect(storedValues(field('choice', true), 'A')).toBeNull();
    expect(storedValues(field('signature'), null)).toBeNull();
    expect(storedValues(field('button'), null)).toBeNull();
  });

  it('compares values, list options in any order', () => {
    expect(sameFieldValue(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameFieldValue(['a'], ['a', 'b'])).toBe(false);
    expect(sameFieldValue('a', 'a')).toBe(true);
    expect(sameFieldValue(null, '')).toBe(false);
    expect(sameFieldValue(false, null)).toBe(false);
  });

  it('turns annotation data into widgets, refusing what is not usable', () => {
    const origin = { x: 10, y: 20 };
    const base = { id: '9R', fieldName: 'f', rect: [110, 220, 60, 120] };
    expect(
      widgetFrom({ ...base, fieldType: 'Tx', rotation: -90, textAlignment: 2 }, origin),
    ).toMatchObject({
      type: 'text',
      rect: { x: 50, y: 100, width: 50, height: 100 },
      rotation: 270,
      alignment: 'right',
      fontSize: 0,
    });
    expect(widgetFrom({ ...base, fieldType: 'Tx', rotation: 45 }, origin)?.rotation).toBe(0);
    expect(widgetFrom({ ...base, rect: [0, 0, 'x', 1], fieldType: 'Tx' }, origin)).toBeNull();
    expect(widgetFrom({ ...base, fieldType: 'Unknown' }, origin)).toBeNull();
    // A radio button without an "on" appearance cannot be chosen.
    expect(widgetFrom({ ...base, fieldType: 'Btn', radioButton: true }, origin)?.type).toBe(
      'button',
    );
    expect(
      widgetFrom(
        {
          ...base,
          fieldType: 'Ch',
          options: [{ exportValue: 'x', displayValue: 'Ex' }, { exportValue: 3 }],
          defaultAppearanceData: { fontSize: 9, fontColor: [255, 0, 16] },
        },
        origin,
      ),
    ).toMatchObject({ options: [{ value: 'x', label: 'Ex' }], fontSize: 9, color: '#ff0010' });
  });
});
