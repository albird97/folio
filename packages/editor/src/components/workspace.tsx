import type { SourceId } from '@folio/document-model';
import { useTheme } from '@folio/shared-ui';
import { useCallback, useEffect } from 'react';
import { useCommands } from '../hooks/use-commands';
import { useFileDrop } from '../hooks/use-file-drop';
import { useRecovery } from '../hooks/use-recovery';
import { useToolShortcuts } from '../hooks/use-tool-shortcuts';
import { useTransfers } from '../hooks/use-transfers';
import { useUnsavedGuard } from '../hooks/use-unsaved-guard';
import { useActiveDocument, useUi, useWorkspace, useWorkspaceContext } from '../context';
import type { WorkspaceDocument } from '../store/workspace';
import { DocumentViewer } from '../viewer/document-viewer';
import { forgetDocuments } from '../viewer/resources';
import { AnnotationToolbar } from './annotation-toolbar';
import { Dialogs } from './dialogs';
import { ErrorState, LoadingState, PasswordState } from './document-states';
import { FindBar } from './find-bar';
import { DropOverlay, NoticeToast } from './overlays';
import { PrintLayout } from './print-layout';
import { PropertiesPanel } from './properties-panel';
import { Sidebar } from './sidebar';
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

/** Returns focus to the pages after the find bar closes. */
function focusViewer() {
  document.querySelector<HTMLElement>('[role="region"][aria-label="Page view"]')?.focus();
}

/** Engine documents of a tab's source files, for its pages. */
function useSourceHandles(docKey: string) {
  const { workspace } = useWorkspaceContext();
  return useCallback(
    (sourceId: SourceId) => workspace.getSourceHandle(docKey, sourceId),
    [workspace, docKey],
  );
}

function ReadyDocument({ doc }: { doc: WorkspaceDocument }) {
  const { workspace } = useWorkspaceContext();
  const handle = workspace.getHandle(doc.key);
  const sourceHandle = useSourceHandles(doc.key);
  const model = doc.editor?.model;
  if (!handle || !model || !doc.view) return null;
  return (
    <div className="flex h-full flex-col">
      <AnnotationToolbar doc={doc} />
      {doc.search.open ? (
        <FindBar
          key={doc.key}
          doc={doc}
          onClose={() => {
            workspace.getState().closeSearch(doc.key);
            focusViewer();
          }}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <DocumentViewer
          key={doc.key}
          doc={doc}
          pages={model.pages}
          view={doc.view}
          sourceHandle={sourceHandle}
        />
      </div>
    </div>
  );
}

function ActiveDocument() {
  const doc = useActiveDocument();
  if (!doc) return null;
  switch (doc.status) {
    case 'loading':
      return <LoadingState doc={doc} />;
    case 'needs-password':
      return <PasswordState key={doc.key} doc={doc} />;
    case 'error':
      return <ErrorState doc={doc} />;
    case 'ready':
      return <ReadyDocument doc={doc} />;
  }
}

export function Workspace({ chrome = {} }: { chrome?: WorkspaceChrome }) {
  const { adapter, workspace } = useWorkspaceContext();
  const hydrated = useUi((state) => state.hydrated);
  const theme = useUi((state) => state.theme);
  const leftPanelOpen = useUi((state) => state.leftPanelOpen);
  const rightPanelOpen = useUi((state) => state.rightPanelOpen);
  const hasDocuments = useWorkspace((state) => state.documents.length > 0);
  const openKeys = useWorkspace((state) => state.documents.map((doc) => doc.key).join('\n'));
  const doc = useActiveDocument();
  const dispatch = useCommands();
  const { hovering, handlers } = useFileDrop();
  useUnsavedGuard();
  useRecovery();
  useTransfers();
  useToolShortcuts();
  useTheme(theme);

  const open = useCallback(() => dispatch('open'), [dispatch]);

  useEffect(
    () => adapter.onIncomingFiles((files) => void workspace.getState().openFiles(files)),
    [adapter, workspace],
  );

  // Rendered pages of closed documents are dropped from the caches.
  useEffect(() => {
    forgetDocuments(new Set(openKeys ? openKeys.split('\n') : []));
  }, [openKeys]);

  const activeFileName = doc?.fileName ?? null;
  useEffect(() => {
    adapter.setWindowTitle(activeFileName ? `${activeFileName} — Folio` : 'Folio');
  }, [adapter, activeFileName]);

  const sourceHandle = useSourceHandles(doc?.key ?? '');

  if (!hydrated) return <div className="h-full bg-bg" />;

  const handle = doc?.status === 'ready' ? workspace.getHandle(doc.key) : null;
  const primarySourceId =
    (doc?.editor && (Object.keys(doc.editor.model.sources)[0] as SourceId | undefined)) ?? null;
  return (
    <div className="folio-chrome flex h-full flex-col bg-bg text-ink" {...handlers}>
      <TabStrip
        onOpen={open}
        insetStart={chrome.titleBarInset}
        dragRegion={chrome.dragRegion}
        brand={chrome.brand}
      />
      <WorkspaceToolbar onCommand={dispatch} />
      <div className="flex min-h-0 flex-1">
        {doc && handle && doc.editor && doc.view && leftPanelOpen ? (
          <Sidebar
            doc={doc}
            pages={doc.editor.model.pages}
            view={doc.view}
            handle={handle}
            sourceId={primarySourceId}
            sourceHandle={sourceHandle}
            onFind={() => dispatch('find')}
          />
        ) : null}
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
      <Dialogs />
      <PrintLayout />
    </div>
  );
}
