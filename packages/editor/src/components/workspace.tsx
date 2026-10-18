import { useTheme } from '@folio/shared-ui';
import { useCallback, useEffect } from 'react';
import { useCommands } from '../hooks/use-commands';
import { useFileDrop } from '../hooks/use-file-drop';
import { useActiveDocument, useUi, useWorkspace, useWorkspaceContext } from '../context';
import { ErrorState, LoadingState, PasswordState } from './document-states';
import { DropOverlay, NoticeToast } from './overlays';
import { PagePreview } from './page-preview';
import { PagesPanel } from './pages-panel';
import { PropertiesPanel } from './properties-panel';
import { StatusBar } from './status-bar';
import { TabStrip } from './tab-strip';
import { WorkspaceToolbar } from './toolbar';
import { Welcome } from './welcome';

export interface WorkspaceChrome {
  /** Space reserved for window controls drawn over the content (macOS overlay title bar). */
  titleBarInset?: number;
  /** Mark empty title-bar areas as window drag regions (Tauri). */
  dragRegion?: boolean;
  /** Show the Folio wordmark in the tab strip (browser targets without a native title bar). */
  brand?: boolean;
}

function ActiveDocument() {
  const { workspace } = useWorkspaceContext();
  const doc = useActiveDocument();
  if (!doc) return null;
  switch (doc.status) {
    case 'loading':
      return <LoadingState doc={doc} />;
    case 'needs-password':
      return <PasswordState key={doc.key} doc={doc} />;
    case 'error':
      return <ErrorState doc={doc} />;
    case 'ready': {
      const handle = workspace.getHandle(doc.key);
      const pages = doc.editor?.model.pages ?? [];
      const index = Math.max(0, pages.findIndex((page) => page.id === doc.view?.currentPageId));
      const page = pages[index];
      if (!handle || !page) return null;
      return <PagePreview handle={handle} page={page} position={index} pageCount={pages.length} />;
    }
  }
}

export function Workspace({ chrome = {} }: { chrome?: WorkspaceChrome }) {
  const { adapter, workspace } = useWorkspaceContext();
  const hydrated = useUi((state) => state.hydrated);
  const theme = useUi((state) => state.theme);
  const leftPanelOpen = useUi((state) => state.leftPanelOpen);
  const rightPanelOpen = useUi((state) => state.rightPanelOpen);
  const hasDocuments = useWorkspace((state) => state.documents.length > 0);
  const doc = useActiveDocument();
  const dispatch = useCommands();
  const { hovering, handlers } = useFileDrop();
  useTheme(theme);

  const open = useCallback(() => dispatch('open'), [dispatch]);

  useEffect(() => adapter.onIncomingFiles((files) => void workspace.getState().openFiles(files)), [adapter, workspace]);

  useEffect(() => {
    adapter.setWindowTitle(doc ? `${doc.fileName} — Folio` : 'Folio');
  }, [adapter, doc]);

  if (!hydrated) return <div className="h-full bg-bg" />;

  return (
    <div className="folio-chrome flex h-full flex-col bg-bg text-ink" {...handlers}>
      <TabStrip
        onOpen={open}
        insetStart={chrome.titleBarInset}
        dragRegion={chrome.dragRegion}
        brand={chrome.brand}
      />
      <WorkspaceToolbar onOpen={open} />
      <div className="flex min-h-0 flex-1">
        {doc?.status === 'ready' && leftPanelOpen ? <PagesPanel doc={doc} /> : null}
        <main
          aria-label={doc ? doc.fileName : 'Start'}
          className="relative min-w-0 flex-1 overflow-hidden bg-canvas"
          id="folio-document"
        >
          {doc ? <ActiveDocument /> : <Welcome onOpen={open} hovering={hovering} />}
        </main>
        {doc && rightPanelOpen ? <PropertiesPanel doc={doc} /> : null}
      </div>
      <StatusBar />
      <DropOverlay visible={hovering && hasDocuments} />
      <NoticeToast />
    </div>
  );
}
