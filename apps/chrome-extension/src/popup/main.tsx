import '../styles.css';
import { FolioMark, ICON, IconButton } from '@folio/shared-ui';
import {
  ChevronRight,
  FileDown,
  FileText,
  PanelRightOpen,
  Printer,
  Search,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { describeActivity } from '../shared/activity';
import { sendMessage } from '../shared/messages';
import { mountSurface, openEditor } from '../shared/surface';
import {
  activeTab,
  isWebUrl,
  looksLikePdfUrl,
  openInEditor,
  printTab,
  scanTab,
} from '../shared/tab-tools';
import { relativeTime, useActivity } from '../shared/use-activity';

function Action({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover active:bg-pressed"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-ink">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-ink-muted">{description}</span>
      </span>
      <ChevronRight
        size={ICON.sm}
        strokeWidth={ICON.stroke}
        className="text-ink-subtle transition-transform duration-150 ease-out-quart group-hover:translate-x-0.5"
        aria-hidden
      />
    </button>
  );
}

function RecentActivity() {
  const { activity, settings } = useActivity();
  if (activity === null) return null;
  return (
    <section aria-labelledby="activity-title" className="border-t border-line px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 id="activity-title" className="text-xs font-semibold">
          Recent activity
        </h2>
        {activity.length > 0 ? (
          <button
            type="button"
            className="text-xs text-accent hover:underline"
            onClick={() => void sendMessage({ type: 'activity/clear' })}
          >
            Clear
          </button>
        ) : null}
      </div>
      {!settings.activityEnabled ? (
        <p className="text-xs text-ink-muted">Activity history is turned off in settings.</p>
      ) : activity.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Nothing yet. Documents you open will be listed here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Recent activity">
          {activity.slice(0, 5).map((entry) => (
            <li key={entry.id} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate">
                {describeActivity(entry)}
                {entry.fileName ? (
                  <span className="text-ink-muted"> — {entry.fileName}</span>
                ) : null}
              </span>
              <time dateTime={entry.at} className="shrink-0 text-ink-muted">
                {relativeTime(entry.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type TabState =
  | { kind: 'loading' }
  /** `maybe`: Chrome would not let Folio look at the page (its PDF viewer may not). */
  | { kind: 'web'; tab: { id: number; url: URL }; pdf: 'yes' | 'maybe' | 'no' }
  | { kind: 'local-file' }
  | { kind: 'other' };

/**
 * The tab the toolbar button was clicked on (Chrome's activeTab permission):
 * open its PDF, or print it to PDF. Nothing here asks for a permission:
 * Chrome closes the popup when a prompt opens, so the editor tab and the
 * side panel ask instead.
 */
function ThisTab({ onSidePanel }: { onSidePanel(): void }) {
  const [state, setState] = useState<TabState>({ kind: 'loading' });
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const tab = await activeTab().catch(() => null);
      if (!active) return;
      if (tab?.url?.protocol === 'file:') return setState({ kind: 'local-file' });
      if (!tab?.url || !isWebUrl(tab.url)) return setState({ kind: 'other' });
      const web = { id: tab.id, url: tab.url };
      const byName = looksLikePdfUrl(tab.url);
      setState({ kind: 'web', tab: web, pdf: byName ? 'yes' : 'no' });
      // Chrome's PDF viewer reports the PDF type, if Chrome lets Folio look;
      // a tab it cannot look at may well be a PDF too.
      const scan = await scanTab(tab.id);
      if (!active) return;
      const pdf = byName || scan?.contentType === 'application/pdf' ? 'yes' : scan ? 'no' : 'maybe';
      setState({ kind: 'web', tab: web, pdf });
    })();
    return () => {
      active = false;
    };
  }, []);

  if (state.kind === 'loading') return null;
  if (state.kind !== 'web') {
    return (
      <section aria-labelledby="tab-title" className="border-t border-line px-4 py-3">
        <h2 id="tab-title" className="text-xs font-semibold">
          This tab
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          {state.kind === 'local-file'
            ? 'Chrome doesn’t let extensions read files from your computer. To open this one, use Open a PDF and choose it.'
            : 'Folio can open PDFs from web pages (addresses starting with https:// or http://).'}
        </p>
      </section>
    );
  }

  const { tab, pdf } = state;
  const openPdf = () =>
    void openInEditor(tab.url.href).then((response) => {
      if (response.ok) globalThis.close();
      else setProblem('The editor could not be opened. Try again.');
    });
  const savePage = () =>
    void printTab(tab.id).then((printed) => {
      if (printed) globalThis.close();
      else
        setProblem(
          'Chrome doesn’t let extensions print this page. Press Ctrl+P (⌘P on a Mac) to print it yourself.',
        );
    });

  return (
    <section aria-labelledby="tab-title" className="border-t border-line px-1.5 py-2">
      <h2 id="tab-title" className="px-2.5 pb-1 text-xs font-semibold">
        This tab <span className="font-normal text-ink-muted">· {tab.url.hostname}</span>
      </h2>
      <div className="flex flex-col gap-0.5">
        {pdf === 'yes' ? (
          <Action
            icon={<FileDown size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
            title="Open this PDF in Folio"
            description="Downloads it to this device and opens it in the editor"
            onClick={openPdf}
          />
        ) : pdf === 'maybe' ? (
          <Action
            icon={<FileDown size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
            title="Open this tab in Folio"
            description="Works when the tab shows a PDF: Folio downloads it and opens it"
            onClick={openPdf}
          />
        ) : null}
        <Action
          icon={<Search size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          title="PDFs on this page"
          description="List linked PDFs in the side panel to open or download"
          onClick={onSidePanel}
        />
        <Action
          icon={<Printer size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          title="Save page as PDF"
          description="Opens Chrome’s print dialog; choose “Save as PDF”"
          onClick={savePage}
        />
      </div>
      {problem ? (
        <p role="alert" className="px-2.5 pt-1 text-xs text-danger-ink">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

function Popup() {
  // Resolved up front: chrome.sidePanel.open() must be called directly in the
  // click handler, because awaiting another API first can lose the user gesture.
  const [windowId, setWindowId] = useState<number | null>(null);
  useEffect(() => {
    void chrome.windows.getCurrent().then((window) => setWindowId(window.id ?? null));
  }, []);

  const openSidePanel = () => {
    if (windowId === null) return;
    void chrome.sidePanel.open({ windowId }).then(() => globalThis.close());
  };

  return (
    <div className="folio-chrome w-[340px] bg-surface text-ink">
      <header className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="flex items-center gap-2">
          <FolioMark className="size-6" />
          <h1 className="text-sm font-semibold tracking-[-0.01em]">Folio</h1>
        </span>
        <IconButton
          label="Settings"
          size="icon-sm"
          icon={<Settings size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          onClick={() => void chrome.runtime.openOptionsPage().then(() => globalThis.close())}
        />
      </header>
      <nav aria-label="Quick actions" className="flex flex-col gap-0.5 px-1.5 pb-2">
        <Action
          icon={<FileText size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          title="Open a PDF"
          description="Choose a file in the Folio editor"
          onClick={() => void openEditor().then(() => globalThis.close())}
        />
        <Action
          icon={<PanelRightOpen size={ICON.md} strokeWidth={ICON.stroke} aria-hidden />}
          title="Open side panel"
          description="Inspect a PDF next to the page you’re on"
          onClick={openSidePanel}
        />
      </nav>
      <ThisTab onSidePanel={openSidePanel} />
      <RecentActivity />
      <footer className="flex items-center justify-between border-t border-line bg-bg px-4 py-2 text-2xs text-ink-muted">
        <span className="flex items-center gap-1">
          <ShieldCheck size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
          Processed on this device
        </span>
        <span className="tabular">v{chrome.runtime.getManifest().version}</span>
      </footer>
    </div>
  );
}

mountSurface(() => <Popup />);
