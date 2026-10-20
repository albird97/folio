import type { DocumentViewState, PageModel, SourceId } from '@folio/document-model';
import type { PdfDocumentHandle } from '@folio/pdf-core';
import { cn } from '@folio/shared-ui';
import { Tabs } from 'radix-ui';
import { useUi } from '../context';
import { SIDEBAR_TABS, type SidebarTab } from '../store/ui';
import type { WorkspaceDocument } from '../store/workspace';
import { CommentsPanel } from './comments-panel';
import { OutlinePanel } from './outline-panel';
import { ResultsPanel } from './results-panel';
import { ThumbnailsPanel } from './thumbnails-panel';

const LABELS: Record<SidebarTab, string> = {
  pages: 'Pages',
  outline: 'Bookmarks',
  comments: 'Comments',
  results: 'Results',
};

export function Sidebar({
  doc,
  pages,
  view,
  handle,
  sourceId,
  sourceHandle,
  onFind,
  named = false,
}: {
  doc: WorkspaceDocument;
  pages: readonly PageModel[];
  view: DocumentViewState;
  /** The opened file (its bookmarks). */
  handle: PdfDocumentHandle;
  sourceId: SourceId | null;
  sourceHandle(sourceId: SourceId): PdfDocumentHandle | null;
  onFind(): void;
  /** Name the document in the sidebar's labels (split view shows two sidebars). */
  named?: boolean;
}) {
  const tab = useUi((state) => state.sidebarTab);
  const setTab = useUi((state) => state.setSidebarTab);
  const resultCount = doc.search.query.trim() ? doc.search.matches.length : null;
  const commentCount = Object.keys(doc.editor?.model.annotations ?? {}).length;

  return (
    <aside
      aria-label={named ? `Sidebar, ${doc.fileName}` : 'Sidebar'}
      className="flex w-64 shrink-0 flex-col border-r border-line bg-surface"
    >
      <Tabs.Root
        value={tab}
        onValueChange={(value) => setTab(value as SidebarTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List
          aria-label="Sidebar views"
          className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2"
        >
          {SIDEBAR_TABS.filter(
            // Search results get a tab while there is a search.
            (value) => value !== 'results' || resultCount !== null || tab === 'results',
          ).map((value) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-ink-muted outline-hidden',
                'hover:text-ink focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-focus',
                'data-[state=active]:bg-hover data-[state=active]:text-ink',
              )}
            >
              {LABELS[value]}
              {value === 'pages' ? (
                <span className="text-2xs font-normal text-ink-muted tabular">
                  {pages.length.toLocaleString()}
                </span>
              ) : null}
              {value === 'comments' && commentCount > 0 ? (
                <span className="text-2xs font-normal text-ink-muted tabular">
                  {commentCount.toLocaleString()}
                </span>
              ) : null}
              {value === 'results' && resultCount !== null ? (
                <span className="text-2xs font-normal text-ink-muted tabular">
                  {resultCount.toLocaleString()}
                </span>
              ) : null}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="pages" className="min-h-0 flex-1 outline-hidden">
          <ThumbnailsPanel
            doc={doc}
            pages={pages}
            view={view}
            sourceHandle={sourceHandle}
            label={named ? `Pages, ${doc.fileName}` : 'Pages'}
          />
        </Tabs.Content>
        <Tabs.Content value="outline" className="min-h-0 flex-1 outline-hidden">
          <OutlinePanel
            key={doc.key}
            docKey={doc.key}
            handle={handle}
            pages={pages}
            sourceId={sourceId}
          />
        </Tabs.Content>
        <Tabs.Content value="comments" className="min-h-0 flex-1 outline-hidden">
          <CommentsPanel doc={doc} />
        </Tabs.Content>
        <Tabs.Content value="results" className="min-h-0 flex-1 pt-2 outline-hidden">
          <ResultsPanel doc={doc} onFind={onFind} />
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
