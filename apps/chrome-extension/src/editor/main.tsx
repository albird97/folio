import '../styles.css';
import {
  createUiStore,
  createWorkspaceStore,
  useWorkspace,
  Workspace,
  WorkspaceProvider,
} from '@folio/editor';
import { createBrowserPdfEngine } from '@folio/pdf-core/browser';
import { memoryFile, OpenUrlError } from '@folio/platform-adapters';
import { applyInitialTheme } from '@folio/shared-ui';
import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createChromePlatformAdapter, openWebPdf } from '../platform/chrome-adapter';
import { takeHandoff } from '../shared/handoff';
import { sendMessage } from '../shared/messages';
import { OPEN_URL_JOB_PREFIX } from '../shared/web-pdf';

/** Records "opened" activity once per document (counts only, unless names are allowed). */
function ActivityRecorder() {
  const documents = useWorkspace((state) => state.documents);
  const recorded = useRef(new Set<string>());
  useEffect(() => {
    for (const doc of documents) {
      if (doc.status !== 'ready' || recorded.current.has(doc.key)) continue;
      recorded.current.add(doc.key);
      void sendMessage({
        type: 'activity/record',
        kind: 'opened',
        pageCount: doc.editor?.model.pages.length,
        fileName: doc.fileName,
      });
    }
  }, [documents]);
  return null;
}

applyInitialTheme();
const adapter = createChromePlatformAdapter();
const engine = createBrowserPdfEngine();
const stores = { workspace: createWorkspaceStore(engine), ui: createUiStore(adapter.storage) };

const params = new URL(location.href).searchParams;
if (params.size > 0) history.replaceState(null, '', location.pathname);

// A document handed over by the side panel (single-use, deleted on read).
const handoffId = params.get('handoff');
if (handoffId) {
  void takeHandoff(handoffId).then((record) => {
    if (record) adapter.deliverFiles([memoryFile(record.name, new Uint8Array(record.bytes))]);
  });
}

// A web address from the toolbar popup, which already asked for access to the site.
const openJob = params.get('open');
if (openJob && /^[0-9a-f]{32}$/.test(openJob)) {
  const key = `${OPEN_URL_JOB_PREFIX}${openJob}`;
  void chrome.storage.session.get(key).then(async (items) => {
    await chrome.storage.session.remove(key);
    const url = items[key];
    if (typeof url !== 'string') return;
    const notice = stores.workspace.getState();
    try {
      const file = await openWebPdf(url, {
        ask: false,
        onProgress: (received, total) =>
          notice.showNotice(
            total
              ? `Downloading… ${Math.round((received / total) * 100)}%`
              : `Downloading… ${Math.round(received / 1024)} KB`,
          ),
      });
      stores.workspace.getState().dismissNotice();
      adapter.deliverFiles([file]);
    } catch (error) {
      stores.workspace.getState().dismissNotice();
      // The dialog explains the problem and can retry: after Chrome's access
      // prompt (which needs a click here), or with a sign-in.
      const host = new URL(url).hostname;
      stores.ui.getState().openDialog({
        kind: 'open-url',
        url,
        error:
          error instanceof OpenUrlError && error.code === 'permission-denied'
            ? {
                code: 'permission-denied',
                message: `To open this PDF, Folio needs your permission to read files from ${host}. Select Open, then Allow when Chrome asks.`,
              }
            : error instanceof OpenUrlError
              ? { code: error.code, message: error.message }
              : { code: 'network', message: 'The file could not be downloaded.' },
      });
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceProvider adapter={adapter} engine={engine} profile="browser" stores={stores}>
      <ActivityRecorder />
      <Workspace chrome={{ brand: true }} />
    </WorkspaceProvider>
  </StrictMode>,
);
