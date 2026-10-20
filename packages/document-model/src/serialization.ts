import { z } from './zod';
import { ID_PREFIXES, type IdKind } from './ids';
import type { EditorDocumentState } from './history';
import type { DocumentViewState } from './types';

/**
 * Recovery snapshots persist the document model, its history and view state
 * as JSON. PDF bytes are deliberately excluded: sources are re-associated by
 * SHA-256 so a snapshot stays small no matter how large the PDF is.
 */
export const RECOVERY_FORMAT = 'folio.recovery';
export const RECOVERY_FORMAT_VERSION = 1;

export interface RecoverySnapshot {
  format: typeof RECOVERY_FORMAT;
  formatVersion: typeof RECOVERY_FORMAT_VERSION;
  createdAt: string;
  editor: EditorDocumentState;
  view: DocumentViewState;
}

export type SnapshotErrorCode =
  'invalid-json' | 'unsupported-format' | 'invalid-shape' | 'inconsistent';

export class SnapshotError extends Error {
  override readonly name = 'SnapshotError';
  constructor(
    readonly code: SnapshotErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const id = (kind: IdKind) => z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-f]{24}$`));
const finite = z.number().refine(Number.isFinite, 'Expected a finite number');
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const point = z.object({ x: finite, y: finite });
const rect = z.object({ x: finite, y: finite, width: finite, height: finite });
const size = z.object({ width: finite.positive(), height: finite.positive() });
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const isoDate = z.string().datetime({ offset: true }).nullable();

const origin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local-file'), handle: z.string().nullable() }),
  z.object({ kind: z.literal('url'), url: z.string() }),
  z.object({ kind: z.literal('generated') }),
]);

const source = z.object({
  id: id('source'),
  fileName: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pdfVersion: z.string().nullable(),
  pageCount: z.number().int().positive(),
  encryption: z.enum(['none', 'password-protected', 'owner-restricted']),
  origin,
});

const page = z.object({
  id: id('page'),
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('source'),
      sourceId: id('source'),
      pageIndex: z.number().int().nonnegative(),
    }),
    z.object({ kind: z.literal('blank') }),
  ]),
  size,
  userUnit: finite.positive(),
  sourceRotation: rotation,
  rotation,
});

const metadata = z.object({
  title: z.string(),
  author: z.string(),
  subject: z.string(),
  keywords: z.array(z.string()),
  creator: z.string(),
  producer: z.string(),
  creationDate: isoDate,
  modificationDate: isoDate,
});

const annotationBase = {
  id: id('annotation'),
  pageId: id('page'),
  author: z.string(),
  createdAt: z.string(),
  modifiedAt: z.string(),
  color,
  opacity: z.number().min(0).max(1),
};

const annotation = z.discriminatedUnion('kind', [
  z.object({
    ...annotationBase,
    kind: z.enum(['highlight', 'underline', 'strikeout']),
    rects: z.array(rect),
    text: z.string(),
  }),
  z.object({ ...annotationBase, kind: z.literal('note'), position: point, contents: z.string() }),
  z.object({
    ...annotationBase,
    kind: z.literal('ink'),
    paths: z.array(z.array(point)),
    strokeWidth: finite.positive(),
  }),
  z.object({
    ...annotationBase,
    kind: z.literal('shape'),
    shape: z.enum(['rectangle', 'ellipse', 'line', 'arrow']),
    rect,
    strokeWidth: finite.nonnegative(),
    fill: color.nullable(),
  }),
  z.object({
    ...annotationBase,
    kind: z.literal('added-text'),
    rect,
    text: z.string(),
    fontSize: finite.positive(),
    fontFamily: z.enum(['sans', 'serif', 'mono']),
    rotation,
  }),
  z.object({
    ...annotationBase,
    kind: z.literal('added-image'),
    rect,
    assetId: id('asset'),
    rotation,
  }),
  z.object({
    ...annotationBase,
    kind: z.literal('signature'),
    rect,
    assetId: id('asset'),
    rotation,
  }),
]);

const formFieldValue = z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]);

const formField = z.object({
  id: id('formField'),
  name: z.string(),
  type: z.enum(['text', 'checkbox', 'radio', 'choice', 'signature', 'button']),
  pageId: id('page').nullable(),
  value: formFieldValue,
  readOnly: z.boolean(),
});

const asset = z.object({
  id: id('asset'),
  mimeType: z.enum(['image/png', 'image/jpeg', 'application/json']),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const stampPosition = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]);
const stampPages = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive().nullable(),
});
const fontFamily = z.enum(['sans', 'serif', 'mono']);

const pageNumberStamp = z.object({
  format: z.string().max(200),
  position: stampPosition,
  fontFamily,
  fontSize: finite.positive().max(500),
  color,
  margin: finite.nonnegative(),
  startNumber: z.number().int(),
  pages: stampPages,
});

const watermarkStamp = z.object({
  text: z.string().max(1000),
  position: stampPosition,
  fontFamily,
  fontSize: finite.positive().max(1000),
  color,
  opacity: z.number().min(0).max(1),
  angle: finite.min(-90).max(90),
  layer: z.enum(['over', 'under']),
  margin: finite.nonnegative(),
  pages: stampPages,
});

const stamps = z.object({
  pageNumbers: pageNumberStamp.nullable(),
  watermark: watermarkStamp.nullable(),
});

const recognizedText = z.object({
  assetId: id('asset'),
  languages: z.string().regex(/^[a-z_]+(\+[a-z_]+)*$/),
  wordCount: z.number().int().nonnegative(),
});

const sourcePageKey = z.string().regex(new RegExp(`^${ID_PREFIXES.source}_[0-9a-f]{24}:\\d+$`));

const documentModel = z.object({
  schemaVersion: z.literal(1),
  id: id('document'),
  sources: z.record(z.string(), source),
  pages: z.array(page).min(1),
  metadata,
  annotations: z.record(z.string(), annotation),
  formFields: z.record(z.string(), formField),
  assets: z.record(z.string(), asset),
  exportConfig: z.object({ flattenAnnotations: z.boolean(), writeMetadata: z.boolean() }),
  // Added after the first release of the format: older snapshots have neither.
  stamps: stamps.default({ pageNumbers: null, watermark: null }),
  textLayers: z.record(sourcePageKey, recognizedText).default({}),
});

const operation: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('pages/rotate'), pageIds: z.array(id('page')), delta: rotation }),
    z.object({ type: z.literal('pages/reorder'), order: z.array(id('page')) }),
    z.object({
      type: z.literal('pages/insert'),
      entries: z.array(z.object({ index: z.number().int().nonnegative(), page })),
      annotations: z.array(annotation),
      sources: z.array(source),
      assets: z.array(asset).optional(),
    }),
    z.object({ type: z.literal('pages/remove'), pageIds: z.array(id('page')) }),
    z.object({ type: z.literal('metadata/update'), patch: metadata.partial() }),
    z.object({
      type: z.literal('annotations/add'),
      annotations: z.array(annotation),
      assets: z.array(asset).optional(),
    }),
    z.object({ type: z.literal('annotations/replace'), annotations: z.array(annotation) }),
    z.object({ type: z.literal('annotations/remove'), ids: z.array(id('annotation')) }),
    z.object({
      type: z.literal('forms/set-values'),
      values: z.array(z.object({ id: id('formField'), value: formFieldValue })),
    }),
    z.object({ type: z.literal('stamps/set'), stamps: stamps.partial() }),
    z.object({
      type: z.literal('text-layers/set'),
      entries: z.array(z.object({ key: sourcePageKey, layer: recognizedText.nullable() })),
      assets: z.array(asset).optional(),
    }),
    z.object({ type: z.literal('batch'), operations: z.array(operation) }),
  ]),
);

const historyEntry = z.object({
  id: id('operation'),
  label: z.string(),
  operation,
  inverse: operation,
  timestamp: z.number(),
  coalesceKey: z.string().nullable(),
});

const snapshot = z.object({
  format: z.literal(RECOVERY_FORMAT),
  formatVersion: z.literal(RECOVERY_FORMAT_VERSION),
  createdAt: z.string(),
  editor: z.object({
    model: documentModel,
    history: z.object({
      past: z.array(historyEntry),
      future: z.array(historyEntry),
      limit: z.number().int().positive(),
    }),
    savedEntryId: id('operation').nullable(),
  }),
  view: z.object({
    currentPageId: id('page').nullable(),
    pageOffset: finite.min(-1).max(1),
    zoomMode: z.enum(['auto', 'fit-width', 'fit-page', 'custom']),
    zoom: finite.positive(),
    rotation,
  }),
});

export function serializeRecoverySnapshot(
  editor: EditorDocumentState,
  view: DocumentViewState,
  now: Date = new Date(),
): string {
  const value: RecoverySnapshot = {
    format: RECOVERY_FORMAT,
    formatVersion: RECOVERY_FORMAT_VERSION,
    createdAt: now.toISOString(),
    editor,
    view,
  };
  return JSON.stringify(value);
}

function assertConsistent(value: RecoverySnapshot): void {
  const { model } = value.editor;
  for (const [key, entry] of Object.entries(model.sources)) {
    if (key !== entry.id) throw new SnapshotError('inconsistent', 'Source keys do not match IDs.');
  }
  const pageIds = new Set<string>();
  for (const entry of model.pages) {
    if (pageIds.has(entry.id)) throw new SnapshotError('inconsistent', 'Duplicate page ID.');
    pageIds.add(entry.id);
    if (entry.source.kind === 'source' && !model.sources[entry.source.sourceId]) {
      throw new SnapshotError('inconsistent', 'A page references an unknown source.');
    }
  }
  for (const [key, entry] of Object.entries(model.annotations)) {
    if (key !== entry.id || !pageIds.has(entry.pageId)) {
      throw new SnapshotError('inconsistent', 'An annotation references an unknown page.');
    }
    if ('assetId' in entry && !model.assets[entry.assetId]) {
      throw new SnapshotError('inconsistent', 'An annotation references an unknown image.');
    }
  }
  for (const [key, entry] of Object.entries(model.assets)) {
    if (key !== entry.id) throw new SnapshotError('inconsistent', 'Asset keys do not match IDs.');
  }
  // A field's page may have been deleted since: `pageId` only says where it was first.
  for (const [key, entry] of Object.entries(model.formFields)) {
    if (key !== entry.id) throw new SnapshotError('inconsistent', 'Field keys do not match IDs.');
  }
  for (const [key, entry] of Object.entries(model.textLayers)) {
    const sourceId = key.slice(0, key.indexOf(':'));
    const known = Object.prototype.hasOwnProperty.call(model.sources, sourceId);
    if (!known || !model.assets[entry.assetId]) {
      throw new SnapshotError('inconsistent', 'Recognized text references unknown data.');
    }
  }
  if (value.view.currentPageId !== null && !pageIds.has(value.view.currentPageId)) {
    throw new SnapshotError('inconsistent', 'The current page does not exist.');
  }
}

/** Parses and validates a snapshot. Never trusts persisted data blindly. */
export function parseRecoverySnapshot(text: string): RecoverySnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('invalid-json', 'The recovery data is not valid JSON.');
  }
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { format?: unknown }).format !== RECOVERY_FORMAT ||
    (raw as { formatVersion?: unknown }).formatVersion !== RECOVERY_FORMAT_VERSION
  ) {
    throw new SnapshotError('unsupported-format', 'Unsupported recovery data format.');
  }
  const result = snapshot.safeParse(raw);
  if (!result.success) {
    // Only report paths, never values: values may contain document content.
    const paths = result.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join('.'))
      .join(', ');
    throw new SnapshotError('invalid-shape', `Recovery data failed validation at ${paths}.`);
  }
  const value = result.data as unknown as RecoverySnapshot;
  assertConsistent(value);
  return value;
}
