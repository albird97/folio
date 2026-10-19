import {
  canRedo,
  isDirty,
  serializeRecoverySnapshot,
  sourcePageKey,
  undoLabel,
  type FormFieldId,
  type SourceId,
} from '@folio/document-model';
import { decodePDFRawStream, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { createPdfEngine } from '@folio/pdf-core';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import { nodeWorkerSrc, readFixture, type FixtureName } from '../../../../tests/setup/fixtures';
import { PERMISSION_MESSAGES } from './editing';
import { createWorkspaceStore, type WorkspaceStore } from './workspace';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

async function open(name: string, bytes: Uint8Array) {
  const store = createWorkspaceStore(engine);
  await store.getState().openFiles([memoryFile(name, bytes)]);
  return { store, key: store.getState().documents[0]!.key };
}

const openFixture = (name: FixtureName) => open(name, readFixture(name));

const doc = (store: WorkspaceStore, key: string) =>
  store.getState().documents.find((entry) => entry.key === key)!;

function fieldId(store: WorkspaceStore, key: string, name: string): FormFieldId {
  const field = Object.values(doc(store, key).editor!.model.formFields).find(
    (entry) => entry.name === name,
  );
  if (!field) throw new Error(`No field ${name}`);
  return field.id;
}

/** How often the fields of a page of the opened file changed. */
function revision(store: WorkspaceStore, key: string, pageIndex: number): number {
  const sourceId = Object.keys(doc(store, key).editor!.model.sources)[0] as SourceId;
  return doc(store, key).formRevision[sourcePageKey(sourceId, pageIndex)] ?? 0;
}

/** The form values of a saved file, read with pdf-lib. */
async function savedValues(bytes: Uint8Array) {
  const form = (await PDFDocument.load(bytes, { updateMetadata: false })).getForm();
  return {
    name: form.getTextField('name').getText() ?? '',
    agree: form.getCheckBox('agree').isChecked(),
    size: form.getRadioGroup('size').getSelected() ?? null,
    country: form.getDropdown('country').getSelected(),
    colors: form.getOptionList('colors').getSelected(),
  };
}

const latin1 = new TextDecoder('latin1');

/** Every stream of a file, decoded, to find text drawn in appearances. */
async function streamText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let text = '';
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      try {
        text += latin1.decode(decodePDFRawStream(object).decode());
      } catch {
        // Fonts and images may use filters that are not decoded here.
      }
    }
  }
  return text;
}

/** The form fixture with restrictions, opened without a password like such files are. */
async function restrictedForm(permissions: { fillingForms: boolean; annotating: boolean }) {
  const pdf = await PDFDocument.load(readFixture('form-fields.pdf'), { updateMetadata: false });
  pdf.encrypt({ userPassword: '', ownerPassword: 'folio-owner', permissions });
  return pdf.save({ useObjectStreams: true, updateFieldAppearances: false });
}

describe('workspace store: forms', () => {
  it('reads the form with the document and fills it in, one undo step per field', async () => {
    const { store, key } = await openFixture('form-fields.pdf');
    const state = () => store.getState();
    expect(doc(store, key).info?.forms).toBe('acroform');
    expect(Object.values(doc(store, key).editor!.model.formFields)).toHaveLength(10);
    const name = fieldId(store, key, 'name');

    for (const text of ['A', 'Ad', 'Ada']) {
      expect(state().fillFormField(key, name, text, 'Full name')).toBe(true);
    }
    const editor = doc(store, key).editor!;
    expect(editor.history.past).toHaveLength(1);
    expect(undoLabel(editor)).toBe('Fill in Full name');
    expect(editor.model.formFields[name]!.value).toBe('Ada');
    expect(isDirty(editor)).toBe(true);
    // Each change draws the fields' page again, and only that page.
    expect(revision(store, key, 0)).toBe(3);
    expect(revision(store, key, 1)).toBe(0);

    // Another field is another step; its label defaults to its name.
    expect(state().fillFormField(key, fieldId(store, key, 'country'), 'Japan')).toBe(true);
    expect(undoLabel(doc(store, key).editor!)).toBe('Fill in country');
    expect(revision(store, key, 1)).toBe(1);

    // Nothing happens for values a field already has, read-only fields and signatures.
    expect(state().fillFormField(key, fieldId(store, key, 'country'), 'Japan')).toBe(false);
    expect(state().fillFormField(key, fieldId(store, key, 'id'), 'B-18')).toBe(false);
    expect(state().fillFormField(key, fieldId(store, key, 'signature'), 'x')).toBe(false);
    expect(doc(store, key).editor!.history.past).toHaveLength(2);
    expect(store.getState().notice).toBeNull();
    await store.destroy();
  });

  it('keeps pages and saved files in step through undo and redo', async () => {
    const { store, key } = await openFixture('form-fields.pdf');
    const state = () => store.getState();
    state().fillFormField(key, fieldId(store, key, 'name'), 'Ada Lovelace');
    state().fillFormField(key, fieldId(store, key, 'agree'), true);
    state().fillFormField(key, fieldId(store, key, 'size'), 'M');
    state().fillFormField(key, fieldId(store, key, 'colors'), ['Green', 'Yellow']);
    expect(await savedValues((await state().exportDocument(key)).bytes)).toEqual({
      name: 'Ada Lovelace',
      agree: true,
      size: 'M',
      country: [],
      colors: ['Green', 'Yellow'],
    });

    const before = revision(store, key, 0);
    state().undo(key);
    state().undo(key);
    expect(revision(store, key, 0)).toBe(before + 1);
    expect(await savedValues((await state().exportDocument(key)).bytes)).toMatchObject({
      name: 'Ada Lovelace',
      agree: true,
      size: null,
      colors: [],
    });
    state().undo(key);
    state().undo(key);
    // Back to the file's values: there is nothing to write into it.
    expect(isDirty(doc(store, key).editor!)).toBe(false);
    expect(await store.getHandle(key)!.saveFormValues()).toBeNull();
    expect(await savedValues((await state().exportDocument(key)).bytes)).toMatchObject({
      name: '',
      agree: false,
    });

    state().redo(key);
    state().redo(key);
    expect(canRedo(doc(store, key).editor!)).toBe(true);
    expect(await savedValues((await state().exportDocument(key)).bytes)).toMatchObject({
      name: 'Ada Lovelace',
      agree: true,
      size: null,
    });
    await store.destroy();
  });

  it('flattens the form and prints filled-in values', async () => {
    const { store, key } = await openFixture('form-fields.pdf');
    store.getState().fillFormField(key, fieldId(store, key, 'name'), 'Grace Hopper');
    const { bytes } = await store.getState().exportDocument(key, { flattenForms: true });
    const flat = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(flat.catalog.get(PDFName.of('AcroForm'))).toBeUndefined();
    const reopened = await engine.open(bytes);
    expect(reopened.info.forms).toBe('none');
    const text = (await reopened.getPageText(0)).items.map((item) => item.str).join(' ');
    expect(text).toContain('Grace Hopper');
    await reopened.destroy();

    // Printing writes the pages on their own, fields drawn as filled in.
    const first = doc(store, key).editor!.model.pages[0]!.id;
    const printed = await store.getState().exportDocument(key, {
      pageIds: [first],
      flatten: true,
      unprotected: true,
    });
    expect(await streamText(printed.bytes)).toContain('Grace Hopper');
    await store.destroy();
  });

  it('restores filled-in values from crash recovery', async () => {
    const { store, key } = await openFixture('form-fields.pdf');
    store.getState().fillFormField(key, fieldId(store, key, 'name'), 'Recovered name');
    store.getState().fillFormField(key, fieldId(store, key, 'size'), 'L');
    const { editor, view } = doc(store, key);
    const sourceId = Object.keys(editor!.model.sources)[0] as SourceId;
    const record = {
      snapshot: serializeRecoverySnapshot(editor!, view!),
      files: new Map([
        [editor!.model.sources[sourceId]!.sha256, store.getSourceBytes(key, sourceId)!],
      ]),
    };

    const restoredStore = createWorkspaceStore(engine);
    const outcome = await restoredStore
      .getState()
      .restoreDocument({ ...record, recoveryId: 'doc-form' });
    expect(outcome.status).toBe('restored');
    const restoredKey = (outcome as { key: string }).key;
    expect(doc(restoredStore, restoredKey).editor!.model.formFields).toEqual(
      editor!.model.formFields,
    );
    // The engine draws and saves the recovered values.
    expect(await restoredStore.getHandle(restoredKey)!.saveFormValues()).not.toBeNull();
    const { bytes } = await restoredStore.getState().exportDocument(restoredKey);
    expect(await savedValues(bytes)).toMatchObject({ name: 'Recovered name', size: 'L' });
    // And undoes them like the original would.
    restoredStore.getState().undo(restoredKey);
    const undone = await restoredStore.getState().exportDocument(restoredKey);
    expect(await savedValues(undone.bytes)).toMatchObject({ name: 'Recovered name', size: null });
    await restoredStore.destroy();
    await store.destroy();
  });

  it('follows the permission to fill in forms', async () => {
    const forbidden = await open(
      'restricted.pdf',
      await restrictedForm({ fillingForms: false, annotating: false }),
    );
    expect(doc(forbidden.store, forbidden.key).permissions.fillForms).toBe(false);
    const name = fieldId(forbidden.store, forbidden.key, 'name');
    expect(forbidden.store.getState().fillFormField(forbidden.key, name, 'Ada')).toBe(false);
    expect(forbidden.store.getState().notice?.message).toBe(PERMISSION_MESSAGES.fillForms);
    expect(doc(forbidden.store, forbidden.key).editor!.history.past).toHaveLength(0);
    await forbidden.store.destroy();

    // Permission to change comments includes filling in the form.
    const commenting = await open(
      'commenting.pdf',
      await restrictedForm({ fillingForms: false, annotating: true }),
    );
    expect(doc(commenting.store, commenting.key).permissions.fillForms).toBe(true);
    const field = fieldId(commenting.store, commenting.key, 'name');
    expect(commenting.store.getState().fillFormField(commenting.key, field, 'Ada')).toBe(true);
    await commenting.store.destroy();
  });

  it('fills in nothing in XFA forms', async () => {
    const { store, key } = await openFixture('xfa-form.pdf');
    expect(doc(store, key).info?.forms).toBe('xfa');
    expect(doc(store, key).editor!.model.formFields).toEqual({});
    await store.destroy();
  });
});
