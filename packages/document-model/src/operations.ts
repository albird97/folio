import { addRotation, normalizeRotation, type Rotation } from './geometry';
import type { AnnotationId, FormFieldId, PageId } from './ids';
import type {
  Annotation,
  AssetRef,
  DocumentMetadata,
  DocumentModel,
  DocumentStamps,
  FormFieldType,
  FormFieldValue,
  PageModel,
  RecognizedText,
  SourceDocument,
} from './types';

/**
 * Every change to a {@link DocumentModel} is expressed as a serializable
 * operation. Applying an operation yields its inverse, which is what makes
 * undo/redo exact without snapshotting the document (or its PDF bytes).
 */
export type Operation =
  | { type: 'pages/rotate'; pageIds: PageId[]; delta: Rotation }
  | { type: 'pages/reorder'; order: PageId[] }
  | {
      type: 'pages/insert';
      /** Final indices, applied in ascending order. */
      entries: Array<{ index: number; page: PageModel }>;
      /** Annotations that belong to the inserted pages (used when undoing a removal). */
      annotations: Annotation[];
      /** Sources the inserted pages reference that the document does not know yet. */
      sources: SourceDocument[];
      /**
       * Images the annotations use that the document does not know yet (pages
       * copied from another document). Like sources, they stay registered
       * after an undo.
       */
      assets?: AssetRef[];
    }
  | { type: 'pages/remove'; pageIds: PageId[] }
  | { type: 'metadata/update'; patch: Partial<DocumentMetadata> }
  | {
      type: 'annotations/add';
      annotations: Annotation[];
      /**
       * Images the annotations use that the document does not know yet. Like
       * sources, they stay registered after an undo (their bytes are needed
       * for redo); assets nothing uses are never exported.
       */
      assets?: AssetRef[];
    }
  | { type: 'annotations/replace'; annotations: Annotation[] }
  | { type: 'annotations/remove'; ids: AnnotationId[] }
  /** Fills in form fields. */
  | { type: 'forms/set-values'; values: Array<{ id: FormFieldId; value: FormFieldValue }> }
  /** Sets or clears the page numbers and the watermark (keys left out stay as they are). */
  | { type: 'stamps/set'; stamps: Partial<DocumentStamps> }
  /**
   * Sets or removes (null) the recognized text of source pages, keyed by
   * `sourcePageKey`. `assets` registers the JSON the text is stored in; like
   * images, assets stay registered after an undo.
   */
  | {
      type: 'text-layers/set';
      entries: Array<{ key: string; layer: RecognizedText | null }>;
      assets?: AssetRef[];
    }
  | { type: 'batch'; operations: Operation[] };

export type OperationType = Operation['type'];

export type OperationErrorCode =
  | 'unknown-page'
  | 'unknown-annotation'
  | 'unknown-source'
  | 'unknown-asset'
  | 'unknown-field'
  | 'read-only-field'
  | 'invalid-value'
  | 'duplicate-id'
  | 'invalid-order'
  | 'invalid-index'
  | 'empty-document'
  | 'empty-operation';

export class OperationError extends Error {
  override readonly name = 'OperationError';
  constructor(
    readonly code: OperationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface OperationResult {
  model: DocumentModel;
  inverse: Operation;
}

function pageIndexMap(model: DocumentModel): Map<PageId, number> {
  return new Map(model.pages.map((page, index) => [page.id, index]));
}

function requirePages(model: DocumentModel, pageIds: readonly PageId[]): Map<PageId, number> {
  if (pageIds.length === 0) throw new OperationError('empty-operation', 'No pages were given.');
  const indices = pageIndexMap(model);
  const seen = new Set<PageId>();
  for (const id of pageIds) {
    if (!indices.has(id)) throw new OperationError('unknown-page', `Unknown page ${id}.`);
    if (seen.has(id)) throw new OperationError('duplicate-id', `Page ${id} was listed twice.`);
    seen.add(id);
  }
  return indices;
}

function rotatePages(model: DocumentModel, pageIds: PageId[], delta: Rotation): OperationResult {
  requirePages(model, pageIds);
  const normalized = normalizeRotation(delta);
  const targets = new Set(pageIds);
  const pages = model.pages.map((page) =>
    targets.has(page.id) ? { ...page, rotation: addRotation(page.rotation, normalized) } : page,
  );
  return {
    model: { ...model, pages },
    inverse: { type: 'pages/rotate', pageIds: [...pageIds], delta: normalizeRotation(-normalized) },
  };
}

function reorderPages(model: DocumentModel, order: PageId[]): OperationResult {
  if (order.length !== model.pages.length) {
    throw new OperationError('invalid-order', 'A reorder must list every page exactly once.');
  }
  const byId = new Map(model.pages.map((page) => [page.id, page]));
  const seen = new Set<PageId>();
  const pages = order.map((id) => {
    const page = byId.get(id);
    if (!page) throw new OperationError('unknown-page', `Unknown page ${id}.`);
    if (seen.has(id)) throw new OperationError('invalid-order', `Page ${id} was listed twice.`);
    seen.add(id);
    return page;
  });
  return {
    model: { ...model, pages },
    inverse: { type: 'pages/reorder', order: model.pages.map((page) => page.id) },
  };
}

function insertPages(
  model: DocumentModel,
  op: Extract<Operation, { type: 'pages/insert' }>,
): OperationResult {
  if (op.entries.length === 0) {
    throw new OperationError('empty-operation', 'No pages were given.');
  }
  // Sources stay registered after an undo: their bytes are needed for redo and
  // an unreferenced source is never exported.
  const sources = { ...model.sources };
  for (const source of op.sources) sources[source.id] ??= source;
  const assets = op.assets?.length ? { ...model.assets } : model.assets;
  for (const asset of op.assets ?? []) assets[asset.id] ??= asset;
  const existing = new Set(model.pages.map((page) => page.id));
  const pages = [...model.pages];
  const sorted = [...op.entries].sort((a, b) => a.index - b.index);
  for (const { index, page } of sorted) {
    if (existing.has(page.id)) {
      throw new OperationError('duplicate-id', `Page ${page.id} already exists.`);
    }
    if (!Number.isInteger(index) || index < 0 || index > pages.length) {
      throw new OperationError('invalid-index', `Cannot insert a page at index ${index}.`);
    }
    if (page.source.kind === 'source' && !sources[page.source.sourceId]) {
      throw new OperationError('unknown-source', `Unknown source ${page.source.sourceId}.`);
    }
    existing.add(page.id);
    pages.splice(index, 0, page);
  }
  const annotations = { ...model.annotations };
  for (const annotation of op.annotations) {
    if (!existing.has(annotation.pageId)) {
      throw new OperationError('unknown-page', `Unknown page ${annotation.pageId}.`);
    }
    if (annotations[annotation.id]) {
      throw new OperationError('duplicate-id', `Annotation ${annotation.id} already exists.`);
    }
    if ('assetId' in annotation && !assets[annotation.assetId]) {
      throw new OperationError('unknown-asset', `Unknown image ${annotation.assetId}.`);
    }
    annotations[annotation.id] = annotation;
  }
  return {
    model: { ...model, sources, pages, annotations, assets },
    inverse: { type: 'pages/remove', pageIds: sorted.map(({ page }) => page.id) },
  };
}

function removePages(model: DocumentModel, pageIds: PageId[]): OperationResult {
  requirePages(model, pageIds);
  if (pageIds.length >= model.pages.length) {
    throw new OperationError('empty-document', 'A document must keep at least one page.');
  }
  const targets = new Set(pageIds);
  const entries = model.pages
    .map((page, index) => ({ index, page }))
    .filter(({ page }) => targets.has(page.id));
  const removedAnnotations: Annotation[] = [];
  const annotations: DocumentModel['annotations'] = { ...model.annotations };
  for (const annotation of Object.values(model.annotations)) {
    if (targets.has(annotation.pageId)) {
      removedAnnotations.push(annotation);
      delete annotations[annotation.id];
    }
  }
  return {
    model: { ...model, pages: model.pages.filter((page) => !targets.has(page.id)), annotations },
    inverse: { type: 'pages/insert', entries, annotations: removedAnnotations, sources: [] },
  };
}

function updateMetadata(model: DocumentModel, patch: Partial<DocumentMetadata>): OperationResult {
  const keys = Object.keys(patch) as Array<keyof DocumentMetadata>;
  if (keys.length === 0) throw new OperationError('empty-operation', 'Nothing to update.');
  const previous: Partial<DocumentMetadata> = {};
  for (const key of keys) {
    (previous as Record<string, unknown>)[key] = model.metadata[key];
  }
  return {
    model: { ...model, metadata: { ...model.metadata, ...patch } },
    inverse: { type: 'metadata/update', patch: previous },
  };
}

function addAnnotations(
  model: DocumentModel,
  added: Annotation[],
  newAssets: readonly AssetRef[] = [],
): OperationResult {
  if (added.length === 0) throw new OperationError('empty-operation', 'No annotations given.');
  const pages = pageIndexMap(model);
  const assets = { ...model.assets };
  for (const asset of newAssets) assets[asset.id] ??= asset;
  const annotations = { ...model.annotations };
  for (const annotation of added) {
    if (!pages.has(annotation.pageId)) {
      throw new OperationError('unknown-page', `Unknown page ${annotation.pageId}.`);
    }
    if (annotations[annotation.id]) {
      throw new OperationError('duplicate-id', `Annotation ${annotation.id} already exists.`);
    }
    if ('assetId' in annotation && !assets[annotation.assetId]) {
      throw new OperationError('unknown-asset', `Unknown image ${annotation.assetId}.`);
    }
    annotations[annotation.id] = annotation;
  }
  return {
    model: { ...model, annotations, assets },
    inverse: { type: 'annotations/remove', ids: added.map((annotation) => annotation.id) },
  };
}

function replaceAnnotations(model: DocumentModel, replacements: Annotation[]): OperationResult {
  if (replacements.length === 0) {
    throw new OperationError('empty-operation', 'No annotations given.');
  }
  const pages = pageIndexMap(model);
  const annotations = { ...model.annotations };
  const previous: Annotation[] = [];
  for (const annotation of replacements) {
    const current = annotations[annotation.id];
    if (!current) {
      throw new OperationError('unknown-annotation', `Unknown annotation ${annotation.id}.`);
    }
    if (!pages.has(annotation.pageId)) {
      throw new OperationError('unknown-page', `Unknown page ${annotation.pageId}.`);
    }
    if ('assetId' in annotation && !model.assets[annotation.assetId]) {
      throw new OperationError('unknown-asset', `Unknown image ${annotation.assetId}.`);
    }
    previous.push(current);
    annotations[annotation.id] = annotation;
  }
  return {
    model: { ...model, annotations },
    inverse: { type: 'annotations/replace', annotations: previous },
  };
}

function removeAnnotations(model: DocumentModel, ids: AnnotationId[]): OperationResult {
  if (ids.length === 0) throw new OperationError('empty-operation', 'No annotations given.');
  const annotations = { ...model.annotations };
  const removed: Annotation[] = [];
  for (const id of ids) {
    const current = annotations[id];
    if (!current) throw new OperationError('unknown-annotation', `Unknown annotation ${id}.`);
    removed.push(current);
    delete annotations[id];
  }
  return {
    model: { ...model, annotations },
    inverse: { type: 'annotations/add', annotations: removed },
  };
}

/** Whether a value has the shape a field of this type holds. */
function fitsField(type: FormFieldType, value: FormFieldValue): boolean {
  switch (type) {
    case 'text':
      return typeof value === 'string';
    case 'checkbox':
      return typeof value === 'boolean';
    case 'radio':
      return typeof value === 'string' || value === null;
    case 'choice':
      return (
        typeof value === 'string' ||
        value === null ||
        (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
      );
    case 'signature':
    case 'button':
      return false;
  }
}

function setFormValues(
  model: DocumentModel,
  values: Array<{ id: FormFieldId; value: FormFieldValue }>,
): OperationResult {
  if (values.length === 0) throw new OperationError('empty-operation', 'No fields were given.');
  const formFields = { ...model.formFields };
  const previous: Array<{ id: FormFieldId; value: FormFieldValue }> = [];
  const seen = new Set<FormFieldId>();
  for (const { id, value } of values) {
    const field = formFields[id];
    if (!field) throw new OperationError('unknown-field', `Unknown form field ${id}.`);
    if (seen.has(id)) throw new OperationError('duplicate-id', `Field ${id} was listed twice.`);
    seen.add(id);
    if (field.readOnly) throw new OperationError('read-only-field', `Field ${id} is read-only.`);
    if (!fitsField(field.type, value)) {
      throw new OperationError('invalid-value', `That value does not fit field ${id}.`);
    }
    previous.push({ id, value: field.value });
    formFields[id] = { ...field, value: Array.isArray(value) ? [...value] : value };
  }
  return {
    model: { ...model, formFields },
    inverse: { type: 'forms/set-values', values: previous },
  };
}

function setStamps(model: DocumentModel, patch: Partial<DocumentStamps>): OperationResult {
  const keys = (Object.keys(patch) as Array<keyof DocumentStamps>).filter(
    (key) => patch[key] !== undefined,
  );
  if (keys.length === 0) throw new OperationError('empty-operation', 'Nothing to update.');
  const previous: Partial<DocumentStamps> = {};
  const stamps = { ...model.stamps };
  for (const key of keys) {
    (previous as Record<string, unknown>)[key] = model.stamps[key];
    (stamps as Record<string, unknown>)[key] = patch[key];
  }
  return {
    model: { ...model, stamps },
    inverse: { type: 'stamps/set', stamps: previous },
  };
}

const SOURCE_PAGE_KEY = /^(src_[0-9a-f]{24}):(\d+)$/;

function setTextLayers(
  model: DocumentModel,
  op: Extract<Operation, { type: 'text-layers/set' }>,
): OperationResult {
  if (op.entries.length === 0) throw new OperationError('empty-operation', 'No pages were given.');
  const assets = { ...model.assets };
  for (const asset of op.assets ?? []) assets[asset.id] ??= asset;
  const textLayers = { ...model.textLayers };
  const previous: Array<{ key: string; layer: RecognizedText | null }> = [];
  const seen = new Set<string>();
  for (const { key, layer } of op.entries) {
    const match = SOURCE_PAGE_KEY.exec(key);
    const source = match ? model.sources[match[1] as keyof DocumentModel['sources']] : undefined;
    if (!match || !source)
      throw new OperationError('unknown-source', `Unknown source page ${key}.`);
    if (Number(match[2]) >= source.pageCount) {
      throw new OperationError('invalid-index', `Source page ${key} does not exist.`);
    }
    if (seen.has(key)) throw new OperationError('duplicate-id', `Page ${key} was listed twice.`);
    seen.add(key);
    if (layer && !assets[layer.assetId]) {
      throw new OperationError('unknown-asset', `Unknown text data ${layer.assetId}.`);
    }
    previous.push({ key, layer: textLayers[key] ?? null });
    if (layer) textLayers[key] = layer;
    else delete textLayers[key];
  }
  return {
    model: { ...model, assets, textLayers },
    inverse: { type: 'text-layers/set', entries: previous },
  };
}

function applyBatch(model: DocumentModel, operations: Operation[]): OperationResult {
  if (operations.length === 0) throw new OperationError('empty-operation', 'Empty batch.');
  let current = model;
  const inverses: Operation[] = [];
  for (const operation of operations) {
    // If a later step throws, `model` is untouched because every step is pure.
    const result = applyOperation(current, operation);
    current = result.model;
    inverses.unshift(result.inverse);
  }
  return { model: current, inverse: { type: 'batch', operations: inverses } };
}

/**
 * Applies an operation without mutating `model`. Throws {@link OperationError}
 * when the operation does not fit the document; the input is left unchanged.
 */
export function applyOperation(model: DocumentModel, operation: Operation): OperationResult {
  switch (operation.type) {
    case 'pages/rotate':
      return rotatePages(model, operation.pageIds, operation.delta);
    case 'pages/reorder':
      return reorderPages(model, operation.order);
    case 'pages/insert':
      return insertPages(model, operation);
    case 'pages/remove':
      return removePages(model, operation.pageIds);
    case 'metadata/update':
      return updateMetadata(model, operation.patch);
    case 'annotations/add':
      return addAnnotations(model, operation.annotations, operation.assets);
    case 'annotations/replace':
      return replaceAnnotations(model, operation.annotations);
    case 'annotations/remove':
      return removeAnnotations(model, operation.ids);
    case 'forms/set-values':
      return setFormValues(model, operation.values);
    case 'stamps/set':
      return setStamps(model, operation.stamps);
    case 'text-layers/set':
      return setTextLayers(model, operation);
    case 'batch':
      return applyBatch(model, operation.operations);
  }
}

/**
 * Builds a reorder that moves `pageIds` (kept in document order) so that the
 * first of them lands at `toIndex` of the resulting page list.
 */
export function movePagesOperation(
  model: DocumentModel,
  pageIds: readonly PageId[],
  toIndex: number,
): Operation {
  requirePages(model, pageIds);
  const moving = new Set(pageIds);
  const moved = model.pages.filter((page) => moving.has(page.id)).map((page) => page.id);
  const rest = model.pages.filter((page) => !moving.has(page.id)).map((page) => page.id);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex > rest.length) {
    throw new OperationError('invalid-index', `Cannot move pages to index ${toIndex}.`);
  }
  return {
    type: 'pages/reorder',
    order: [...rest.slice(0, toIndex), ...moved, ...rest.slice(toIndex)],
  };
}
