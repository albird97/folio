import { normalizeRotation, type Size } from './geometry';
import { newDocumentId, newFormFieldId, newPageId, newSourceId, type SourceId } from './ids';
import {
  DEFAULT_EXPORT_CONFIG,
  DOCUMENT_SCHEMA_VERSION,
  EMPTY_METADATA,
  NO_STAMPS,
  type DocumentMetadata,
  type DocumentModel,
  type DocumentOrigin,
  type DocumentViewState,
  type EncryptionState,
  type FormField,
  type FormFieldType,
  type FormFieldValue,
  type PageModel,
  type SourceDocument,
} from './types';

/** A form field as the engine reads it from a file. */
export interface FormFieldDescriptor {
  name: string;
  type: FormFieldType;
  /** Page of the field's first widget in the file, or null. */
  pageIndex: number | null;
  value: FormFieldValue;
  readOnly: boolean;
}

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
  /** The file's interactive form fields (none when omitted). */
  formFields?: readonly FormFieldDescriptor[];
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
  const formFields = {} as DocumentModel['formFields'];
  for (const field of descriptor.formFields ?? []) {
    const entry: FormField = {
      id: newFormFieldId(),
      name: field.name,
      type: field.type,
      pageId: field.pageIndex === null ? null : (pages[field.pageIndex]?.id ?? null),
      value: field.value,
      readOnly: field.readOnly,
    };
    formFields[entry.id] = entry;
  }
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: newDocumentId(),
    sources: { [source.id]: source } as DocumentModel['sources'],
    pages,
    metadata: { ...EMPTY_METADATA, ...descriptor.metadata },
    annotations: {} as DocumentModel['annotations'],
    formFields,
    assets: {} as DocumentModel['assets'],
    exportConfig: { ...DEFAULT_EXPORT_CONFIG },
    stamps: NO_STAMPS,
    textLayers: {},
  };
}

export function createViewState(model: DocumentModel): DocumentViewState {
  return {
    currentPageId: model.pages[0]?.id ?? null,
    pageOffset: 0,
    zoomMode: 'auto',
    zoom: 1,
    rotation: 0,
  };
}

/**
 * The primary source: the file the document was opened from. Sources keep
 * the order they were added in, so it stays first whatever happens to its
 * pages (moved, deleted) or to pages inserted from other files.
 */
export function primarySource(model: DocumentModel): SourceDocument | null {
  return Object.values(model.sources)[0] ?? null;
}
