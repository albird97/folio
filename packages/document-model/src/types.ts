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

/**
 * A form field's value: text for text fields, `true`/`false` for check
 * boxes, the chosen option's export value (or null for none) for radio
 * buttons, and the chosen option(s) for choice fields. Signature fields and
 * buttons hold null.
 */
export type FormFieldValue = string | boolean | string[] | null;

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'choice' | 'signature' | 'button';

/**
 * A field of the document's interactive form (AcroForm), from the file the
 * document was opened from. Its widgets (where it shows on the pages) are
 * read from the file when shown; the model holds the field's value.
 */
export interface FormField {
  id: FormFieldId;
  /** Fully qualified field name from the AcroForm. */
  name: string;
  type: FormFieldType;
  /** Page of the field's first widget, or null when it has none. */
  pageId: PageId | null;
  value: FormFieldValue;
  readOnly: boolean;
}

/**
 * Binary assets are stored by reference, never inline: images (added
 * images, signatures) and data Folio produced, such as recognized text.
 */
export interface AssetRef {
  id: AssetId;
  mimeType: 'image/png' | 'image/jpeg' | 'application/json';
  byteLength: number;
  sha256: string;
}

/** Where a stamp sits on a page, as the page is shown (after its saved rotation). */
export type StampPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const STAMP_POSITIONS: readonly StampPosition[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/** The pages a stamp goes on: 1-based positions in the document; `to` null means the last page. */
export interface StampPageRange {
  from: number;
  to: number | null;
}

/**
 * Numbers printed on the pages. Like watermarks, they are new content drawn
 * on top of the pages when the document is saved, never an edit of the
 * pages' own text.
 */
export interface PageNumberStamp {
  /** `{page}` becomes the page's number and `{total}` the last page's number. */
  format: string;
  position: StampPosition;
  fontFamily: 'sans' | 'serif' | 'mono';
  fontSize: number;
  color: HexColor;
  /** Distance from the edges of the page, in points. */
  margin: number;
  /** The number the first stamped page shows. */
  startNumber: number;
  pages: StampPageRange;
}

export interface WatermarkStamp {
  text: string;
  position: StampPosition;
  fontFamily: 'sans' | 'serif' | 'mono';
  fontSize: number;
  color: HexColor;
  /** 0–1 */
  opacity: number;
  /** Counterclockwise angle of the text as the page is shown, in degrees (−90 to 90). */
  angle: number;
  /** Drawn behind the page's content or over it. */
  layer: 'over' | 'under';
  /** Distance from the edges of the page, in points (positions other than the centre). */
  margin: number;
  pages: StampPageRange;
}

/** Page numbers and a watermark, applied to the pages when the document is saved or printed. */
export interface DocumentStamps {
  pageNumbers: PageNumberStamp | null;
  watermark: WatermarkStamp | null;
}

/**
 * Text recognized in the image of a page (OCR). The words and their boxes
 * are a JSON asset (see `RecognizedTextData`); saving adds them to the page
 * as invisible text, so the page can be searched and copied from.
 */
export interface RecognizedText {
  assetId: AssetId;
  /** Tesseract language codes the text was read with, e.g. "eng+chi_sim". */
  languages: string;
  /** How many words were found. */
  wordCount: number;
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
  /** Page numbers and watermark. */
  stamps: DocumentStamps;
  /**
   * Recognized text by source page (see `sourcePageKey`): the text belongs
   * to the page's image, so copies of a page share it.
   */
  textLayers: Record<string, RecognizedText>;
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

export const NO_STAMPS: DocumentStamps = { pageNumbers: null, watermark: null };

/** Identifies a page of a source file, whichever positions show it ("src_…:3"). */
export const sourcePageKey = (sourceId: SourceId, pageIndex: number) => `${sourceId}:${pageIndex}`;

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
