import type { Point, Rect, Rotation, Size } from './geometry';
import type { AnnotationId, AssetId, DocumentId, FormFieldId, PageId, SourceId } from './ids';

export const DOCUMENT_SCHEMA_VERSION = 1;

/**
 * Where a source PDF came from. Shared code never sees raw filesystem paths:
 * desktop builds hand out an opaque `handle` that only the native layer can
 * resolve, so a compromised webview cannot read arbitrary files.
 */
export type DocumentOrigin =
  | { kind: 'local-file'; handle: string | null }
  | { kind: 'url'; url: string }
  | { kind: 'generated' };

export type EncryptionState = 'none' | 'password-protected' | 'owner-restricted';

/** An original PDF whose bytes are held once, outside of the model and history. */
export interface SourceDocument {
  id: SourceId;
  fileName: string;
  byteLength: number;
  /** SHA-256 of the original bytes; re-associates buffers during crash recovery. */
  sha256: string;
  pdfVersion: string | null;
  pageCount: number;
  encryption: EncryptionState;
  origin: DocumentOrigin;
}

export type PageSource =
  { kind: 'source'; sourceId: SourceId; pageIndex: number } | { kind: 'blank' };

export interface PageModel {
  id: PageId;
  source: PageSource;
  /** Unrotated size of the page's crop box, in PDF points, with /UserUnit applied. */
  size: Size;
  /**
   * Points per user-space unit (/UserUnit; 1 for almost every page). Page
   * geometry such as annotation rects is stored in unscaled user space, so
   * multiply by this to compare it with `size`.
   */
  userUnit: number;
  /** Rotation stored in the source PDF (/Rotate). */
  sourceRotation: Rotation;
  /** Rotation added by the user on top of `sourceRotation`. */
  rotation: Rotation;
}

export interface DocumentMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string[];
  creator: string;
  producer: string;
  /** ISO-8601 timestamps, or null when absent/unparseable. */
  creationDate: string | null;
  modificationDate: string | null;
}

/** `#rrggbb` */
export type HexColor = string;

interface AnnotationBase {
  id: AnnotationId;
  pageId: PageId;
  author: string;
  createdAt: string;
  modifiedAt: string;
  color: HexColor;
  /** 0–1 */
  opacity: number;
}

export interface TextMarkupAnnotation extends AnnotationBase {
  kind: 'highlight' | 'underline' | 'strikeout';
  /** One rectangle per marked line of text. */
  rects: Rect[];
  /** The marked text, if it could be extracted. Stays local; never logged. */
  text: string;
}

export interface NoteAnnotation extends AnnotationBase {
  kind: 'note';
  position: Point;
  contents: string;
}

export interface InkAnnotation extends AnnotationBase {
  kind: 'ink';
  paths: Point[][];
  strokeWidth: number;
}

export interface ShapeAnnotation extends AnnotationBase {
  kind: 'shape';
  shape: 'rectangle' | 'ellipse' | 'line' | 'arrow';
  rect: Rect;
  strokeWidth: number;
  fill: HexColor | null;
}

/**
 * Text *added* on top of the page. This is new content, not an edit of the
 * PDF's existing text objects, and the UI must describe it that way.
 */
export interface AddedTextAnnotation extends AnnotationBase {
  kind: 'added-text';
  rect: Rect;
  text: string;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  /**
   * Clockwise page rotation the content reads upright at: the page's own
   * rotation when it was added, so text added to a turned page is level.
   */
  rotation: Rotation;
}

export interface AddedImageAnnotation extends AnnotationBase {
  kind: 'added-image';
  rect: Rect;
  assetId: AssetId;
  /** See {@link AddedTextAnnotation.rotation}. */
  rotation: Rotation;
}

export interface SignatureAnnotation extends AnnotationBase {
  kind: 'signature';
  rect: Rect;
  assetId: AssetId;
  /** See {@link AddedTextAnnotation.rotation}. */
  rotation: Rotation;
}

export type Annotation =
  | TextMarkupAnnotation
  | NoteAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | AddedTextAnnotation
  | AddedImageAnnotation
  | SignatureAnnotation;

export type AnnotationKind = Annotation['kind'];

export type FormFieldValue = string | boolean | string[] | null;

export interface FormField {
  id: FormFieldId;
  /** Fully qualified field name from the AcroForm. */
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'choice' | 'signature' | 'button';
  pageId: PageId | null;
  value: FormFieldValue;
  readOnly: boolean;
}

/** Binary assets (images, signatures) are stored by reference, never inline. */
export interface AssetRef {
  id: AssetId;
  mimeType: 'image/png' | 'image/jpeg';
  byteLength: number;
  sha256: string;
}

export interface ExportConfig {
  /** Burn annotations into page content instead of writing editable annotations. */
  flattenAnnotations: boolean;
  /** Write `metadata` into the Info dictionary and XMP stream. */
  writeMetadata: boolean;
}

/**
 * Everything that is part of the document itself and therefore covered by
 * undo/redo and saved to disk. UI-only state lives in {@link DocumentViewState}.
 */
export interface DocumentModel {
  schemaVersion: typeof DOCUMENT_SCHEMA_VERSION;
  id: DocumentId;
  sources: Record<SourceId, SourceDocument>;
  /** Page order is the array order. */
  pages: PageModel[];
  metadata: DocumentMetadata;
  annotations: Record<AnnotationId, Annotation>;
  formFields: Record<FormFieldId, FormField>;
  assets: Record<AssetId, AssetRef>;
  exportConfig: ExportConfig;
}

/**
 * "auto" fits the page width (up to 125%), or the whole page for landscape
 * pages; the fit modes follow the window size; "custom" keeps `zoom`.
 */
export type ZoomMode = 'auto' | 'fit-width' | 'fit-page' | 'custom';

/** Per-document UI state: persisted for recovery, but never part of undo history. */
export interface DocumentViewState {
  currentPageId: PageId | null;
  /**
   * Where the top of the window is relative to the current page, in page
   * heights: 0 at its top edge, 0.5 halfway down, negative when the window
   * starts above the page. 0 exactly means "show the page from its top".
   */
  pageOffset: number;
  zoomMode: ZoomMode;
  /** 1 = 100%. In the fit modes, the scale last computed for the window size. */
  zoom: number;
  /** Rotation added to every page for viewing only; never saved into the PDF. */
  rotation: Rotation;
}

export const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  flattenAnnotations: false,
  writeMetadata: true,
};

export const EMPTY_METADATA: DocumentMetadata = {
  title: '',
  author: '',
  subject: '',
  keywords: [],
  creator: '',
  producer: '',
  creationDate: null,
  modificationDate: null,
};
