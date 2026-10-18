import {
  normalizeRotation,
  type DocumentMetadata,
  type EncryptionState,
  type Rotation,
  type Size,
} from '@folio/document-model';
import {
  GlobalWorkerOptions,
  InvalidPDFException,
  PDFDateString,
  PDFWorker,
  PasswordException,
  PasswordResponses,
  PermissionFlag,
  RenderingCancelledException,
  VerbosityLevel,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfError } from './errors';
import { normalizeMetadata, type PdfJsInfo, type XmpLike } from './metadata';
import { sniffPdf } from './sniff';

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

export interface PdfPageInfo {
  /** Unrotated crop-box size in points. */
  size: Size;
  rotation: Rotation;
}

export interface PdfDocumentInfo {
  pageCount: number;
  pdfVersion: string | null;
  metadata: DocumentMetadata;
  pages: PdfPageInfo[];
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
}

export interface RenderJob {
  /** Resolves to false when the render was cancelled. */
  promise: Promise<boolean>;
  cancel(): void;
}

export interface PdfDocumentHandle {
  readonly info: PdfDocumentInfo;
  renderPage(pageIndex: number, canvas: HTMLCanvasElement, options: RenderOptions): RenderJob;
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

function permissionsFrom(flags: Set<number> | null): PdfPermissions | null {
  if (!flags) return null;
  return {
    print: flags.has(PermissionFlag.PRINT) || flags.has(PermissionFlag.PRINT_HIGH_QUALITY),
    copy: flags.has(PermissionFlag.COPY),
    modify: flags.has(PermissionFlag.MODIFY_CONTENTS),
    annotate: flags.has(PermissionFlag.MODIFY_ANNOTATIONS),
    fillForms: flags.has(PermissionFlag.FILL_INTERACTIVE_FORMS),
    assemble: flags.has(PermissionFlag.ASSEMBLE),
  };
}

async function readPageInfo(document: PDFDocumentProxy): Promise<PdfPageInfo[]> {
  const pages: PdfPageInfo[] = new Array(document.numPages);
  for (let start = 0; start < document.numPages; start += PAGE_INFO_BATCH) {
    const end = Math.min(document.numPages, start + PAGE_INFO_BATCH);
    const batch = [];
    for (let index = start; index < end; index += 1) {
      batch.push(
        document.getPage(index + 1).then((page) => {
          const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
          let rotation: Rotation = 0;
          try {
            rotation = normalizeRotation(page.rotate);
          } catch {
            rotation = 0;
          }
          pages[index] = {
            size: { width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) },
            rotation,
          };
        }),
      );
    }
    await Promise.all(batch);
  }
  return pages;
}

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

  constructor(
    task: PDFDocumentLoadingTask,
    document: PDFDocumentProxy,
    readonly info: PdfDocumentInfo,
  ) {
    this.#task = task;
    this.#document = document;
  }

  renderPage(pageIndex: number, canvas: HTMLCanvasElement, options: RenderOptions): RenderJob {
    let cancelled = false;
    let cancelTask: (() => void) | null = null;
    const promise = (async () => {
      if (this.#destroyed) return false;
      const page = await this.#document.getPage(pageIndex + 1);
      if (cancelled) return false;
      const rotation = normalizeRotation(page.rotate + (options.rotation ?? 0));
      const cssViewport = page.getViewport({ scale: options.scale, rotation });
      const maxPixels = options.maxCanvasPixels ?? DEFAULT_MAX_CANVAS_PIXELS;
      let ratio = options.devicePixelRatio ?? 1;
      const area = cssViewport.width * cssViewport.height * ratio * ratio;
      if (area > maxPixels) ratio = Math.sqrt(maxPixels / (cssViewport.width * cssViewport.height));
      const viewport = page.getViewport({ scale: options.scale * ratio, rotation });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      const task = page.render({ canvas, viewport });
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

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
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
        const [{ info, metadata }, permissions, pages] = await Promise.all([
          document.getMetadata(),
          document.getPermissions(),
          readPageInfo(document),
        ]);
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
