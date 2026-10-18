import { normalizeRotation, type Size } from './geometry';
import { newDocumentId, newPageId, newSourceId, type SourceId } from './ids';
import {
  DEFAULT_EXPORT_CONFIG,
  DOCUMENT_SCHEMA_VERSION,
  EMPTY_METADATA,
  type DocumentMetadata,
  type DocumentModel,
  type DocumentOrigin,
  type DocumentViewState,
  type EncryptionState,
  type PageModel,
  type SourceDocument,
} from './types';

/** What a PDF engine reports about a freshly opened file. */
export interface SourceDescriptor {
  fileName: string;
  byteLength: number;
  sha256: string;
  pdfVersion: string | null;
  encryption: EncryptionState;
  origin: DocumentOrigin;
  metadata: Partial<DocumentMetadata>;
  /** `userUnit` defaults to 1. */
  pages: ReadonlyArray<{ size: Size; rotation: number; userUnit?: number }>;
}

export function createSourceDocument(descriptor: SourceDescriptor, id: SourceId = newSourceId()) {
  const source: SourceDocument = {
    id,
    fileName: descriptor.fileName,
    byteLength: descriptor.byteLength,
    sha256: descriptor.sha256,
    pdfVersion: descriptor.pdfVersion,
    pageCount: descriptor.pages.length,
    encryption: descriptor.encryption,
    origin: descriptor.origin,
  };
  const pages: PageModel[] = descriptor.pages.map((page, pageIndex) => ({
    id: newPageId(),
    source: { kind: 'source', sourceId: id, pageIndex },
    size: { width: page.size.width, height: page.size.height },
    userUnit: page.userUnit ?? 1,
    sourceRotation: normalizeRotation(page.rotation),
    rotation: 0,
  }));
  return { source, pages };
}

/** Builds the initial model for a document opened from a single PDF. */
export function createDocumentModel(descriptor: SourceDescriptor): DocumentModel {
  if (descriptor.pages.length === 0) {
    throw new RangeError('A PDF document must contain at least one page.');
  }
  const { source, pages } = createSourceDocument(descriptor);
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: newDocumentId(),
    sources: { [source.id]: source } as DocumentModel['sources'],
    pages,
    metadata: { ...EMPTY_METADATA, ...descriptor.metadata },
    annotations: {} as DocumentModel['annotations'],
    formFields: {} as DocumentModel['formFields'],
    assets: {} as DocumentModel['assets'],
    exportConfig: { ...DEFAULT_EXPORT_CONFIG },
  };
}

export function createViewState(model: DocumentModel): DocumentViewState {
  return {
    currentPageId: model.pages[0]?.id ?? null,
    zoomMode: 'fit-width',
    zoom: 1,
  };
}

/** The primary source (the file the document was opened from). */
export function primarySource(model: DocumentModel): SourceDocument | null {
  const first = model.pages.find((page) => page.source.kind === 'source');
  if (first?.source.kind === 'source') return model.sources[first.source.sourceId] ?? null;
  return Object.values(model.sources)[0] ?? null;
}
