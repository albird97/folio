import '../styles.css';
import { useWorkspace, Workspace, WorkspaceProvider } from '@folio/editor';
import { createBrowserPdfEngine } from '@folio/pdf-core/browser';
import { memoryFile } from '@folio/platform-adapters';
import { applyInitialTheme } from '@folio/shared-ui';
import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { createChromePlatformAdapter } from '../platform/chrome-adapter';
import { takeHandoff } from '../shared/handoff';
import { sendMessage } from '../shared/messages';

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

// A document handed over by the side panel (single-use, deleted on read).
const handoffId = new URL(location.href).searchParams.get('handoff');
if (handoffId) {
  history.replaceState(null, '', location.pathname);
  void takeHandoff(handoffId).then((record) => {
    if (record) adapter.deliverFiles([memoryFile(record.name, new Uint8Array(record.bytes))]);
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceProvider adapter={adapter} engine={engine} profile="browser">
      <ActivityRecorder />
      <Workspace chrome={{ brand: true }} />
    </WorkspaceProvider>
  </StrictMode>,
);
