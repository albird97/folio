import {
  normalizeRotation,
  type DocumentMetadata,
  type EncryptionState,
  type FormFieldDescriptor,
  type FormFieldValue,
  type Rotation,
} from '@folio/document-model';
import {
  AnnotationMode,
  AnnotationType,
  GlobalWorkerOptions,
  InvalidPDFException,
  PDFDateString,
  PDFWorker,
  PasswordException,
  PasswordResponses,
  PermissionFlag,
  RenderingCancelledException,
  TextLayer,
  VerbosityLevel,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfError } from './errors';
import {
  fieldDescriptor,
  indexFields,
  needsListValue,
  sameFieldValue,
  storedValues,
  widgetFrom,
  type FieldObjectLike,
  type FormFieldEntry,
  type FormWidget,
  type WidgetAnnotationLike,
} from './forms';
import { normalizeMetadata, type PdfJsInfo, type XmpLike } from './metadata';
import { resolveOutline, type OutlineItem, type RawOutlineNode } from './outline';
import {
  estimatePageInfo,
  pageInfoFrom,
  samePageInfo,
  type PageInfoUpdate,
  type PdfPageInfo,
} from './page-info';
import { sniffPdf } from './sniff';
import { pageTextFrom, type PageText, type TextContentLike } from './text';

/**
 * Folio uses PDF.js' *legacy* build on every target. The modern build calls
 * very recent built-ins (e.g. Map#getOrInsertComputed) natively, which the
 * system WebKit on supported macOS versions does not have yet.
 */
export interface PdfEngineConfig {
  /** URL of `pdf.worker.min.mjs`, bundled with the app (never remote). */
  workerSrc: string;
  /**
   * Base URL (with trailing slash) that serves PDF.js' `cmaps/`,
   * `standard_fonts/`, `wasm/` and `iccs/` folders. Null disables them, which
   * is acceptable for inspection but degrades rendering fidelity.
   */
  assetBaseUrl: string | null;
  /** Hard upper bound for a single file. */
  maxFileBytes?: number;
}

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB

export interface PdfPermissions {
  print: boolean;
  copy: boolean;
  modify: boolean;
  annotate: boolean;
  fillForms: boolean;
  assemble: boolean;
}

export interface PdfDocumentInfo {
  pageCount: number;
  pdfVersion: string | null;
  metadata: DocumentMetadata;
  /**
   * One entry per page. Large documents open before every page has been
   * read: entries from `exactPageCount` on are estimates, and the exact values
   * arrive through `PdfDocumentHandle.onPageInfo`.
   */
  pages: PdfPageInfo[];
  /** How many leading entries of `pages` were read exactly before opening. */
  exactPageCount: number;
  encryption: EncryptionState;
  /** Null when the document is not encrypted (everything allowed). */
  permissions: PdfPermissions | null;
  isLinearized: boolean;
  forms: 'none' | 'acroform' | 'xfa';
  hasSignatures: boolean;
}

export interface RenderOptions {
  /** CSS pixels per PDF point. */
  scale: number;
  /** User rotation added on top of the page's own /Rotate. */
  rotation?: Rotation;
  devicePixelRatio?: number;
  /** Largest canvas area to allocate, in device pixels. */
  maxCanvasPixels?: number;
  /** Set the canvas' CSS size to the page size (default). Off when a layout sizes it. */
  styleCanvas?: boolean;
  /**
   * 'print' draws what a PDF marks for printing: annotations without the
   * print flag are left out. Default 'display'.
   */
  intent?: 'display' | 'print';
}

export interface RenderJob {
  /** Resolves to false when the render was cancelled. */
  promise: Promise<boolean>;
  cancel(): void;
}

export interface ViewOptions {
  /** CSS pixels per PDF point. */
  scale: number;
  /** User rotation added on top of the page's own /Rotate. */
  rotation?: Rotation;
}

/** Maps PDF user space to CSS pixels inside the (rotated) page box. */
export interface PageViewportInfo {
  width: number;
  height: number;
  transform: number[];
}

export interface TextLayerResult {
  /** One element per text run of `getPageText(pageIndex).items`, in order. */
  textDivs: readonly HTMLElement[];
}

export interface TextLayerJob {
  /** Resolves to null when the job was cancelled. */
  promise: Promise<TextLayerResult | null>;
  cancel(): void;
}

export interface PdfDocumentHandle {
  readonly info: PdfDocumentInfo;
  /** True once every entry of `info.pages` has been read exactly. */
  readonly pagesComplete: boolean;
  /** Resolves when exact info for every page has been delivered. */
  readonly pagesReady: Promise<void>;
  /**
   * Exact page info for pages whose entry in `info.pages` was an estimate, as
   * they are read (in the background or on demand). A new listener first
   * receives every correction made before it subscribed.
   */
  onPageInfo(listener: (updates: readonly PageInfoUpdate[]) => void): () => void;
  renderPage(pageIndex: number, canvas: HTMLCanvasElement, options: RenderOptions): RenderJob;
  /** Text runs of a page, extracted in the PDF.js worker. */
  getPageText(pageIndex: number): Promise<PageText>;
  /** Renders selectable, invisible text over a page for copy and search highlights. */
  renderTextLayer(pageIndex: number, container: HTMLElement, options: ViewOptions): TextLayerJob;
  getViewport(pageIndex: number, options: ViewOptions): Promise<PageViewportInfo>;
  getOutline(): Promise<OutlineItem[]>;
  /**
   * The fields of the file's interactive form (AcroForm) with the values the
   * file has; none for documents without one, or with an XFA form.
   */
  getFormFields(): Promise<FormFieldDescriptor[]>;
  /** The form widgets of a page in the page's annotation order, hidden ones included. */
  getFormWidgets(pageIndex: number): Promise<FormWidget[]>;
  /**
   * Fills in fields (by name) for rendering and `saveFormValues`: pages are
   * drawn with these values from then on. Fields or values that do not fit
   * are left alone. Returns the pages whose fields show something else now.
   * Takes effect once `getFormFields` has resolved.
   */
  setFormValues(values: Iterable<readonly [string, FormFieldValue]>): number[];
  /**
   * The file with the filled-in values written into it as an incremental
   * update (values and their appearances, encryption kept), or null while
   * every field has the file's own value. Password fields are never written.
   */
  saveFormValues(): Promise<Uint8Array | null>;
  /** Frees cached rendering resources of a page that is no longer on screen. */
  releasePage(pageIndex: number): void;
  destroy(): Promise<void>;
}

export interface OpenOptions {
  password?: string;
}

export interface PdfEngine {
  open(bytes: Uint8Array, options?: OpenOptions): Promise<PdfDocumentHandle>;
  destroy(): void;
}

const DEFAULT_MAX_CANVAS_PIXELS = 4096 * 4096;
const PAGE_INFO_BATCH = 32;
/** Pages read before a document opens; the rest stream in afterwards. */
export const EAGER_PAGE_COUNT = 64;
const TEXT_CACHE_SIZE = 24;

/**
 * Maps the raw /P bits that PDF.js reports. The high-quality print bit (12)
 * only refines the print bit (3), so on its own it does not permit printing.
 */
export function permissionsFrom(flags: ReadonlySet<number> | null): PdfPermissions | null {
  if (!flags) return null;
  return {
    print: flags.has(PermissionFlag.PRINT),
    copy: flags.has(PermissionFlag.COPY),
    modify: flags.has(PermissionFlag.MODIFY_CONTENTS),
    annotate: flags.has(PermissionFlag.MODIFY_ANNOTATIONS),
    fillForms: flags.has(PermissionFlag.FILL_INTERACTIVE_FORMS),
    assemble: flags.has(PermissionFlag.ASSEMBLE),
  };
}

async function readPageRange(
  document: PDFDocumentProxy,
  start: number,
  end: number,
): Promise<PdfPageInfo[]> {
  const pages: PdfPageInfo[] = [];
  for (let from = start; from < end; from += PAGE_INFO_BATCH) {
    const to = Math.min(end, from + PAGE_INFO_BATCH);
    const batch: Array<Promise<PdfPageInfo>> = [];
    for (let index = from; index < to; index += 1) {
      batch.push(document.getPage(index + 1).then(pageInfoFrom));
    }
    pages.push(...(await Promise.all(batch)));
  }
  return pages;
}

const yieldToRenders = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function classify(error: unknown, usedPassword: boolean): PdfError {
  if (error instanceof PdfError) return error;
  if (error instanceof PasswordException) {
    return error.code === PasswordResponses.INCORRECT_PASSWORD && usedPassword
      ? new PdfError('incorrect-password', undefined, { cause: error })
      : new PdfError('password-required', undefined, { cause: error });
  }
  if (error instanceof InvalidPDFException) {
    return new PdfError('invalid-pdf', undefined, { cause: error });
  }
  return new PdfError('unknown', undefined, { cause: error });
}

class PdfJsDocumentHandle implements PdfDocumentHandle {
  #task: PDFDocumentLoadingTask;
  #document: PDFDocumentProxy;
  #destroyed = false;
  #pages: PdfPageInfo[];
  #exact: boolean[];
  #remaining: number;
  #listeners = new Set<(updates: readonly PageInfoUpdate[]) => void>();
  #textCache = new Map<number, Promise<TextContentLike>>();
  /** Pages PDF.js has loaded (and may hold rendering resources for). */
  #loaded = new Set<number>();
  #formFields: Promise<FormFieldEntry[]> | null = null;
  /** Form fields by name, once read; `setFormValues` needs them. */
  #fields: ReadonlyMap<string, FormFieldEntry> | null = null;
  /** Widget annotations by page; they never change. */
  #widgets = new Map<number, Promise<WidgetAnnotationLike[]>>();
  #resolvePagesReady!: () => void;
  readonly pagesReady: Promise<void>;

  constructor(
    task: PDFDocumentLoadingTask,
    document: PDFDocumentProxy,
    readonly info: PdfDocumentInfo,
  ) {
    this.#task = task;
    this.#document = document;
    this.#pages = [...info.pages];
    this.#exact = info.pages.map((_, index) => index < info.exactPageCount);
    this.#remaining = info.pageCount - info.exactPageCount;
    this.pagesReady = new Promise((resolve) => {
      this.#resolvePagesReady = resolve;
    });
    if (this.#remaining === 0) this.#resolvePagesReady();
    else void this.#readRemainingPages(info.exactPageCount);
  }

  get pagesComplete(): boolean {
    return this.#remaining === 0;
  }

  onPageInfo(listener: (updates: readonly PageInfoUpdate[]) => void): () => void {
    this.#listeners.add(listener);
    // Pages are read in the background from the moment the document opens,
    // so corrections made before this listener subscribed are replayed.
    const earlier: PageInfoUpdate[] = [];
    this.#pages.forEach((info, index) => {
      if (info !== this.info.pages[index]) earlier.push({ index, info });
    });
    if (earlier.length > 0) listener(earlier);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #record(pages: ReadonlyArray<{ index: number; info: PdfPageInfo }>): void {
    const updates: PageInfoUpdate[] = [];
    for (const { index, info } of pages) {
      if (this.#exact[index]) continue;
      this.#exact[index] = true;
      this.#remaining -= 1;
      // Only report pages whose estimate was wrong; the others already match.
      if (!samePageInfo(this.#pages[index]!, info)) {
        this.#pages[index] = info;
        updates.push({ index, info });
      }
    }
    if (updates.length > 0) for (const listener of this.#listeners) listener(updates);
    if (this.#remaining === 0) this.#resolvePagesReady();
  }

  async #readRemainingPages(from: number): Promise<void> {
    for (let start = from; start < this.info.pageCount; start += PAGE_INFO_BATCH * 4) {
      if (this.#destroyed) return;
      await yieldToRenders();
      const end = Math.min(this.info.pageCount, start + PAGE_INFO_BATCH * 4);
      try {
        const infos = await readPageRange(this.#document, start, end);
        this.#record(infos.map((info, offset) => ({ index: start + offset, info })));
      } catch {
        // A page that cannot be read keeps its estimate; rendering reports the error.
        for (let index = start; index < end; index += 1) {
          if (!this.#exact[index]) {
            this.#exact[index] = true;
            this.#remaining -= 1;
          }
        }
        if (this.#remaining === 0) this.#resolvePagesReady();
      }
    }
  }

  async #getPage(pageIndex: number): Promise<PDFPageProxy> {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.info.pageCount) {
      throw new RangeError(`Page ${pageIndex} does not exist.`);
    }
    const page = await this.#document.getPage(pageIndex + 1);
    this.#loaded.add(pageIndex);
    if (!this.#exact[pageIndex]) this.#record([{ index: pageIndex, info: pageInfoFrom(page) }]);
    return page;
  }

  #viewport(page: PDFPageProxy, options: ViewOptions) {
    const rotation = normalizeRotation(page.rotate + (options.rotation ?? 0));
    return page.getViewport({ scale: options.scale, rotation });
  }

  renderPage(pageIndex: number, canvas: HTMLCanvasElement, options: RenderOptions): RenderJob {
    let cancelled = false;
    let cancelTask: (() => void) | null = null;
    const promise = (async () => {
      if (this.#destroyed) return false;
      const page = await this.#getPage(pageIndex);
      if (cancelled || this.#destroyed) return false;
      const cssViewport = this.#viewport(page, options);
      const maxPixels = options.maxCanvasPixels ?? DEFAULT_MAX_CANVAS_PIXELS;
      let ratio = options.devicePixelRatio ?? 1;
      const area = cssViewport.width * cssViewport.height * ratio * ratio;
      if (area > maxPixels) ratio = Math.sqrt(maxPixels / (cssViewport.width * cssViewport.height));
      const viewport = this.#viewport(page, { ...options, scale: options.scale * ratio });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      if (options.styleCanvas !== false) {
        canvas.style.width = `${Math.floor(cssViewport.width)}px`;
        canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      }
      const task = page.render({
        canvas,
        viewport,
        intent: options.intent ?? 'display',
        // Form fields are drawn from their appearances like other annotations,
        // with the values from `setFormValues` (PDF.js draws those as it saves
        // them), so pages look as they will be saved and printed. Without
        // values this draws exactly what AnnotationMode.ENABLE does.
        annotationMode: AnnotationMode.ENABLE_STORAGE,
      });
      cancelTask = () => task.cancel();
      try {
        await task.promise;
        return true;
      } catch (error) {
        if (error instanceof RenderingCancelledException) return false;
        throw error;
      }
    })();
    return {
      promise,
      cancel: () => {
        cancelled = true;
        cancelTask?.();
      },
    };
  }

  #textContent(pageIndex: number): Promise<TextContentLike> {
    const cached = this.#textCache.get(pageIndex);
    if (cached) {
      // Refresh its position in the LRU order.
      this.#textCache.delete(pageIndex);
      this.#textCache.set(pageIndex, cached);
      return cached;
    }
    const content = this.#getPage(pageIndex).then(
      (page) => page.getTextContent({ includeMarkedContent: false }) as Promise<TextContentLike>,
    );
    content.catch(() => this.#textCache.delete(pageIndex));
    this.#textCache.set(pageIndex, content);
    if (this.#textCache.size > TEXT_CACHE_SIZE) {
      this.#textCache.delete(this.#textCache.keys().next().value!);
    }
    return content;
  }

  async getPageText(pageIndex: number): Promise<PageText> {
    return pageTextFrom(await this.#textContent(pageIndex));
  }

  renderTextLayer(pageIndex: number, container: HTMLElement, options: ViewOptions): TextLayerJob {
    let cancelled = false;
    let layer: TextLayer | null = null;
    const promise = (async (): Promise<TextLayerResult | null> => {
      const [page, content] = await Promise.all([
        this.#getPage(pageIndex),
        this.#textContent(pageIndex),
      ]);
      if (cancelled || this.#destroyed) return null;
      container.replaceChildren();
      layer = new TextLayer({
        textContentSource: content as never,
        container,
        viewport: this.#viewport(page, options),
      });
      try {
        await layer.render();
      } catch (error) {
        if (cancelled) return null;
        throw error;
      }
      if (cancelled) return null;
      // Lets a selection drag past the last line without jumping (as PDF.js' viewer does).
      const end = container.ownerDocument.createElement('div');
      end.className = 'endOfContent';
      container.append(end);
      return { textDivs: layer.textDivs };
    })();
    return {
      promise,
      cancel: () => {
        cancelled = true;
        layer?.cancel();
      },
    };
  }

  async getViewport(pageIndex: number, options: ViewOptions): Promise<PageViewportInfo> {
    const viewport = this.#viewport(await this.#getPage(pageIndex), options);
    return { width: viewport.width, height: viewport.height, transform: [...viewport.transform] };
  }

  async getOutline(): Promise<OutlineItem[]> {
    const outline = (await this.#document.getOutline()) as RawOutlineNode[] | null;
    return resolveOutline(outline, {
      pageCount: this.info.pageCount,
      getDestination: (name) => this.#document.getDestination(name),
      getPageIndex: (ref) => this.#document.getPageIndex(ref as never),
    });
  }

  getFormFields(): Promise<FormFieldDescriptor[]> {
    this.#formFields ??= this.#readFormFields();
    return this.#formFields.then((entries) => entries.map(fieldDescriptor));
  }

  async #readFormFields(): Promise<FormFieldEntry[]> {
    if (this.info.forms !== 'acroform') return [];
    try {
      const objects = (await this.#document.getFieldObjects()) as Map<
        string,
        FieldObjectLike[]
      > | null;
      if (!objects || this.#destroyed) return [];
      // A signed signature field cannot be signed again.
      const signed = new Set<string>();
      if (this.info.hasSignatures) {
        const signatures = ((await this.#document.getSignatures()) ?? []) as Array<{
          id?: unknown;
        }>;
        for (const { id } of signatures) {
          if (typeof id === 'string') signed.add(id.split(':')[0]!);
        }
      }
      const lists = new Map<string, string[]>();
      for (const [name, list] of objects) {
        const widget = list.find(needsListValue);
        if (!widget) continue;
        const data = (await this.#widgetAnnotations(widget.page as number)).find(
          (annotation) => annotation.id === widget.id,
        );
        if (Array.isArray(data?.fieldValue)) {
          lists.set(
            name,
            data.fieldValue.filter((value): value is string => typeof value === 'string'),
          );
        }
      }
      const entries = indexFields(objects, signed, lists);
      this.#fields = new Map(entries.map((entry) => [entry.name, entry]));
      return entries;
    } catch {
      // A form PDF.js cannot read stays on the pages as it was saved.
      return [];
    }
  }

  #widgetAnnotations(pageIndex: number): Promise<WidgetAnnotationLike[]> {
    const cached = this.#widgets.get(pageIndex);
    if (cached) return cached;
    const widgets = this.#getPage(pageIndex).then(async (page) => {
      const annotations = (await page.getAnnotations({ intent: 'display' })) as Array<
        WidgetAnnotationLike & { annotationType?: unknown }
      >;
      return annotations.filter(
        (annotation) =>
          annotation.annotationType === AnnotationType.WIDGET && typeof annotation.id === 'string',
      );
    });
    widgets.catch(() => this.#widgets.delete(pageIndex));
    this.#widgets.set(pageIndex, widgets);
    return widgets;
  }

  async getFormWidgets(pageIndex: number): Promise<FormWidget[]> {
    const [page, annotations] = await Promise.all([
      this.#getPage(pageIndex),
      this.#widgetAnnotations(pageIndex),
    ]);
    // Page space starts at the lower-left corner of the visible area.
    const [x = 0, y = 0] = page.view;
    return annotations.flatMap((annotation) => widgetFrom(annotation, { x, y }) ?? []);
  }

  setFormValues(values: Iterable<readonly [string, FormFieldValue]>): number[] {
    const fields = this.#fields;
    if (!fields || this.#destroyed) return [];
    const storage = this.#document.annotationStorage;
    const pages = new Set<number>();
    for (const [name, value] of values) {
      const field = fields.get(name);
      const stored = field && !field.readOnly ? storedValues(field, value) : null;
      if (!field || !stored) continue;
      // The file's own values are left to the file: with nothing stored, pages
      // render and save exactly as the file has them.
      const unchanged = sameFieldValue(value, field.value);
      for (const [id, entry] of stored) {
        if (unchanged) storage.remove(id);
        else storage.setValue(id, entry);
      }
      for (const widget of field.widgets) if (widget.pageIndex >= 0) pages.add(widget.pageIndex);
    }
    return [...pages].sort((a, b) => a - b);
  }

  async saveFormValues(): Promise<Uint8Array | null> {
    if (this.#destroyed || this.#document.annotationStorage.size === 0) return null;
    return this.#document.saveDocument();
  }

  releasePage(pageIndex: number): void {
    if (this.#destroyed || !this.#loaded.has(pageIndex)) return;
    // getPage resolves from PDF.js' cache; cleanup() is a no-op while rendering.
    void this.#document
      .getPage(pageIndex + 1)
      .then((page) => page.cleanup())
      .catch(() => undefined);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#listeners.clear();
    this.#textCache.clear();
    this.#widgets.clear();
    await this.#task.destroy();
  }
}

export function createPdfEngine(config: PdfEngineConfig): PdfEngine {
  GlobalWorkerOptions.workerSrc = config.workerSrc;
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const base = config.assetBaseUrl;
  // One worker thread is shared by every open document.
  let worker: PDFWorker | null = null;

  return {
    async open(bytes, options = {}) {
      if (bytes.length === 0) throw new PdfError('empty-file');
      if (bytes.length > maxFileBytes) throw new PdfError('too-large');
      const sniff = sniffPdf(bytes);
      if (!sniff.isPdf) throw new PdfError('not-a-pdf');

      worker ??= new PDFWorker({ verbosity: VerbosityLevel.ERRORS });
      const usedPassword = options.password !== undefined;
      const task = getDocument({
        // PDF.js transfers (detaches) the buffer it is given; keep the caller's intact.
        data: bytes.slice(),
        ...(usedPassword ? { password: options.password } : {}),
        worker,
        verbosity: VerbosityLevel.ERRORS,
        ...(base
          ? {
              cMapUrl: `${base}cmaps/`,
              cMapPacked: true,
              standardFontDataUrl: `${base}standard_fonts/`,
              wasmUrl: `${base}wasm/`,
              iccUrl: `${base}iccs/`,
            }
          : {}),
        enableXfa: false,
        stopAtErrors: false,
      });
      let document: PDFDocumentProxy;
      try {
        document = await task.promise;
      } catch (error) {
        await task.destroy().catch(() => undefined);
        throw classify(error, usedPassword);
      }
      try {
        const exactPageCount = Math.min(document.numPages, EAGER_PAGE_COUNT);
        const [{ info, metadata }, permissions, eager] = await Promise.all([
          document.getMetadata(),
          document.getPermissions(),
          readPageRange(document, 0, exactPageCount),
        ]);
        const estimate = estimatePageInfo(eager);
        const pages = [
          ...eager,
          ...Array.from({ length: document.numPages - exactPageCount }, () => estimate),
        ];
        const pdfInfo = info as PdfJsInfo;
        const encrypted = typeof pdfInfo.EncryptFilterName === 'string';
        const encryption: EncryptionState = !encrypted
          ? 'none'
          : usedPassword
            ? 'password-protected'
            : 'owner-restricted';
        const documentInfo: PdfDocumentInfo = {
          pageCount: document.numPages,
          pdfVersion:
            typeof pdfInfo.PDFFormatVersion === 'string'
              ? pdfInfo.PDFFormatVersion
              : sniff.headerVersion,
          metadata: normalizeMetadata(pdfInfo, (metadata as XmpLike | null) ?? null, (value) =>
            PDFDateString.toDateObject(value),
          ),
          pages,
          exactPageCount,
          encryption,
          permissions: encrypted ? permissionsFrom(permissions) : null,
          isLinearized: pdfInfo.IsLinearized === true,
          forms:
            pdfInfo.IsXFAPresent === true
              ? 'xfa'
              : pdfInfo.IsAcroFormPresent === true
                ? 'acroform'
                : 'none',
          hasSignatures: pdfInfo.IsSignaturesPresent === true,
        };
        if (documentInfo.pageCount === 0) throw new PdfError('invalid-pdf');
        return new PdfJsDocumentHandle(task, document, documentInfo);
      } catch (error) {
        await task.destroy().catch(() => undefined);
        throw classify(error, usedPassword);
      }
    },
    destroy() {
      worker?.destroy();
      worker = null;
    },
  };
}
