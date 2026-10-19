import { describe, expect, it } from 'vitest';
import { createDocumentModel, createViewState } from './create';
import { createEditorState, execute, undo } from './history';
import { newAssetId, type FormFieldId, type SourceId } from './ids';
import { applyOperation, OperationError, type Operation } from './operations';
import { parseRecoverySnapshot, serializeRecoverySnapshot } from './serialization';
import { descriptor } from './test-helpers';
import {
  sourcePageKey,
  type AssetRef,
  type DocumentModel,
  type PageNumberStamp,
  type WatermarkStamp,
} from './types';

/** A model with one field of each fillable type, as a form PDF would give. */
function formModel(): DocumentModel {
  return createDocumentModel(
    descriptor(2, {
      formFields: [
        { name: 'name', type: 'text', pageIndex: 0, value: '', readOnly: false },
        { name: 'agree', type: 'checkbox', pageIndex: 0, value: false, readOnly: false },
        { name: 'size', type: 'radio', pageIndex: 1, value: null, readOnly: false },
        { name: 'colors', type: 'choice', pageIndex: 1, value: [], readOnly: false },
        { name: 'id', type: 'text', pageIndex: 1, value: 'A-17', readOnly: true },
        { name: 'sig', type: 'signature', pageIndex: null, value: null, readOnly: false },
      ],
    }),
  );
}

function fieldId(model: DocumentModel, name: string): FormFieldId {
  const field = Object.values(model.formFields).find((entry) => entry.name === name);
  if (!field) throw new Error(`No field ${name}`);
  return field.id;
}

function expectRoundTrip(model: DocumentModel, operation: Operation): DocumentModel {
  const forward = applyOperation(model, operation);
  expect(applyOperation(forward.model, forward.inverse).model).toEqual(model);
  return forward.model;
}

function expectError(model: DocumentModel, operation: Operation, code: OperationError['code']) {
  try {
    applyOperation(model, operation);
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe(code);
  }
}

const PAGE_NUMBERS: PageNumberStamp = {
  format: 'Page {page} of {total}',
  position: 'bottom-center',
  fontFamily: 'sans',
  fontSize: 10,
  color: '#1f2328',
  margin: 24,
  startNumber: 1,
  pages: { from: 1, to: null },
};

const WATERMARK: WatermarkStamp = {
  text: 'CONFIDENTIAL',
  position: 'center',
  fontFamily: 'sans',
  fontSize: 72,
  color: '#e03131',
  opacity: 0.2,
  angle: 45,
  layer: 'over',
  margin: 36,
  pages: { from: 1, to: null },
};

const jsonAsset = (): AssetRef => ({
  id: newAssetId(),
  mimeType: 'application/json',
  byteLength: 120,
  sha256: 'b'.repeat(64),
});

describe('form fields', () => {
  it('creates fields from the file, on the pages of their first widgets', () => {
    const model = formModel();
    const fields = Object.values(model.formFields);
    expect(fields.map((field) => field.name)).toEqual([
      'name',
      'agree',
      'size',
      'colors',
      'id',
      'sig',
    ]);
    expect(fields[0]!.pageId).toBe(model.pages[0]!.id);
    expect(fields[2]!.pageId).toBe(model.pages[1]!.id);
    expect(fields[5]!.pageId).toBeNull();
  });

  it('fills fields and undoes back to the values from the file', () => {
    const model = formModel();
    const filled = expectRoundTrip(model, {
      type: 'forms/set-values',
      values: [
        { id: fieldId(model, 'name'), value: 'Ada Lovelace' },
        { id: fieldId(model, 'agree'), value: true },
        { id: fieldId(model, 'size'), value: 'M' },
        { id: fieldId(model, 'colors'), value: ['red', 'blue'] },
      ],
    });
    expect(filled.formFields[fieldId(model, 'name')]!.value).toBe('Ada Lovelace');
    expect(filled.formFields[fieldId(model, 'colors')]!.value).toEqual(['red', 'blue']);
    expect(model.formFields[fieldId(model, 'agree')]!.value).toBe(false);
  });

  it('refuses unknown and read-only fields, and values of the wrong kind', () => {
    const model = formModel();
    const set = (name: string, value: unknown): Operation =>
      ({ type: 'forms/set-values', values: [{ id: fieldId(model, name), value }] }) as Operation;
    expectError(
      model,
      {
        type: 'forms/set-values',
        values: [{ id: 'field_000000000000000000000000' as FormFieldId, value: 'x' }],
      },
      'unknown-field',
    );
    expectError(model, set('id', 'B-2'), 'read-only-field');
    expectError(model, set('agree', 'yes'), 'invalid-value');
    expectError(model, set('name', true), 'invalid-value');
    expectError(model, set('sig', 'signed'), 'invalid-value');
    expectError(model, { type: 'forms/set-values', values: [] }, 'empty-operation');
  });

  it('merges typing into one field into one undo step', () => {
    const model = formModel();
    const id = fieldId(model, 'name');
    let state = createEditorState(model);
    for (const value of ['A', 'Ad', 'Ada']) {
      state = execute(
        state,
        { type: 'forms/set-values', values: [{ id, value }] },
        { label: 'Fill in name', coalesceKey: `form:${id}`, now: 1000 },
      );
    }
    expect(state.history.past).toHaveLength(1);
    expect(state.model.formFields[id]!.value).toBe('Ada');
    expect(undo(state).model.formFields[id]!.value).toBe('');
  });
});

describe('page numbers and watermarks', () => {
  it('sets, replaces and clears stamps one key at a time', () => {
    const model = formModel();
    expect(model.stamps).toEqual({ pageNumbers: null, watermark: null });
    const numbered = expectRoundTrip(model, {
      type: 'stamps/set',
      stamps: { pageNumbers: PAGE_NUMBERS },
    });
    expect(numbered.stamps).toEqual({ pageNumbers: PAGE_NUMBERS, watermark: null });
    const both = expectRoundTrip(numbered, {
      type: 'stamps/set',
      stamps: { watermark: WATERMARK },
    });
    expect(both.stamps.pageNumbers).toEqual(PAGE_NUMBERS);
    const cleared = expectRoundTrip(both, { type: 'stamps/set', stamps: { pageNumbers: null } });
    expect(cleared.stamps).toEqual({ pageNumbers: null, watermark: WATERMARK });
    expectError(model, { type: 'stamps/set', stamps: {} }, 'empty-operation');
  });
});

describe('recognized text', () => {
  it('sets and removes the text of source pages', () => {
    const model = formModel();
    const sourceId = Object.keys(model.sources)[0] as SourceId;
    const asset = jsonAsset();
    const key = sourcePageKey(sourceId, 1);
    const layer = { assetId: asset.id, languages: 'eng+ind', wordCount: 42 };
    const forward = applyOperation(model, {
      type: 'text-layers/set',
      entries: [{ key, layer }],
      assets: [asset],
    });
    expect(forward.model.textLayers[key]).toEqual(layer);
    expect(forward.model.assets[asset.id]).toEqual(asset);
    // Undo keeps the data registered, like images, so redo can use it.
    const back = applyOperation(forward.model, forward.inverse).model;
    expect(back.textLayers).toEqual({});
    expect(back.assets[asset.id]).toEqual(asset);
    const removed = applyOperation(forward.model, {
      type: 'text-layers/set',
      entries: [{ key, layer: null }],
    }).model;
    expect(removed.textLayers).toEqual({});
  });

  it('refuses pages that do not exist and data that was not registered', () => {
    const model = formModel();
    const sourceId = Object.keys(model.sources)[0] as SourceId;
    const asset = jsonAsset();
    const layer = { assetId: asset.id, languages: 'eng', wordCount: 1 };
    expectError(
      model,
      {
        type: 'text-layers/set',
        entries: [{ key: sourcePageKey(sourceId, 9), layer }],
        assets: [asset],
      },
      'invalid-index',
    );
    expectError(
      model,
      {
        type: 'text-layers/set',
        entries: [{ key: 'src_ffffffffffffffffffffffff:0', layer }],
        assets: [asset],
      },
      'unknown-source',
    );
    expectError(
      model,
      { type: 'text-layers/set', entries: [{ key: sourcePageKey(sourceId, 0), layer }] },
      'unknown-asset',
    );
  });
});

describe('recovery snapshots with document content', () => {
  it('round-trips form values, stamps and recognized text with their history', () => {
    const model = formModel();
    const sourceId = Object.keys(model.sources)[0] as SourceId;
    const asset = jsonAsset();
    let state = createEditorState(model);
    state = execute(
      state,
      { type: 'forms/set-values', values: [{ id: fieldId(model, 'name'), value: '李白' }] },
      { label: 'Fill in name' },
    );
    state = execute(
      state,
      { type: 'stamps/set', stamps: { pageNumbers: PAGE_NUMBERS, watermark: WATERMARK } },
      { label: 'Add page numbers' },
    );
    state = execute(
      state,
      {
        type: 'text-layers/set',
        entries: [
          {
            key: sourcePageKey(sourceId, 0),
            layer: { assetId: asset.id, languages: 'chi_sim', wordCount: 3 },
          },
        ],
        assets: [asset],
      },
      { label: 'Recognize text' },
    );
    const view = createViewState(state.model);
    expect(parseRecoverySnapshot(serializeRecoverySnapshot(state, view)).editor).toEqual(state);
  });

  it('reads snapshots written before stamps and recognized text existed', () => {
    const state = createEditorState(formModel());
    const old = JSON.parse(serializeRecoverySnapshot(state, createViewState(state.model)));
    delete old.editor.model.stamps;
    delete old.editor.model.textLayers;
    const restored = parseRecoverySnapshot(JSON.stringify(old));
    expect(restored.editor.model.stamps).toEqual({ pageNumbers: null, watermark: null });
    expect(restored.editor.model.textLayers).toEqual({});
  });

  it('refuses recognized text whose data is missing', () => {
    const model = formModel();
    const sourceId = Object.keys(model.sources)[0] as SourceId;
    const asset = jsonAsset();
    const state = execute(
      createEditorState(model),
      {
        type: 'text-layers/set',
        entries: [
          {
            key: sourcePageKey(sourceId, 0),
            layer: { assetId: asset.id, languages: 'eng', wordCount: 3 },
          },
        ],
        assets: [asset],
      },
      { label: 'Recognize text' },
    );
    const snapshot = JSON.parse(serializeRecoverySnapshot(state, createViewState(state.model)));
    delete snapshot.editor.model.assets[asset.id];
    expect(() => parseRecoverySnapshot(JSON.stringify(snapshot))).toThrowError(
      expect.objectContaining({ code: 'inconsistent' }) as Error,
    );
  });
});
