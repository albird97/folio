import {
  addRotation,
  createDocumentModel,
  createEditorState,
  createSourceDocument,
  createViewState,
  execute,
  markSaved as markEditorSaved,
  movePagesOperation,
  newAssetId,
  newDocumentId,
  OperationError,
  parseRecoverySnapshot,
  redo as redoHistory,
  undo as undoHistory,
  type Annotation,
  type AnnotationId,
  type AssetId,
  type AssetRef,
  type DocumentMetadata,
  type DocumentModel,
  type DocumentStamps,
  type DocumentViewState,
  type EditorDocumentState,
  type Operation,
  type PageId,
  type SourceId,
  type ZoomMode,
} from '@folio/document-model';
import {
  isPdfError,
  PdfError,
  sha256Hex,
  toSourceDescriptor,
  type PageInfoUpdate,
  type PdfDocumentHandle,
  type PdfDocumentInfo,
  type PdfEngine,
  type PdfErrorCode,
} from '@folio/pdf-core';
import type { ExportResult } from '@folio/pdf-core/export';
import type { IncomingFile } from '@folio/platform-adapters';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions, type TextMatch } from '../search/match';
import { searchDocument, type SearchableRun } from '../search/run';
import { clampZoom, stepZoom } from '../viewer/zoom';
import {
  ALL_PERMISSIONS,
  applyPageInfo,
  blankPageLike,
  duplicatePagesOperation,
  editPermissions,
  inDocumentOrder,
  pagesLabel,
  PERMISSION_MESSAGES,
  type EditPermissions,
} from './editing';

export type DocumentStatus = 'loading' | 'needs-password' | 'ready' | 'error';

/** Where the viewer should scroll: a page, optionally a point on it (PDF user space). */
export interface NavigationTarget {
  /** Position of the page in the document. */
  pageIndex: number;
  point?: { x: number | null; y: number | null };
  /** A point in page space (annotations), which needs no engine to place. */
  pagePoint?: { x: number; y: number };
  /** A search match to bring into view (the viewer locates its text). */
  match?: TextMatch;
  /** Put the target at the top of the window (outline, page field) or centre it (search). */
  align: 'top' | 'center';
}

export interface SearchState {
  open: boolean;
  query: string;
  options: SearchOptions;
  status: 'idle' | 'searching' | 'done';
  matches: TextMatch[];
  /** Index of the highlighted match in `matches`, or -1. */
  active: number;
  pagesSearched: number;
  /** More matches exist than were collected. */
  truncated: boolean;
}

export const IDLE_SEARCH: SearchState = {
  open: false,
  query: '',
  options: DEFAULT_SEARCH_OPTIONS,
  status: 'idle',
  matches: [],
  active: -1,
  pagesSearched: 0,
  truncated: false,
};

/** Selected pages (pages panel) and annotations (page view). */
export interface Selection {
  pages: PageId[];
  /** Where a Shift-click range in the pages panel starts. */
  anchor: PageId | null;
  annotations: AnnotationId[];
}

export const EMPTY_SELECTION: Selection = { pages: [], anchor: null, annotations: [] };

/** One tab. Plain data only: engine handles and bytes live in `resources`. */
export interface WorkspaceDocument {
  key: string;
  fileName: string;
  byteLength: number;
  status: DocumentStatus;
  error: { code: PdfErrorCode; message: string } | null;
  /** Set after a wrong password so the form can say so. */
  passwordRejected: boolean;
  editor: EditorDocumentState | null;
  view: DocumentViewState | null;
  /** The opened file as the engine read it. */
  info: PdfDocumentInfo | null;
  /** What the document's author allows. */
  permissions: EditPermissions;
  /** False while the sizes of a large document's later pages are still being read. */
  pagesComplete: boolean;
  /** A pending scroll request for the viewer; it clears it once handled. */
  navigation: { seq: number; target: NavigationTarget } | null;
  search: SearchState;
  selection: Selection;
  /** A long-running task (saving, inserting pages), for progress display. */
  busy: string | null;
  /**
   * Where Save writes: the opened file (desktop) or the file chosen in the
   * last Save As. Null when Save has to ask where (Save As).
   */
  saveTarget: { handle: string; name: string } | null;
  /** SHA-256 of the save target's contents as Folio last read or wrote them. */
  diskSha256: string | null;
  /** Identifies the document's crash-recovery record. */
  recoveryId: string;
}

export type InsertOutcome =
  | { status: 'inserted'; count: number }
  | { status: 'needs-password'; rejected: boolean }
  | { status: 'failed'; message: string };

export interface ExportRequest {
  /** Only these pages, as a new document (extract). */
  pageIds?: PageId[];
  /** Burn annotations into the pages. */
  flatten?: boolean;
  /**
   * Leave out the original's password protection. Only for bytes that never
   * leave memory (printing); saved files always keep it.
   */
  unprotected?: boolean;
  /** Leave out Folio's annotations (printing without comments). */
  withoutAnnotations?: boolean;
}

export interface WorkspaceState {
  documents: WorkspaceDocument[];
  activeKey: string | null;
  /** A short, transient message (e.g. skipped non-PDF files). Never contains document content. */
  notice: { id: number; message: string } | null;

  openFiles(files: IncomingFile[]): Promise<void>;
  submitPassword(key: string, password: string): Promise<void>;
  close(key: string): Promise<void>;
  activate(key: string): void;
  activateRelative(delta: 1 | -1): void;
  setCurrentPage(key: string, pageId: PageId): void;
  /** Records the scroll position reported by the viewer. */
  updatePosition(key: string, pageId: PageId, pageOffset: number): void;
  setZoom(key: string, mode: ZoomMode, zoom?: number): void;
  zoomBy(key: string, direction: 1 | -1): void;
  /** Stores the scale the viewer computed for a fit mode. */
  syncFitZoom(key: string, zoom: number): void;
  rotateView(key: string, delta: 90 | -90): void;
  navigate(key: string, target: NavigationTarget): void;
  clearNavigation(key: string, seq: number): void;
  openSearch(key: string): void;
  closeSearch(key: string): void;
  setSearch(key: string, changes: { query?: string; options?: Partial<SearchOptions> }): void;
  stepSearch(key: string, direction: 1 | -1): void;
  selectMatch(key: string, index: number): void;
  showNotice(message: string): void;
  dismissNotice(): void;

  // ── Editing ──
  /** Applies an operation through the history. Returns false when it did not apply. */
  apply(
    key: string,
    operation: Operation,
    options: { label: string; coalesceKey?: string },
  ): boolean;
  undo(key: string): void;
  redo(key: string): void;
  selectPages(key: string, pageIds: PageId[], anchor?: PageId | null): void;
  selectAnnotations(key: string, ids: AnnotationId[]): void;
  rotatePages(key: string, pageIds: PageId[], delta: 90 | -90): void;
  deletePages(key: string, pageIds: PageId[]): void;
  duplicatePages(key: string, pageIds: PageId[]): void;
  movePages(key: string, pageIds: PageId[], toIndex: number): void;
  insertBlankPage(key: string, index: number): void;
  insertPagesFromFile(
    key: string,
    file: IncomingFile,
    index: number,
    password?: string,
  ): Promise<InsertOutcome>;
  addAnnotations(
    key: string,
    annotations: Annotation[],
    options: { label: string; assets?: AssetRef[] },
  ): boolean;
  updateAnnotations(
    key: string,
    annotations: Annotation[],
    options: { label: string; coalesceKey?: string },
  ): boolean;
  deleteAnnotations(key: string, ids: AnnotationId[]): void;
  updateMetadata(key: string, patch: Partial<DocumentMetadata>): void;
  /**
   * Sets or removes (null) the page numbers or the watermark. They change
   * what the pages show, so the document must allow changes.
   */
  setStamps(key: string, stamps: Partial<DocumentStamps>, label: string): boolean;
  /**
   * Keeps image bytes for annotations (PNG or JPEG, already decoded and
   * re-encoded by the caller). The returned asset goes into the model with
   * the annotations that use it.
   */
  registerImage(
    key: string,
    bytes: Uint8Array,
    mimeType: AssetRef['mimeType'],
  ): Promise<AssetRef | null>;
  /** Writes the document (or some of its pages) as a new PDF. */
  exportDocument(key: string, request?: ExportRequest): Promise<ExportResult>;
  /** Opens each group of pages as a new document. */
  splitDocument(key: string, parts: PageId[][]): Promise<number>;
  /** Records that the document's current state was saved. */
  markSaved(key: string): void;
  /**
   * Points Save at a file (after Save As) whose contents hash to `sha256`.
   * `release` gives up the file's handle when the document closes.
   */
  setSaveTarget(
    key: string,
    target: { handle: string; name: string } | null,
    sha256: string | null,
    release?: () => void,
  ): void;
  /** Re-creates a document from a crash-recovery record. */
  restoreDocument(request: RestoreRequest): Promise<RestoreOutcome>;
}

export interface RestoreRequest {
  /** A serialized recovery snapshot (`serializeRecoverySnapshot`). */
  snapshot: string;
  /** Source files by SHA-256 and image assets by asset id. */
  files: ReadonlyMap<string, Uint8Array>;
  /** Passwords of protected sources, by source id. */
  passwords?: Readonly<Record<string, string>>;
  /** The record the document keeps saving to. */
  recoveryId: string;
}

export type RestoreOutcome =
  | { status: 'restored'; key: string }
  | {
      status: 'needs-password';
      sourceId: SourceId;
      fileName: string;
      rejected: boolean;
    }
  | { status: 'failed'; message: string };

interface SourceEntry {
  bytes: Uint8Array;
  handle: PdfDocumentHandle;
  /** What the file was opened with ('' for permission-only encryption); needed to export it. */
  password: string | undefined;
  unsubscribe: () => void;
}

interface Resources {
  /** Gives up the file Save writes to, when it came from Save As. */
  releaseSaveTarget: (() => void) | null;
  file: IncomingFile;
  /** Password to try first (documents split off a protected one). */
  initialPassword: string | undefined;
  bytes: Uint8Array | null;
  handle: PdfDocumentHandle | null;
  /** The file the document was opened from, and files pages were inserted from. */
  sources: Map<SourceId, SourceEntry>;
  /** Image bytes by asset, including images added and then undone (for redo). */
  assets: Map<AssetId, Uint8Array>;
  assetUrls: Map<AssetId, string>;
  /** Page sizes read after opening, applied to the model in batches. */
  pendingPageInfo: Map<SourceId, PageInfoUpdate[]>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  search: AbortController | null;
  /** Text runs of pages already searched (by source page), so repeated searches skip extraction. */
  searchText: Map<string, SearchableRun[]>;
  searchTextChars: number;
}

export interface WorkspaceStore extends StoreApi<WorkspaceState> {
  /** The engine handle of the file a ready document was opened from. */
  getHandle(key: string): PdfDocumentHandle | null;
  /** The engine handle for pages of a source (the opened file or an inserted one). */
  getSourceHandle(key: string, sourceId: SourceId): PdfDocumentHandle | null;
  /** The original bytes of a ready document (for "Save a copy"). */
  getBytes(key: string): Uint8Array | null;
  /** An object URL showing an image asset of the document. */
  getAssetUrl(key: string, assetId: AssetId): string | null;
  /** The bytes of one of a document's source files (crash recovery). */
  getSourceBytes(key: string, sourceId: SourceId): Uint8Array | null;
  /** The bytes of an image asset (crash recovery). */
  getAssetBytes(key: string, assetId: AssetId): Uint8Array | null;
  /** The engine, to open bytes the workspace produced (printing). */
  readonly engine: PdfEngine;
  destroy(): Promise<void>;
}

/** Page sizes stream in for large documents; batching keeps re-layouts rare. */
const PAGE_INFO_FLUSH_MS = 120;
/** Searched text kept per document; beyond this, later searches extract again. */
const SEARCH_TEXT_BUDGET = 20_000_000;

/**
 * Drops are often accidental and mixed (images, documents). Skip files whose
 * extension says they are something else; extensionless files are tried and
 * rejected by content sniffing if they are not PDFs.
 */
export function isLikelyPdfName(name: string): boolean {
  return /\.pdf$/i.test(name) || !/\.[a-z0-9]{1,8}$/i.test(name);
}

/** "report.pdf" → "report". */
export const baseName = (fileName: string) => fileName.replace(/\.pdf$/i, '') || 'document';

/** Recovery record ids (letters, digits, '-' and '_' only). */
const newRecoveryId = () => `doc-${newDocumentId().slice(4)}`;

let tabCounter = 0;
const nextKey = () => `tab-${Date.now().toString(36)}-${(tabCounter += 1)}`;

/** Same pages, in the same order, from the same sources: search results stay valid. */
function samePageSequence(a: DocumentModel['pages'], b: DocumentModel['pages']): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((page, index) => page.id === b[index]?.id);
}

const textKey = (sourceId: SourceId, pageIndex: number) => `${sourceId}:${pageIndex}`;

function newDocument(key: string, file: IncomingFile): WorkspaceDocument {
  return {
    key,
    fileName: file.name,
    byteLength: file.size,
    status: 'loading',
    error: null,
    passwordRejected: false,
    editor: null,
    view: null,
    info: null,
    permissions: ALL_PERMISSIONS,
    pagesComplete: false,
    navigation: null,
    search: IDLE_SEARCH,
    selection: EMPTY_SELECTION,
    busy: null,
    saveTarget:
      file.origin.kind === 'local-file' && file.origin.handle
        ? { handle: file.origin.handle, name: file.name }
        : null,
    diskSha256: null,
    recoveryId: newRecoveryId(),
  };
}

export function createWorkspaceStore(engine: PdfEngine): WorkspaceStore {
  const resources = new Map<string, Resources>();
  let noticeId = 0;

  const store = createStore<WorkspaceState>()((set, get) => {
    const find = (key: string) => get().documents.find((doc) => doc.key === key);

    const patch = (key: string, changes: Partial<WorkspaceDocument>) =>
      set((state) => ({
        documents: state.documents.map((doc) => (doc.key === key ? { ...doc, ...changes } : doc)),
      }));

    const update = (
      key: string,
      change: (doc: WorkspaceDocument) => Partial<WorkspaceDocument> | null,
    ) =>
      set((state) => {
        let touched = false;
        const documents = state.documents.map((doc) => {
          if (doc.key !== key) return doc;
          const changes = change(doc);
          if (!changes) return doc;
          touched = true;
          return { ...doc, ...changes };
        });
        return touched ? { documents } : state;
      });

    const viewOf = (key: string) => find(key)?.view ?? null;

    const updateView = (
      key: string,
      change: (view: DocumentViewState) => DocumentViewState | null,
    ) =>
      update(key, (doc) => {
        if (!doc.view) return null;
        const view = change(doc.view);
        return view && view !== doc.view ? { view } : null;
      });

    const updateSearch = (
      key: string,
      change: (search: SearchState, doc: WorkspaceDocument) => Partial<SearchState> | null,
    ) =>
      update(key, (doc) => {
        const changes = change(doc.search, doc);
        return changes ? { search: { ...doc.search, ...changes } } : null;
      });

    const notify = (message: string) => get().showNotice(message);

    function flushPageInfo(key: string) {
      const entry = resources.get(key);
      if (!entry) return;
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
      const batches = [...entry.pendingPageInfo];
      entry.pendingPageInfo.clear();
      if (batches.length === 0) return;
      update(key, (doc) => {
        if (!doc.editor) return null;
        let editor = doc.editor;
        for (const [sourceId, updates] of batches)
          editor = applyPageInfo(editor, sourceId, updates);
        return { editor };
      });
    }

    /** Keeps an engine handle for a source and feeds its late page sizes into the model. */
    function addSource(
      key: string,
      sourceId: SourceId,
      source: Omit<SourceEntry, 'unsubscribe'>,
    ): void {
      const entry = resources.get(key);
      if (!entry) return;
      const unsubscribe = source.handle.onPageInfo((updates) => {
        const pending = entry.pendingPageInfo.get(sourceId);
        if (pending) pending.push(...updates);
        else entry.pendingPageInfo.set(sourceId, [...updates]);
        entry.flushTimer ??= setTimeout(() => flushPageInfo(key), PAGE_INFO_FLUSH_MS);
      });
      entry.sources.set(sourceId, { ...source, unsubscribe });
    }

    let navigationSeq = 0;
    const navigateTo = (key: string, target: NavigationTarget) =>
      update(key, (doc) => {
        const page = doc.editor?.model.pages[target.pageIndex];
        if (!page || !doc.view) return null;
        navigationSeq += 1;
        return {
          navigation: { seq: navigationSeq, target },
          view: { ...doc.view, currentPageId: page.id, pageOffset: 0 },
        };
      });

    const navigateToMatch = (key: string, index: number) => {
      const match = find(key)?.search.matches[index];
      if (!match) return;
      navigateTo(key, { pageIndex: match.pageIndex, match, align: 'center' });
    };

    function runSearch(key: string) {
      const entry = resources.get(key);
      const doc = find(key);
      if (!entry || !doc) return;
      entry.search?.abort();
      entry.search = null;
      const { query, options } = doc.search;
      const pages = doc.editor?.model.pages;
      if (!pages || query.trim().length === 0) {
        updateSearch(key, () => ({
          status: 'idle',
          matches: [],
          active: -1,
          pagesSearched: 0,
          truncated: false,
        }));
        return;
      }
      const controller = new AbortController();
      entry.search = controller;
      updateSearch(key, () => ({
        status: 'searching',
        matches: [],
        active: -1,
        pagesSearched: 0,
        truncated: false,
      }));
      const source = {
        pageCount: pages.length,
        async getPageText(position: number) {
          const page = pages[position];
          if (!page || page.source.kind !== 'source') return { items: [] };
          const { sourceId, pageIndex } = page.source;
          const id = textKey(sourceId, pageIndex);
          const cached = entry.searchText.get(id);
          if (cached) return { items: cached };
          const handle = entry.sources.get(sourceId)?.handle;
          if (!handle) return { items: [] };
          const text = await handle.getPageText(pageIndex);
          const items = text.items.map(({ str, hasEOL }) => ({ str, hasEOL }));
          const chars = items.reduce((total, item) => total + item.str.length, 0);
          if (entry.searchTextChars + chars <= SEARCH_TEXT_BUDGET) {
            entry.searchText.set(id, items);
            entry.searchTextChars += chars;
          }
          return { items };
        },
      };
      void searchDocument(
        source,
        query,
        options,
        (progress) => {
          if (controller.signal.aborted) return;
          let jumpTo = -1;
          updateSearch(key, (search, current) => {
            let active = search.active;
            if (active === -1 && progress.matches.length > 0) {
              // Start from the current page; wait until the search reaches it.
              const currentIndex = Math.max(
                0,
                current.editor?.model.pages.findIndex(
                  (page) => page.id === current.view?.currentPageId,
                ) ?? 0,
              );
              const from = progress.matches.findIndex((match) => match.pageIndex >= currentIndex);
              if (from !== -1) active = from;
              else if (progress.done) active = 0;
              if (active !== -1) jumpTo = active;
            }
            return {
              status: progress.done ? 'done' : 'searching',
              matches: progress.matches,
              pagesSearched: progress.pagesSearched,
              truncated: progress.truncated,
              active,
            };
          });
          if (jumpTo !== -1) navigateToMatch(key, jumpTo);
        },
        controller.signal,
      ).catch(() => {
        if (!controller.signal.aborted) updateSearch(key, () => ({ status: 'done' }));
      });
    }

    const fail = (key: string, error: unknown) => {
      const pdfError = isPdfError(error) ? error : new PdfError('unknown');
      patch(key, { status: 'error', error: { code: pdfError.code, message: pdfError.message } });
    };

    async function load(key: string, password?: string) {
      const entry = resources.get(key);
      if (!entry) return;
      try {
        entry.bytes ??= await entry.file.read();
        const bytes = entry.bytes;
        const handle = await engine.open(bytes, password === undefined ? {} : { password });
        if (!resources.has(key)) {
          // The tab was closed while the document was loading.
          await handle.destroy();
          return;
        }
        entry.handle = handle;
        const model = createDocumentModel(
          toSourceDescriptor(handle.info, {
            fileName: entry.file.name,
            byteLength: bytes.byteLength,
            sha256: await sha256Hex(bytes),
            origin: entry.file.origin,
          }),
        );
        const sourceId = Object.keys(model.sources)[0] as SourceId;
        addSource(key, sourceId, {
          bytes,
          handle,
          password: handle.info.encryption === 'none' ? undefined : (password ?? ''),
        });
        patch(key, {
          status: 'ready',
          error: null,
          passwordRejected: false,
          diskSha256: model.sources[sourceId]?.sha256 ?? null,
          info: handle.info,
          permissions: editPermissions(handle.info),
          editor: createEditorState(model),
          view: createViewState(model),
          pagesComplete: handle.pagesComplete,
        });
        void handle.pagesReady.then(() => {
          if (!resources.has(key)) return;
          flushPageInfo(key);
          patch(key, { pagesComplete: true });
        });
      } catch (error) {
        if (!resources.has(key)) return;
        if (isPdfError(error, 'password-required') || isPdfError(error, 'incorrect-password')) {
          patch(key, {
            status: 'needs-password',
            passwordRejected: isPdfError(error, 'incorrect-password'),
          });
          return;
        }
        // Bytes are no longer needed once a document has failed for good.
        entry.bytes = null;
        fail(key, error);
      }
    }

    async function openAll(files: Array<{ file: IncomingFile; password?: string }>) {
      const added = files.map(({ file, password }) => {
        const key = nextKey();
        resources.set(key, {
          releaseSaveTarget: null,
          file,
          initialPassword: password,
          bytes: null,
          handle: null,
          sources: new Map(),
          assets: new Map(),
          assetUrls: new Map(),
          pendingPageInfo: new Map(),
          flushTimer: null,
          search: null,
          searchText: new Map(),
          searchTextChars: 0,
        });
        return newDocument(key, file);
      });
      set((state) => ({
        documents: [...state.documents, ...added],
        activeKey: added[0]?.key ?? state.activeKey,
      }));
      await Promise.all(added.map((doc) => load(doc.key, resources.get(doc.key)?.initialPassword)));
    }

    /**
     * Opens every source of a recovered document from the stored bytes and
     * shows it again with its history. Protected sources need their password
     * again: passwords are never stored.
     */
    async function restore(request: RestoreRequest): Promise<RestoreOutcome> {
      let snapshot;
      try {
        snapshot = parseRecoverySnapshot(request.snapshot);
      } catch {
        return { status: 'failed', message: 'The recovered data is damaged.' };
      }
      const { editor, view } = snapshot;
      const { model } = editor;
      const sources = Object.values(model.sources);
      const primary = sources[0];
      if (!primary) return { status: 'failed', message: 'The recovered data is damaged.' };
      const opened: Array<{ id: SourceId; entry: Omit<SourceEntry, 'unsubscribe'> }> = [];
      const destroyAll = () => Promise.all(opened.map(({ entry }) => entry.handle.destroy()));
      for (const source of sources) {
        const bytes = request.files.get(source.sha256);
        if (!bytes || (await sha256Hex(bytes)) !== source.sha256) {
          await destroyAll();
          return {
            status: 'failed',
            message: `The copy of ${source.fileName} kept for recovery is missing or damaged.`,
          };
        }
        const password = request.passwords?.[source.id];
        try {
          const handle = await engine.open(bytes, password === undefined ? {} : { password });
          opened.push({
            id: source.id,
            entry: {
              bytes,
              handle,
              password: handle.info.encryption === 'none' ? undefined : (password ?? ''),
            },
          });
        } catch (error) {
          await destroyAll();
          if (isPdfError(error, 'password-required') || isPdfError(error, 'incorrect-password')) {
            return {
              status: 'needs-password',
              sourceId: source.id,
              fileName: source.fileName,
              rejected: isPdfError(error, 'incorrect-password'),
            };
          }
          return { status: 'failed', message: `${source.fileName} could not be opened.` };
        }
      }
      const key = nextKey();
      const primaryBytes = opened[0]!.entry.bytes;
      const file: IncomingFile = {
        name: primary.fileName,
        size: primaryBytes.byteLength,
        origin: { kind: 'generated' },
        read: async () => primaryBytes,
      };
      const entry: Resources = {
        releaseSaveTarget: null,
        file,
        initialPassword: undefined,
        bytes: primaryBytes,
        handle: opened[0]!.entry.handle,
        sources: new Map(),
        assets: new Map(),
        assetUrls: new Map(),
        pendingPageInfo: new Map(),
        flushTimer: null,
        search: null,
        searchText: new Map(),
        searchTextChars: 0,
      };
      for (const id of Object.keys(model.assets) as AssetId[]) {
        const bytes = request.files.get(id);
        if (bytes) entry.assets.set(id, bytes);
      }
      resources.set(key, entry);
      for (const { id, entry: source } of opened) addSource(key, id, source);
      const info = opened[0]!.entry.handle.info;
      const doc: WorkspaceDocument = {
        ...newDocument(key, file),
        status: 'ready',
        info,
        permissions: editPermissions(info),
        editor,
        view,
        pagesComplete: opened.every(({ entry: source }) => source.handle.pagesComplete),
        recoveryId: request.recoveryId,
      };
      set((state) => ({ documents: [...state.documents, doc], activeKey: key }));
      void Promise.all(opened.map(({ entry: source }) => source.handle.pagesReady)).then(() => {
        if (!resources.has(key)) return;
        flushPageInfo(key);
        patch(key, { pagesComplete: true });
      });
      return { status: 'restored', key };
    }

    // ── Editing ──────────────────────────────────────────────────────────

    /** Keeps the view and selection pointing at things that still exist. */
    function reconcile(doc: WorkspaceDocument, model: DocumentModel): Partial<WorkspaceDocument> {
      const changes: Partial<WorkspaceDocument> = {};
      const pageIds = new Set(model.pages.map((page) => page.id));
      if (doc.view && doc.view.currentPageId && !pageIds.has(doc.view.currentPageId)) {
        const previous = doc.editor?.model.pages.findIndex(
          (page) => page.id === doc.view?.currentPageId,
        );
        const nearest = model.pages[Math.min(Math.max(0, previous ?? 0), model.pages.length - 1)];
        changes.view = { ...doc.view, currentPageId: nearest?.id ?? null, pageOffset: 0 };
      }
      const pages = doc.selection.pages.filter((id) => pageIds.has(id));
      const annotations = doc.selection.annotations.filter((id) => id in model.annotations);
      if (
        pages.length !== doc.selection.pages.length ||
        annotations.length !== doc.selection.annotations.length
      ) {
        changes.selection = {
          pages,
          anchor:
            doc.selection.anchor && pageIds.has(doc.selection.anchor) ? doc.selection.anchor : null,
          annotations,
        };
      }
      return changes;
    }

    /** Runs a change of the editor state; reports operations that do not fit the document. */
    function commit(
      key: string,
      change: (editor: EditorDocumentState) => EditorDocumentState,
    ): boolean {
      let applied = false;
      let pagesChanged = false;
      let failure: OperationError | null = null;
      update(key, (doc) => {
        if (!doc.editor) return null;
        let editor: EditorDocumentState;
        try {
          editor = change(doc.editor);
        } catch (error) {
          if (error instanceof OperationError) {
            failure = error;
            return null;
          }
          throw error;
        }
        if (editor === doc.editor) return null;
        applied = true;
        pagesChanged = !samePageSequence(doc.editor.model.pages, editor.model.pages);
        return { editor, ...reconcile(doc, editor.model) };
      });
      if (failure) {
        notify(
          (failure as OperationError).code === 'empty-document'
            ? 'A document needs at least one page.'
            : 'That change does not fit the document any more.',
        );
      }
      if (pagesChanged) {
        const doc = find(key);
        if (doc?.search.open && doc.search.query.trim()) runSearch(key);
      }
      return applied;
    }

    /** Checks a permission, telling the user when it is missing. */
    function allowed(key: string, permission: keyof EditPermissions): boolean {
      const doc = find(key);
      if (!doc || doc.status !== 'ready') return false;
      if (doc.permissions[permission]) return true;
      notify(PERMISSION_MESSAGES[permission]);
      return false;
    }

    function apply(
      key: string,
      operation: Operation,
      options: { label: string; coalesceKey?: string },
    ): boolean {
      return commit(key, (editor) => execute(editor, operation, options));
    }

    async function exportDocument(key: string, request: ExportRequest = {}) {
      const doc = find(key);
      const entry = resources.get(key);
      if (!doc?.editor || !doc.info || !entry) throw new Error('The document is not open.');
      const { exportPdf } = await import('@folio/pdf-core/export');
      const sources = new Map(
        [...entry.sources].map(([id, source]) => [
          id,
          source.password === undefined
            ? { bytes: source.bytes }
            : { bytes: source.bytes, password: source.password },
        ]),
      );
      const primary = [...entry.sources.values()][0];
      const model = doc.editor.model;
      return exportPdf({
        model: request.withoutAnnotations
          ? { ...model, annotations: {} as typeof model.annotations }
          : model,
        sources,
        assets: entry.assets,
        ...(request.pageIds ? { pageIds: request.pageIds } : {}),
        ...(request.flatten === undefined ? {} : { flatten: request.flatten }),
        // Saved copies stay as protected as the opened file.
        protection:
          doc.info.encryption === 'none' || request.unprotected
            ? null
            : { userPassword: primary?.password ?? '', permissions: doc.info.permissions },
      });
    }

    return {
      documents: [],
      activeKey: null,
      notice: null,

      async openFiles(files) {
        const pdfs = files.filter((file) => isLikelyPdfName(file.name));
        const skipped = files.length - pdfs.length;
        if (skipped > 0) {
          notify(
            skipped === 1
              ? 'Skipped 1 file that is not a PDF.'
              : `Skipped ${skipped} files that are not PDFs.`,
          );
        }
        for (const file of files) if (!pdfs.includes(file)) file.release?.();
        if (pdfs.length === 0) return;
        await openAll(pdfs.map((file) => ({ file })));
      },

      async submitPassword(key, password) {
        const doc = find(key);
        if (!doc || doc.status !== 'needs-password') return;
        patch(key, { status: 'loading' });
        await load(key, password);
      },

      async close(key) {
        const { documents, activeKey } = get();
        const index = documents.findIndex((doc) => doc.key === key);
        if (index === -1) return;
        const remaining = documents.filter((doc) => doc.key !== key);
        const neighbour = remaining[Math.min(index, remaining.length - 1)] ?? null;
        set({
          documents: remaining,
          activeKey: activeKey === key ? (neighbour?.key ?? null) : activeKey,
        });
        const entry = resources.get(key);
        resources.delete(key);
        if (!entry) return;
        await releaseResources(entry);
      },

      activate(key) {
        if (get().documents.some((doc) => doc.key === key)) set({ activeKey: key });
      },

      activateRelative(delta) {
        const { documents, activeKey } = get();
        if (documents.length < 2) return;
        const index = documents.findIndex((doc) => doc.key === activeKey);
        const next = documents[(index + delta + documents.length) % documents.length];
        if (next) set({ activeKey: next.key });
      },

      setCurrentPage(key, pageId) {
        const pageIndex =
          find(key)?.editor?.model.pages.findIndex((page) => page.id === pageId) ?? -1;
        if (pageIndex === -1) return;
        navigateTo(key, { pageIndex, align: 'top' });
      },

      updatePosition(key, pageId, pageOffset) {
        const offset = Math.min(1, Math.max(-1, pageOffset));
        updateView(key, (view) =>
          view.currentPageId === pageId && Math.abs(view.pageOffset - offset) < 0.001
            ? null
            : { ...view, currentPageId: pageId, pageOffset: offset },
        );
      },

      setZoom(key, mode, zoom) {
        updateView(key, (view) => ({
          ...view,
          zoomMode: mode,
          zoom: zoom === undefined ? view.zoom : clampZoom(zoom),
        }));
      },

      zoomBy(key, direction) {
        const view = viewOf(key);
        if (view) get().setZoom(key, 'custom', stepZoom(view.zoom, direction));
      },

      syncFitZoom(key, zoom) {
        updateView(key, (view) =>
          view.zoomMode === 'custom' || Math.abs(view.zoom - zoom) < 0.0005
            ? null
            : { ...view, zoom },
        );
      },

      rotateView(key, delta) {
        updateView(key, (view) => ({ ...view, rotation: addRotation(view.rotation, delta) }));
      },

      navigate(key, target) {
        navigateTo(key, target);
      },

      clearNavigation(key, seq) {
        update(key, (doc) => (doc.navigation?.seq === seq ? { navigation: null } : null));
      },

      openSearch(key) {
        updateSearch(key, (search) => (search.open ? null : { open: true }));
      },

      closeSearch(key) {
        resources.get(key)?.search?.abort();
        // Options are a preference; the query and results go.
        updateSearch(key, (search) => ({ ...IDLE_SEARCH, options: search.options }));
      },

      setSearch(key, changes) {
        const current = find(key)?.search;
        if (!current) return;
        const query = changes.query ?? current.query;
        const options = { ...current.options, ...changes.options };
        const unchanged =
          query === current.query &&
          options.matchCase === current.options.matchCase &&
          options.wholeWords === current.options.wholeWords;
        // Running the same search again would lose the user's place in the results.
        if (unchanged && current.open && current.status !== 'idle') return;
        updateSearch(key, () => ({ open: true, query, options }));
        runSearch(key);
      },

      stepSearch(key, direction) {
        const doc = find(key);
        const count = doc?.search.matches.length ?? 0;
        if (!doc || count === 0) return;
        const next =
          doc.search.active === -1
            ? direction === 1
              ? 0
              : count - 1
            : (doc.search.active + direction + count) % count;
        get().selectMatch(key, next);
      },

      selectMatch(key, index) {
        updateSearch(key, (search) =>
          index >= 0 && index < search.matches.length ? { active: index } : null,
        );
        navigateToMatch(key, index);
      },

      showNotice(message) {
        noticeId += 1;
        set({ notice: { id: noticeId, message } });
      },

      dismissNotice() {
        set({ notice: null });
      },

      // ── Editing ──

      apply,

      undo(key) {
        commit(key, undoHistory);
      },

      redo(key) {
        commit(key, redoHistory);
      },

      selectPages(key, pageIds, anchor) {
        update(key, (doc) => {
          if (!doc.editor) return null;
          const pages = inDocumentOrder(doc.editor.model, pageIds);
          return {
            selection: {
              ...doc.selection,
              pages,
              anchor: anchor === undefined ? doc.selection.anchor : anchor,
            },
          };
        });
      },

      selectAnnotations(key, ids) {
        update(key, (doc) => {
          if (!doc.editor) return null;
          const annotations = ids.filter((id) => id in doc.editor!.model.annotations);
          const same =
            annotations.length === doc.selection.annotations.length &&
            annotations.every((id, index) => doc.selection.annotations[index] === id);
          return same ? null : { selection: { ...doc.selection, annotations } };
        });
      },

      rotatePages(key, pageIds, delta) {
        if (pageIds.length === 0 || !allowed(key, 'assemble')) return;
        apply(
          key,
          { type: 'pages/rotate', pageIds, delta: delta === 90 ? 90 : 270 },
          { label: `Rotate ${pagesLabel(pageIds.length)}` },
        );
      },

      deletePages(key, pageIds) {
        if (pageIds.length === 0 || !allowed(key, 'assemble')) return;
        apply(
          key,
          { type: 'pages/remove', pageIds },
          { label: `Delete ${pagesLabel(pageIds.length)}` },
        );
      },

      duplicatePages(key, pageIds) {
        const doc = find(key);
        if (!doc?.editor || pageIds.length === 0 || !allowed(key, 'assemble')) return;
        const operation = duplicatePagesOperation(
          doc.editor.model,
          pageIds,
          new Date().toISOString(),
        );
        if (apply(key, operation, { label: `Duplicate ${pagesLabel(pageIds.length)}` })) {
          if (operation.type === 'pages/insert') {
            get().selectPages(
              key,
              operation.entries.map((entry) => entry.page.id),
              operation.entries[0]?.page.id ?? null,
            );
          }
        }
      },

      movePages(key, pageIds, toIndex) {
        const doc = find(key);
        if (!doc?.editor || pageIds.length === 0 || !allowed(key, 'assemble')) return;
        let operation: Operation;
        try {
          operation = movePagesOperation(doc.editor.model, pageIds, toIndex);
        } catch {
          return;
        }
        if (operation.type !== 'pages/reorder') return;
        const unchanged = operation.order.every(
          (id, index) => doc.editor!.model.pages[index]?.id === id,
        );
        if (unchanged) return;
        apply(key, operation, { label: `Move ${pagesLabel(pageIds.length)}` });
      },

      insertBlankPage(key, index) {
        const doc = find(key);
        if (!doc?.editor || !allowed(key, 'assemble')) return;
        const pages = doc.editor.model.pages;
        const at = Math.min(Math.max(0, index), pages.length);
        const page = blankPageLike(pages[Math.max(0, at - 1)]);
        if (
          apply(
            key,
            { type: 'pages/insert', entries: [{ index: at, page }], annotations: [], sources: [] },
            { label: 'Insert a blank page' },
          )
        ) {
          get().selectPages(key, [page.id], page.id);
          navigateTo(key, { pageIndex: at, align: 'top' });
        }
      },

      async insertPagesFromFile(key, file, index, password) {
        if (!allowed(key, 'assemble')) {
          return { status: 'failed', message: PERMISSION_MESSAGES.assemble };
        }
        const entry = resources.get(key);
        if (!entry) return { status: 'failed', message: 'The document is closed.' };
        patch(key, { busy: `Reading ${file.name}…` });
        let handle: PdfDocumentHandle | null = null;
        try {
          const bytes = await file.read();
          const sha256 = await sha256Hex(bytes);
          const doc = find(key);
          const model = doc?.editor?.model;
          if (!model || !resources.has(key))
            return { status: 'failed', message: 'The document is closed.' };
          // The same file inserted again shares its source (and engine handle).
          const known = Object.values(model.sources).find(
            (source) => source.sha256 === sha256 && entry.sources.has(source.id),
          );
          let sourceRecord = known ?? null;
          let sourceHandle = known ? entry.sources.get(known.id)!.handle : null;
          if (!sourceHandle) {
            handle = await engine.open(bytes, password === undefined ? {} : { password });
            sourceHandle = handle;
          }
          const info = sourceHandle.info;
          const descriptor = toSourceDescriptor(info, {
            fileName: file.name,
            byteLength: bytes.byteLength,
            sha256,
            origin: file.origin,
          });
          const created = createSourceDocument(descriptor, sourceRecord?.id);
          sourceRecord ??= created.source;
          const at = Math.min(Math.max(0, index), model.pages.length);
          const applied = apply(
            key,
            {
              type: 'pages/insert',
              entries: created.pages.map((page, offset) => ({ index: at + offset, page })),
              annotations: [],
              sources: known ? [] : [created.source],
            },
            { label: `Insert ${pagesLabel(created.pages.length)} from ${file.name}` },
          );
          if (!applied) return { status: 'failed', message: 'The pages could not be inserted.' };
          if (handle) {
            addSource(key, sourceRecord.id, {
              bytes,
              handle,
              password: info.encryption === 'none' ? undefined : (password ?? ''),
            });
            handle = null;
          }
          get().selectPages(
            key,
            created.pages.map((page) => page.id),
            created.pages[0]?.id ?? null,
          );
          navigateTo(key, { pageIndex: at, align: 'top' });
          if (info.encryption !== 'none' && find(key)?.info?.encryption === 'none') {
            notify(
              `The pages from ${file.name} will be saved without its password protection, like the rest of this document.`,
            );
          }
          return { status: 'inserted', count: created.pages.length };
        } catch (error) {
          if (isPdfError(error, 'password-required') || isPdfError(error, 'incorrect-password')) {
            return { status: 'needs-password', rejected: isPdfError(error, 'incorrect-password') };
          }
          const message = isPdfError(error) ? error.message : 'The file could not be read.';
          return { status: 'failed', message };
        } finally {
          await handle?.destroy();
          file.release?.();
          if (resources.has(key)) patch(key, { busy: null });
        }
      },

      addAnnotations(key, annotations, options) {
        if (annotations.length === 0 || !allowed(key, 'annotate')) return false;
        const applied = apply(
          key,
          {
            type: 'annotations/add',
            annotations,
            ...(options.assets?.length ? { assets: options.assets } : {}),
          },
          { label: options.label },
        );
        if (applied)
          get().selectAnnotations(
            key,
            annotations.map((annotation) => annotation.id),
          );
        return applied;
      },

      updateAnnotations(key, annotations, options) {
        if (annotations.length === 0 || !allowed(key, 'annotate')) return false;
        const now = new Date().toISOString();
        return apply(
          key,
          {
            type: 'annotations/replace',
            annotations: annotations.map((annotation) => ({ ...annotation, modifiedAt: now })),
          },
          options,
        );
      },

      deleteAnnotations(key, ids) {
        if (ids.length === 0 || !allowed(key, 'annotate')) return;
        apply(
          key,
          { type: 'annotations/remove', ids },
          { label: ids.length === 1 ? 'Delete comment' : `Delete ${ids.length} comments` },
        );
      },

      updateMetadata(key, patchValues) {
        if (Object.keys(patchValues).length === 0 || !allowed(key, 'modify')) return;
        apply(
          key,
          { type: 'metadata/update', patch: patchValues },
          { label: 'Edit document properties', coalesceKey: 'metadata' },
        );
      },

      setStamps(key, stamps, label) {
        if (!allowed(key, 'modify')) return false;
        return apply(key, { type: 'stamps/set', stamps }, { label });
      },

      async registerImage(key, bytes, mimeType) {
        const entry = resources.get(key);
        const model = find(key)?.editor?.model;
        if (!entry || !model) return null;
        const sha256 = await sha256Hex(bytes);
        for (const [id, existing] of entry.assets) {
          const ref = model.assets[id];
          if (ref?.sha256 === sha256 && existing.byteLength === bytes.byteLength) return ref;
        }
        const ref: AssetRef = { id: newAssetId(), mimeType, byteLength: bytes.byteLength, sha256 };
        entry.assets.set(ref.id, bytes);
        return ref;
      },

      async exportDocument(key, request) {
        patch(key, { busy: 'Saving…' });
        try {
          return await exportDocument(key, request);
        } finally {
          if (resources.has(key)) patch(key, { busy: null });
        }
      },

      markSaved(key) {
        update(key, (doc) => (doc.editor ? { editor: markEditorSaved(doc.editor) } : null));
      },

      setSaveTarget(key, target, sha256, release) {
        const entry = resources.get(key);
        if (!entry) {
          release?.();
          return;
        }
        // Save no longer writes to the file of an earlier Save As.
        entry.releaseSaveTarget?.();
        entry.releaseSaveTarget = release ?? null;
        update(key, () => ({
          saveTarget: target,
          diskSha256: sha256,
          ...(target ? { fileName: target.name } : {}),
        }));
      },

      async restoreDocument(request) {
        return restore(request);
      },

      async splitDocument(key, parts) {
        const doc = find(key);
        const entry = resources.get(key);
        if (!doc || !entry || parts.length === 0 || !allowed(key, 'extract')) return 0;
        const password = [...entry.sources.values()][0]?.password;
        const files: Array<{ file: IncomingFile; password?: string }> = [];
        patch(key, { busy: 'Splitting…' });
        try {
          for (const [index, pageIds] of parts.entries()) {
            const { bytes } = await exportDocument(key, { pageIds });
            const name = `${baseName(doc.fileName)} (part ${index + 1}).pdf`;
            files.push({
              file: {
                name,
                size: bytes.byteLength,
                origin: { kind: 'generated' },
                read: async () => bytes,
              },
              // Parts of a protected document stay protected; Folio knows the password.
              ...(password ? { password } : {}),
            });
          }
        } finally {
          if (resources.has(key)) patch(key, { busy: null });
        }
        await openAll(files);
        return files.length;
      },
    };
  });

  async function releaseResources(entry: Resources) {
    entry.releaseSaveTarget?.();
    entry.releaseSaveTarget = null;
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.search?.abort();
    entry.file.release?.();
    for (const url of entry.assetUrls.values()) URL.revokeObjectURL(url);
    entry.assetUrls.clear();
    const handles = new Set<PdfDocumentHandle>();
    if (entry.handle) handles.add(entry.handle);
    for (const source of entry.sources.values()) {
      source.unsubscribe();
      handles.add(source.handle);
    }
    await Promise.all([...handles].map((handle) => handle.destroy()));
  }

  return {
    ...store,
    getHandle: (key) => resources.get(key)?.handle ?? null,
    getSourceHandle: (key, sourceId) => resources.get(key)?.sources.get(sourceId)?.handle ?? null,
    getSourceBytes: (key, sourceId) => resources.get(key)?.sources.get(sourceId)?.bytes ?? null,
    getAssetBytes: (key, assetId) => resources.get(key)?.assets.get(assetId) ?? null,
    engine,
    getBytes: (key) => {
      const entry = resources.get(key);
      return entry?.handle ? entry.bytes : null;
    },
    getAssetUrl: (key, assetId) => {
      const entry = resources.get(key);
      if (!entry) return null;
      const known = entry.assetUrls.get(assetId);
      if (known) return known;
      const bytes = entry.assets.get(assetId);
      const ref = store.getState().documents.find((doc) => doc.key === key)?.editor?.model.assets[
        assetId
      ];
      if (!bytes || !ref) return null;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: ref.mimeType }));
      entry.assetUrls.set(assetId, url);
      return url;
    },
    async destroy() {
      const entries = [...resources.values()];
      resources.clear();
      store.setState({ documents: [], activeKey: null });
      await Promise.all(entries.map((entry) => releaseResources(entry)));
    },
  };
}
