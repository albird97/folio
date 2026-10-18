import {
  normalizeRotation,
  type Annotation,
  type AssetId,
  type DocumentModel,
  type PageId,
  type PageModel,
  type SourceId,
} from '@folio/document-model';
import { degrees, EncryptedPDFError, PDFDocument, PDFPage } from '@cantoo/pdf-lib';
import type { PdfPermissions } from '../engine';
import { AnnotationWriter, type AssetData } from './annotations';
import { writeMetadata } from './metadata';
import {
  collectGarbage,
  isolatePageEntries,
  keepPageLabelsIfValid,
  PageCopier,
  pageOrigin,
  pruneRemovedPages,
  replacePageTree,
} from './objects';

export interface ExportSource {
  bytes: Uint8Array;
  /** Open password of an encrypted source ('' for permission-only encryption). */
  password?: string;
}

/** How the written file is protected; mirrors what the user unlocked it with. */
export interface Protection {
  userPassword: string;
  permissions: PdfPermissions | null;
}

export interface ExportOptions {
  model: DocumentModel;
  sources: ReadonlyMap<SourceId, ExportSource>;
  assets: ReadonlyMap<AssetId, Uint8Array>;
  /**
   * Write only these pages (in document order), as a new document without
   * the original's bookmarks and forms (Extract pages). Default: every page,
   * keeping the original document's structure.
   */
  pageIds?: readonly PageId[];
  /** Default: the document's `exportConfig.flattenAnnotations`. */
  flatten?: boolean;
  /** Encrypt the result. Callers pass the original's protection to keep it protected. */
  protection?: Protection | null;
  now?: Date;
}

export type ExportWarning =
  /** Added text used characters the standard fonts cannot show; they became "?". */
  'unsupported-characters';

export interface ExportResult {
  bytes: Uint8Array;
  warnings: ExportWarning[];
}

export class ExportError extends Error {
  override readonly name = 'ExportError';
  constructor(
    readonly code: 'missing-source' | 'wrong-password' | 'unreadable-source' | 'no-pages',
    message: string,
  ) {
    super(message);
  }
}

/** The file the document was opened from (sources are kept in the order they were added). */
export function originalSourceId(model: DocumentModel): SourceId | null {
  return (Object.keys(model.sources)[0] as SourceId | undefined) ?? null;
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toUserPermissions(permissions: PdfPermissions | null) {
  if (!permissions) return undefined;
  return {
    printing: permissions.print ? ('highResolution' as const) : false,
    modifying: permissions.modify,
    copying: permissions.copy,
    annotating: permissions.annotate,
    fillingForms: permissions.fillForms,
    contentAccessibility: true,
    documentAssembly: permissions.assemble,
  };
}

async function loadSource(source: ExportSource | undefined, id: SourceId): Promise<PDFDocument> {
  if (!source) throw new ExportError('missing-source', `The data of source ${id} is missing.`);
  try {
    return await PDFDocument.load(source.bytes, {
      updateMetadata: false,
      ...(source.password !== undefined ? { password: source.password } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (error instanceof EncryptedPDFError || /password/i.test(message)) {
      throw new ExportError(
        'wrong-password',
        'The password for a source document is missing or wrong.',
      );
    }
    throw new ExportError('unreadable-source', 'A source document could not be read.');
  }
}

/**
 * Writes the document as a new PDF: pages in model order with their
 * rotation, pages from other files, blank pages, Folio's annotations and the
 * metadata. Removed pages and everything only they used are left out of the
 * file entirely, so nothing deleted can be recovered from it.
 */
export async function exportPdf(options: ExportOptions): Promise<ExportResult> {
  const { model } = options;
  const now = options.now ?? new Date();
  const selection = options.pageIds ? new Set(options.pageIds) : null;
  const pages = model.pages.filter((page) => !selection || selection.has(page.id));
  if (pages.length === 0) throw new ExportError('no-pages', 'There are no pages to save.');

  // The original file is the base, so its bookmarks, forms and other
  // document-level structure survive; extracts start from an empty document.
  const originalId = originalSourceId(model);
  const usesOriginal = pages.some(
    (page) => page.source.kind === 'source' && page.source.sourceId === originalId,
  );
  const loaded = new Map<SourceId, PDFDocument>();
  const load = async (id: SourceId) => {
    let source = loaded.get(id);
    if (!source) {
      source = await loadSource(options.sources.get(id), id);
      loaded.set(id, source);
    }
    return source;
  };
  let doc: PDFDocument;
  let basePages: PDFPage[] = [];
  if (!selection && originalId && usesOriginal) {
    doc = await load(originalId);
    basePages = doc.getPages();
  } else {
    doc = await PDFDocument.create({ updateMetadata: false });
  }

  // Assemble the pages in order: the base document's own pages are reused
  // (once each); repeats and pages of other files are copied in, one batch
  // per file so the resources they share are copied once.
  const assembled: Array<{ model: PageModel; page: PDFPage | null }> = [];
  const usedBasePages = new Set<number>();
  const batches = new Map<SourceId, Array<{ slot: number; pageIndex: number }>>();
  for (const page of pages) {
    const slot = assembled.length;
    assembled.push({ model: page, page: null });
    if (page.source.kind === 'blank') {
      const blank = PDFPage.create(doc);
      blank.setSize(page.size.width / page.userUnit, page.size.height / page.userUnit);
      assembled[slot]!.page = blank;
      continue;
    }
    const { sourceId, pageIndex } = page.source;
    if (sourceId === originalId && basePages.length > 0 && !usedBasePages.has(pageIndex)) {
      usedBasePages.add(pageIndex);
      assembled[slot]!.page = basePages[pageIndex] ?? null;
      if (!assembled[slot]!.page) {
        throw new ExportError('unreadable-source', 'A page of the document is missing.');
      }
      continue;
    }
    const batch = batches.get(sourceId);
    if (batch) batch.push({ slot, pageIndex });
    else batches.set(sourceId, [{ slot, pageIndex }]);
  }
  for (const [sourceId, batch] of batches) {
    const source = sourceId === originalId && basePages.length > 0 ? doc : await load(sourceId);
    if (batch.some(({ pageIndex }) => pageIndex >= source.getPageCount())) {
      throw new ExportError('unreadable-source', 'A page of a source document is missing.');
    }
    const copies = new PageCopier(source, doc).copyPages(batch.map((entry) => entry.pageIndex));
    batch.forEach(({ slot }, index) => {
      assembled[slot]!.page = copies[index]!;
    });
  }
  const output = assembled.map(({ model: pageModel, page }) => ({ model: pageModel, page: page! }));
  for (const { model: pageModel, page } of output) {
    page.setRotation(degrees(normalizeRotation(pageModel.sourceRotation + pageModel.rotation)));
  }
  replacePageTree(
    doc,
    output.map((entry) => entry.page),
  );
  pruneRemovedPages(
    doc,
    output.map((entry) => entry.page),
  );
  keepPageLabelsIfValid(
    doc,
    basePages.map((page) => page.ref.tag),
    output.map((entry) => entry.page),
  );

  // Annotations.
  const pageAnnotations = new Map<PageId, Annotation[]>();
  for (const annotation of Object.values(model.annotations)) {
    const list = pageAnnotations.get(annotation.pageId);
    if (list) list.push(annotation);
    else pageAnnotations.set(annotation.pageId, [annotation]);
  }
  const assets = new Map<string, AssetData>();
  for (const [id, bytes] of options.assets) {
    const ref = model.assets[id];
    if (ref) assets.set(id, { ref, bytes });
  }
  const writer = new AnnotationWriter(doc, assets);
  await writer.prepare(output.flatMap((entry) => pageAnnotations.get(entry.model.id) ?? []));
  const flatten = options.flatten ?? model.exportConfig.flattenAnnotations;
  for (const { model: pageModel, page } of output) {
    const annotations = pageAnnotations.get(pageModel.id) ?? [];
    if (annotations.length === 0) continue;
    isolatePageEntries(page);
    // Model geometry is relative to the lower-left corner of the visible area.
    const origin = pageOrigin(page);
    const offset = { dx: origin.x, dy: origin.y };
    if (flatten) writer.flatten(page, annotations, offset);
    else for (const annotation of annotations) writer.addEditable(page, annotation, offset, now);
  }

  if (model.exportConfig.writeMetadata) {
    writeMetadata(doc, { ...model.metadata, producer: 'Folio' }, now);
  }

  collectGarbage(doc.context);

  if (options.protection) {
    doc.encrypt({
      userPassword: options.protection.userPassword,
      ownerPassword: randomPassword(),
      permissions: toUserPermissions(options.protection.permissions),
    });
  }
  const bytes = await doc.save({ useObjectStreams: true, rewrite: true, addDefaultPage: false });
  return { bytes, warnings: writer.lossyText ? ['unsupported-characters'] : [] };
}
