import {
  addRotation,
  createDocumentModel,
  createEditorState,
  createViewState,
  type DocumentModel,
  type DocumentViewState,
  type EditorDocumentState,
  type PageId,
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
import type { IncomingFile } from '@folio/platform-adapters';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions, type TextMatch } from '../search/match';
import { searchDocument, type SearchableRun } from '../search/run';
import { clampZoom, stepZoom } from '../viewer/zoom';

export type DocumentStatus = 'loading' | 'needs-password' | 'ready' | 'error';

/** Where the viewer should scroll: a page, optionally a point on it (PDF user space). */
export interface NavigationTarget {
  /** Position of the page in the document. */
  pageIndex: number;
  point?: { x: number | null; y: number | null };
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
  info: PdfDocumentInfo | null;
  /** False while the sizes of a large document's later pages are still being read. */
  pagesComplete: boolean;
  /** A pending scroll request for the viewer; it clears it once handled. */
  navigation: { seq: number; target: NavigationTarget } | null;
  search: SearchState;
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
}

interface Resources {
  file: IncomingFile;
  bytes: Uint8Array | null;
  handle: PdfDocumentHandle | null;
  /** Page sizes read after opening, applied to the model in batches. */
  pendingPageInfo: PageInfoUpdate[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  search: AbortController | null;
  /** Text runs of pages already searched, so repeated searches skip extraction. */
  searchText: Map<number, SearchableRun[]>;
  searchTextChars: number;
}

export interface WorkspaceStore extends StoreApi<WorkspaceState> {
  /** The engine handle for a ready document, for rendering. */
  getHandle(key: string): PdfDocumentHandle | null;
  /** The original bytes of a ready document (for "Save a copy"). */
  getBytes(key: string): Uint8Array | null;
  destroy(): Promise<void>;
}

/** Page sizes stream in for large documents; batching keeps re-layouts rare. */
const PAGE_INFO_FLUSH_MS = 120;
/** Searched text kept per document; beyond this, later searches extract again. */
const SEARCH_TEXT_BUDGET = 20_000_000;

/** Applies exact page sizes to pages from the document's primary source. */
export function applyPageInfo(
  model: DocumentModel,
  updates: readonly PageInfoUpdate[],
): DocumentModel {
  if (updates.length === 0) return model;
  const bySourceIndex = new Map(updates.map((update) => [update.index, update.info]));
  const sourceId = model.pages.find((page) => page.source.kind === 'source')?.source;
  if (!sourceId || sourceId.kind !== 'source') return model;
  let changed = false;
  const pages = model.pages.map((page) => {
    if (page.source.kind !== 'source' || page.source.sourceId !== sourceId.sourceId) return page;
    const info = bySourceIndex.get(page.source.pageIndex);
    if (!info) return page;
    changed = true;
    return {
      ...page,
      size: { width: info.size.width, height: info.size.height },
      sourceRotation: info.rotation,
      userUnit: info.userUnit,
    };
  });
  return changed ? { ...model, pages } : model;
}

/**
 * Drops are often accidental and mixed (images, documents). Skip files whose
 * extension says they are something else; extensionless files are tried and
 * rejected by content sniffing if they are not PDFs.
 */
export function isLikelyPdfName(name: string): boolean {
  return /\.pdf$/i.test(name) || !/\.[a-z0-9]{1,8}$/i.test(name);
}

let tabCounter = 0;
const nextKey = () => `tab-${Date.now().toString(36)}-${(tabCounter += 1)}`;

export function createWorkspaceStore(engine: PdfEngine): WorkspaceStore {
  const resources = new Map<string, Resources>();
  let noticeId = 0;

  const store = createStore<WorkspaceState>()((set, get) => {
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

    const viewOf = (key: string) => get().documents.find((doc) => doc.key === key)?.view ?? null;

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

    function flushPageInfo(key: string) {
      const entry = resources.get(key);
      if (!entry) return;
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
      const updates = entry.pendingPageInfo.splice(0);
      if (updates.length === 0) return;
      update(key, (doc) =>
        doc.editor
          ? { editor: { ...doc.editor, model: applyPageInfo(doc.editor.model, updates) } }
          : null,
      );
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
      const doc = get().documents.find((entry) => entry.key === key);
      const match = doc?.search.matches[index];
      if (!match) return;
      navigateTo(key, { pageIndex: match.pageIndex, match, align: 'center' });
    };

    function runSearch(key: string) {
      const entry = resources.get(key);
      const doc = get().documents.find((item) => item.key === key);
      if (!entry || !doc) return;
      entry.search?.abort();
      entry.search = null;
      const { query, options } = doc.search;
      const handle = entry.handle;
      if (!handle || query.trim().length === 0) {
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
        pageCount: handle.info.pageCount,
        async getPageText(pageIndex: number) {
          const cached = entry.searchText.get(pageIndex);
          if (cached) return { items: cached };
          const text = await handle.getPageText(pageIndex);
          const items = text.items.map(({ str, hasEOL }) => ({ str, hasEOL }));
          const chars = items.reduce((total, item) => total + item.str.length, 0);
          if (entry.searchTextChars + chars <= SEARCH_TEXT_BUDGET) {
            entry.searchText.set(pageIndex, items);
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
        patch(key, {
          status: 'ready',
          error: null,
          passwordRejected: false,
          info: handle.info,
          editor: createEditorState(model),
          view: createViewState(model),
          pagesComplete: handle.pagesComplete,
        });
        handle.onPageInfo((updates) => {
          entry.pendingPageInfo.push(...updates);
          entry.flushTimer ??= setTimeout(() => flushPageInfo(key), PAGE_INFO_FLUSH_MS);
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

    return {
      documents: [],
      activeKey: null,
      notice: null,

      async openFiles(files) {
        const pdfs = files.filter((file) => isLikelyPdfName(file.name));
        const skipped = files.length - pdfs.length;
        if (skipped > 0) {
          get().showNotice(
            skipped === 1
              ? 'Skipped 1 file that is not a PDF.'
              : `Skipped ${skipped} files that are not PDFs.`,
          );
        }
        for (const file of files) if (!pdfs.includes(file)) file.release?.();
        if (pdfs.length === 0) return;

        const added: WorkspaceDocument[] = pdfs.map((file) => {
          const key = nextKey();
          resources.set(key, {
            file,
            bytes: null,
            handle: null,
            pendingPageInfo: [],
            flushTimer: null,
            search: null,
            searchText: new Map(),
            searchTextChars: 0,
          });
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
            pagesComplete: false,
            navigation: null,
            search: IDLE_SEARCH,
          };
        });
        set((state) => ({
          documents: [...state.documents, ...added],
          activeKey: added[0]?.key ?? state.activeKey,
        }));
        await Promise.all(added.map((doc) => load(doc.key)));
      },

      async submitPassword(key, password) {
        const doc = get().documents.find((entry) => entry.key === key);
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
        if (entry?.flushTimer) clearTimeout(entry.flushTimer);
        entry?.search?.abort();
        entry?.file.release?.();
        await entry?.handle?.destroy();
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
        const doc = get().documents.find((entry) => entry.key === key);
        const pageIndex = doc?.editor?.model.pages.findIndex((page) => page.id === pageId) ?? -1;
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
        updateSearch(key, (search) => ({
          open: true,
          query: changes.query ?? search.query,
          options: { ...search.options, ...changes.options },
        }));
        runSearch(key);
      },

      stepSearch(key, direction) {
        const doc = get().documents.find((entry) => entry.key === key);
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
    };
  });

  return {
    ...store,
    getHandle: (key) => resources.get(key)?.handle ?? null,
    getBytes: (key) => {
      const entry = resources.get(key);
      return entry?.handle ? entry.bytes : null;
    },
    async destroy() {
      const entries = [...resources.values()];
      resources.clear();
      for (const entry of entries) {
        if (entry.flushTimer) clearTimeout(entry.flushTimer);
        entry.search?.abort();
      }
      store.setState({ documents: [], activeKey: null });
      await Promise.all(
        entries.map(async (entry) => {
          entry.file.release?.();
          await entry.handle?.destroy();
        }),
      );
    },
  };
}
