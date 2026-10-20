import type { SourceId } from '@folio/document-model';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ICON,
} from '@folio/shared-ui';
import { ChevronDown, FileText } from 'lucide-react';
import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUi, useWorkspace, useWorkspaceContext } from '../context';
import { paneKeys, type PaneSide } from '../store/split';
import type { WorkspaceDocument } from '../store/workspace';
import { DocumentViewer } from '../viewer/document-viewer';
import { pageViewSelector } from '../viewer/page-overlays';
import { AnnotationToolbar } from './annotation-toolbar';
import { ErrorState, LoadingState, PasswordState } from './document-states';
import { FindBar } from './find-bar';
import { FormBar } from './form-bar';
import { Sidebar } from './sidebar';

/** Engine documents of a tab's source files, for its pages. */
export function useSourceHandles(docKey: string) {
  const { workspace } = useWorkspaceContext();
  return useCallback(
    (sourceId: SourceId) => workspace.getSourceHandle(docKey, sourceId),
    [workspace, docKey],
  );
}

/** Where a document is shown in a split view; absent with one pane. */
interface InPane {
  /** The pane has focus: its document is the active one. */
  active: boolean;
}

function ReadyDocument({ doc, pane }: { doc: WorkspaceDocument; pane?: InPane }) {
  const { workspace } = useWorkspaceContext();
  const handle = workspace.getHandle(doc.key);
  const sourceHandle = useSourceHandles(doc.key);
  const model = doc.editor?.model;
  if (!handle || !model || !doc.view) return null;
  return (
    <div className="flex h-full flex-col">
      {/* A split view has one set of tools, above both panes. */}
      {pane ? null : <AnnotationToolbar doc={doc} />}
      <FormBar doc={doc} />
      {doc.search.open && (!pane || pane.active) ? (
        <FindBar
          key={doc.key}
          doc={doc}
          onClose={() => {
            workspace.getState().closeSearch(doc.key);
            // Focus returns to the pages.
            document.querySelector<HTMLElement>(pageViewSelector(doc.key))?.focus();
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
          label={pane ? `Page view, ${doc.fileName}` : 'Page view'}
        />
      </div>
    </div>
  );
}

/** A document as far as it got: opening, asking for its password, failed, or its pages. */
export function DocumentBody({ doc, pane }: { doc: WorkspaceDocument; pane?: InPane }) {
  switch (doc.status) {
    case 'loading':
      return <LoadingState doc={doc} />;
    case 'needs-password':
      // The password field takes focus only where the user is.
      return <PasswordState key={doc.key} doc={doc} autoFocus={!pane || pane.active} />;
    case 'error':
      return <ErrorState doc={doc} />;
    case 'ready':
      return <ReadyDocument doc={doc} pane={pane} />;
  }
}

const SIDE_NAMES: Record<PaneSide, string> = { left: 'Left pane', right: 'Right pane' };

/** The pane's header: which document it shows, to choose another or open one. */
function PaneHeader({
  side,
  doc,
  active,
  onOpen,
}: {
  side: PaneSide;
  doc: WorkspaceDocument | null;
  active: boolean;
  onOpen(): void;
}) {
  const documents = useWorkspace((state) => state.documents);
  const showInPane = useWorkspace((state) => state.showInPane);
  return (
    <div
      className={cn(
        'flex h-9 shrink-0 items-center border-t-2 border-b border-b-line px-1.5',
        active ? 'border-t-accent bg-accent-soft' : 'border-t-transparent bg-surface',
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0"
            aria-label={`${SIDE_NAMES[side]}: ${doc ? doc.fileName : 'no document'}. Choose a document`}
          >
            <FileText size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
            <span className="truncate">{doc ? doc.fileName : 'No document'}</span>
            <ChevronDown size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Show in this pane</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={doc?.key ?? ''}
            onValueChange={(key) => showInPane(side, key)}
          >
            {documents.map((entry) => (
              <DropdownMenuRadioItem key={entry.key} value={entry.key}>
                {entry.fileName}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpen}>Open a PDF…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** A pane without a document: the open ones to show, or a new one. */
function EmptyPane({ side, onOpen }: { side: PaneSide; onOpen(): void }) {
  const activeKey = useWorkspace((state) => state.activeKey);
  const documents = useWorkspace((state) => state.documents).filter(
    (entry) => entry.key !== activeKey,
  );
  const showInPane = useWorkspace((state) => state.showInPane);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="max-w-xs text-sm text-ink-muted">
        {documents.length > 0
          ? 'Choose a document to show beside the other one, or open another PDF.'
          : 'Open another PDF to show it beside this one. You can then drag pages from one to the other to copy them.'}
      </p>
      {documents.length > 0 ? (
        <ul aria-label="Open documents to show here" className="flex flex-col items-center gap-1">
          {documents.map((entry) => (
            <li key={entry.key} className="max-w-full">
              <Button
                variant="ghost"
                className="max-w-full"
                onClick={() => showInPane(side, entry.key)}
              >
                <FileText size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />
                <span className="truncate">{entry.fileName}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="primary" onClick={onOpen}>
        Open a PDF…
      </Button>
    </div>
  );
}

function Pane({
  side,
  doc,
  active,
  onOpen,
  onFind,
}: {
  side: PaneSide;
  doc: WorkspaceDocument | null;
  active: boolean;
  onOpen(): void;
  onFind(): void;
}) {
  const { workspace } = useWorkspaceContext();
  const leftPanelOpen = useUi((state) => state.leftPanelOpen);
  const sourceHandle = useSourceHandles(doc?.key ?? '');
  const handle = doc?.status === 'ready' ? workspace.getHandle(doc.key) : null;
  // Pointing at a pane or moving the keyboard into it makes its document the active one.
  const focus = () => {
    if (doc && !active) workspace.getState().activate(doc.key);
  };
  return (
    <section
      aria-label={doc ? `${SIDE_NAMES[side]}, ${doc.fileName}` : SIDE_NAMES[side]}
      data-pane={side}
      data-active={active || undefined}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col',
        side === 'right' && 'border-t border-line min-[1100px]:border-t-0 min-[1100px]:border-l',
      )}
    >
      <PaneHeader side={side} doc={doc} active={active} onOpen={onOpen} />
      <div className="flex min-h-0 flex-1">
        {doc && handle && doc.editor && doc.view && leftPanelOpen ? (
          <Sidebar
            doc={doc}
            pages={doc.editor.model.pages}
            view={doc.view}
            handle={handle}
            sourceId={(Object.keys(doc.editor.model.sources)[0] as SourceId | undefined) ?? null}
            sourceHandle={sourceHandle}
            onFind={onFind}
            named
          />
        ) : null}
        <div className="relative min-w-0 flex-1 overflow-hidden bg-canvas">
          {doc ? (
            <DocumentBody doc={doc} pane={{ active }} />
          ) : (
            <EmptyPane side={side} onOpen={onOpen} />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Two documents side by side, each with its own pages panel and page view.
 * The pane with focus holds the active document, which the toolbars,
 * menus and shortcuts act on. Narrow windows stack the panes.
 */
export function SplitView({ onOpen, onFind }: { onOpen(): void; onFind(): void }) {
  const { activeKey, split, documents } = useWorkspace(
    useShallow((state) => ({
      activeKey: state.activeKey,
      split: state.split,
      documents: state.documents,
    })),
  );
  const keys = paneKeys({ activeKey, split });
  const byKey = (key: string | null) => documents.find((doc) => doc.key === key) ?? null;
  const active = byKey(activeKey);
  return (
    <div className="flex h-full flex-col">
      {active?.status === 'ready' ? <AnnotationToolbar doc={active} /> : null}
      <div className="flex min-h-0 flex-1 flex-col min-[1100px]:flex-row">
        {(['left', 'right'] as const).map((side) => (
          <Pane
            key={side}
            side={side}
            doc={byKey(keys[side])}
            active={split.activeSide === side}
            onOpen={onOpen}
            onFind={onFind}
          />
        ))}
      </div>
    </div>
  );
}
