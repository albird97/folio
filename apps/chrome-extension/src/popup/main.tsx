import '../styles.css';
import { FolioMark, ICON, IconButton } from '@folio/shared-ui';
import { ChevronRight, FileText, PanelRightOpen, Settings, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { describeActivity } from '../shared/activity';
import { sendMessage } from '../shared/messages';
import { mountSurface, openEditor } from '../shared/surface';
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

function Popup() {
  const openSidePanel = async () => {
    const window = await chrome.windows.getCurrent();
    if (window.id !== undefined) await chrome.sidePanel.open({ windowId: window.id });
    globalThis.close();
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
          onClick={() => void openSidePanel()}
        />
      </nav>
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
