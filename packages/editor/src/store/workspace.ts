import {
  createDocumentModel,
  createEditorState,
  createViewState,
  type DocumentViewState,
  type EditorDocumentState,
  type PageId,
} from '@folio/document-model';
import {
  isPdfError,
  PdfError,
  sha256Hex,
  toSourceDescriptor,
  type PdfDocumentHandle,
  type PdfDocumentInfo,
  type PdfEngine,
  type PdfErrorCode,
} from '@folio/pdf-core';
import type { IncomingFile } from '@folio/platform-adapters';
import { createStore, type StoreApi } from 'zustand/vanilla';

export type DocumentStatus = 'loading' | 'needs-password' | 'ready' | 'error';

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
  dismissNotice(): void;
}

interface Resources {
  file: IncomingFile;
  bytes: Uint8Array | null;
  handle: PdfDocumentHandle | null;
}

export interface WorkspaceStore extends StoreApi<WorkspaceState> {
  /** The engine handle for a ready document, for rendering. */
  getHandle(key: string): PdfDocumentHandle | null;
  destroy(): Promise<void>;
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
          noticeId += 1;
          set({
            notice: {
              id: noticeId,
              message:
                skipped === 1
                  ? 'Skipped 1 file that is not a PDF.'
                  : `Skipped ${skipped} files that are not PDFs.`,
            },
          });
        }
        for (const file of files) if (!pdfs.includes(file)) file.release?.();
        if (pdfs.length === 0) return;

        const added: WorkspaceDocument[] = pdfs.map((file) => {
          const key = nextKey();
          resources.set(key, { file, bytes: null, handle: null });
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
        if (!doc?.view || !doc.editor?.model.pages.some((page) => page.id === pageId)) return;
        patch(key, { view: { ...doc.view, currentPageId: pageId } });
      },

      dismissNotice() {
        set({ notice: null });
      },
    };
  });

  return {
    ...store,
    getHandle: (key) => resources.get(key)?.handle ?? null,
    async destroy() {
      const entries = [...resources.values()];
      resources.clear();
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
