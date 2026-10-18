import {
  newAnnotationId,
  newPageId,
  normalizeRotation,
  rotatedSize,
  type Annotation,
  type DocumentModel,
  type EditorDocumentState,
  type HistoryEntry,
  type Operation,
  type PageId,
  type PageModel,
  type SourceId,
} from '@folio/document-model';
import type { PageInfoUpdate, PdfDocumentInfo } from '@folio/pdf-core';

/**
 * What the document's author allows (PDF permission flags). Folio honours
 * them like other well-behaved PDF tools; unencrypted documents allow all.
 */
export interface EditPermissions {
  /** Add and change annotations, notes, drawings, text boxes and images. */
  annotate: boolean;
  /** Insert, delete, rotate and reorder pages. */
  assemble: boolean;
  /** Change document properties and burn annotations into the pages. */
  modify: boolean;
  /** Copy pages out into new documents (extract, split). */
  extract: boolean;
}

export const ALL_PERMISSIONS: EditPermissions = {
  annotate: true,
  assemble: true,
  modify: true,
  extract: true,
};

export function editPermissions(info: PdfDocumentInfo | null): EditPermissions {
  const flags = info?.permissions;
  if (!flags) return ALL_PERMISSIONS;
  return {
    annotate: flags.annotate,
    // Changing the document's content in general includes assembling it.
    assemble: flags.assemble || flags.modify,
    modify: flags.modify,
    extract: flags.copy,
  };
}

/** Why an action is not allowed, for the message shown instead. */
export const PERMISSION_MESSAGES: Record<keyof EditPermissions, string> = {
  annotate: 'The author of this document does not allow adding or changing comments.',
  assemble: 'The author of this document does not allow changing its pages.',
  modify: 'The author of this document does not allow changing it.',
  extract: 'The author of this document does not allow copying its content.',
};

function correctPage(
  page: PageModel,
  sourceId: SourceId,
  byIndex: ReadonlyMap<number, PageInfoUpdate['info']>,
): PageModel {
  if (page.source.kind !== 'source' || page.source.sourceId !== sourceId) return page;
  const info = byIndex.get(page.source.pageIndex);
  if (!info) return page;
  return {
    ...page,
    size: { width: info.size.width, height: info.size.height },
    sourceRotation: info.rotation,
    userUnit: info.userUnit,
  };
}

function correctOperation(operation: Operation, fix: (page: PageModel) => PageModel): Operation {
  switch (operation.type) {
    case 'pages/insert':
      return {
        ...operation,
        entries: operation.entries.map((entry) => ({ ...entry, page: fix(entry.page) })),
      };
    case 'batch':
      return {
        ...operation,
        operations: operation.operations.map((inner) => correctOperation(inner, fix)),
      };
    default:
      return operation;
  }
}

/**
 * Applies exact page sizes, read after opening, to the pages of a source:
 * in the model and in the history, so undoing or redoing never brings back
 * an estimated size.
 */
export function applyPageInfo(
  state: EditorDocumentState,
  sourceId: SourceId,
  updates: readonly PageInfoUpdate[],
): EditorDocumentState {
  if (updates.length === 0) return state;
  const byIndex = new Map(updates.map((update) => [update.index, update.info]));
  const fix = (page: PageModel) => correctPage(page, sourceId, byIndex);
  const fixEntry = (entry: HistoryEntry): HistoryEntry => ({
    ...entry,
    operation: correctOperation(entry.operation, fix),
    inverse: correctOperation(entry.inverse, fix),
  });
  return {
    ...state,
    model: { ...state.model, pages: state.model.pages.map(fix) },
    history: {
      ...state.history,
      past: state.history.past.map(fixEntry),
      future: state.history.future.map(fixEntry),
    },
  };
}

/** Pages in document order, whatever order they were given in. */
export function inDocumentOrder(model: DocumentModel, pageIds: Iterable<PageId>): PageId[] {
  const wanted = new Set(pageIds);
  return model.pages.filter((page) => wanted.has(page.id)).map((page) => page.id);
}

/** Copies of pages (and their annotations), each inserted right after its original. */
export function duplicatePagesOperation(
  model: DocumentModel,
  pageIds: readonly PageId[],
  now: string,
): Operation {
  const wanted = new Set(pageIds);
  const entries: Array<{ index: number; page: PageModel }> = [];
  const annotations: Annotation[] = [];
  const byPage = new Map<PageId, Annotation[]>();
  for (const annotation of Object.values(model.annotations)) {
    const list = byPage.get(annotation.pageId);
    if (list) list.push(annotation);
    else byPage.set(annotation.pageId, [annotation]);
  }
  let inserted = 0;
  model.pages.forEach((page, index) => {
    if (!wanted.has(page.id)) return;
    const copy: PageModel = { ...page, id: newPageId() };
    inserted += 1;
    // Final indices: each copy follows its original, shifted by earlier copies.
    entries.push({ index: index + inserted, page: copy });
    for (const annotation of byPage.get(page.id) ?? []) {
      annotations.push({
        ...annotation,
        id: newAnnotationId(),
        pageId: copy.id,
        createdAt: now,
        modifiedAt: now,
      });
    }
  });
  return { type: 'pages/insert', entries, annotations, sources: [] };
}

/** A blank page shaped like `like` as it is shown (so a turned page gets a landscape page). */
export function blankPageLike(like: PageModel | undefined): PageModel {
  const size = like
    ? rotatedSize(
        { width: like.size.width, height: like.size.height },
        normalizeRotation(like.sourceRotation + like.rotation),
      )
    : { width: 612, height: 792 };
  return {
    id: newPageId(),
    source: { kind: 'blank' },
    size,
    userUnit: 1,
    sourceRotation: 0,
    rotation: 0,
  };
}

/** "3 pages" / "1 page". */
export const pagesLabel = (count: number) => (count === 1 ? '1 page' : `${count} pages`);

/** The pages a page command applies to: the selected ones, or else the current page. */
export function targetPages(
  model: DocumentModel,
  selected: readonly PageId[],
  current: PageId | null,
): PageId[] {
  const present = inDocumentOrder(model, selected);
  if (present.length > 0) return present;
  const fallback = current ?? model.pages[0]?.id;
  return fallback ? [fallback] : [];
}
