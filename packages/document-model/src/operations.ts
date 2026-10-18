import { addRotation, normalizeRotation, type Rotation } from './geometry';
import type { AnnotationId, PageId } from './ids';
import type {
  Annotation,
  DocumentMetadata,
  DocumentModel,
  PageModel,
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
    }
  | { type: 'pages/remove'; pageIds: PageId[] }
  | { type: 'metadata/update'; patch: Partial<DocumentMetadata> }
  | { type: 'annotations/add'; annotations: Annotation[] }
  | { type: 'annotations/replace'; annotations: Annotation[] }
  | { type: 'annotations/remove'; ids: AnnotationId[] }
  | { type: 'batch'; operations: Operation[] };

export type OperationType = Operation['type'];

export type OperationErrorCode =
  | 'unknown-page'
  | 'unknown-annotation'
  | 'unknown-source'
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
    annotations[annotation.id] = annotation;
  }
  return {
    model: { ...model, sources, pages, annotations },
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

function addAnnotations(model: DocumentModel, added: Annotation[]): OperationResult {
  if (added.length === 0) throw new OperationError('empty-operation', 'No annotations given.');
  const pages = pageIndexMap(model);
  const annotations = { ...model.annotations };
  for (const annotation of added) {
    if (!pages.has(annotation.pageId)) {
      throw new OperationError('unknown-page', `Unknown page ${annotation.pageId}.`);
    }
    if (annotations[annotation.id]) {
      throw new OperationError('duplicate-id', `Annotation ${annotation.id} already exists.`);
    }
    annotations[annotation.id] = annotation;
  }
  return {
    model: { ...model, annotations },
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
      return addAnnotations(model, operation.annotations);
    case 'annotations/replace':
      return replaceAnnotations(model, operation.annotations);
    case 'annotations/remove':
      return removeAnnotations(model, operation.ids);
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
  return { type: 'pages/reorder', order: [...rest.slice(0, toIndex), ...moved, ...rest.slice(toIndex)] };
}
