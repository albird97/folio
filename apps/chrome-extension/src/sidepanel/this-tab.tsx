import { Button, ICON } from '@folio/shared-ui';
import { Download, ExternalLink, Printer, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  activeTab,
  downloadWithChrome,
  isWebUrl,
  looksLikePdfUrl,
  openInEditor,
  printTab,
  scanTab,
  type PageScan,
} from '../shared/tab-tools';

type State =
  | { kind: 'loading' }
  /** Folio cannot see this tab's address: no toolbar click on it yet. */
  | { kind: 'no-access' }
  | { kind: 'not-web'; localFile: boolean }
  | {
      kind: 'web';
      tabId: number;
      url: URL;
      /** Null when Chrome does not let extensions read the page, or before it was looked at. */
      scan: PageScan | null;
      scanned: boolean;
    };

const describeLink = (url: string) => {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname);
  } catch {
    return url;
  }
};

/**
 * PDFs in the tab in front: the tab's own PDF and the PDFs it links to, to
 * open in the editor or download, and the tab printed to PDF. Works on a tab
 * after its toolbar button was clicked (Chrome's activeTab permission).
 */
export function ThisTab() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  /** Bumped to look at the tab again (button, tab switches, page loads). */
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((value) => value + 1);

  useEffect(() => {
    let active = true;
    void (async () => {
      const tab = await activeTab().catch(() => null);
      if (!active) return;
      if (!tab?.url) return setState({ kind: 'no-access' });
      if (!isWebUrl(tab.url)) {
        return setState({ kind: 'not-web', localFile: tab.url.protocol === 'file:' });
      }
      const url = tab.url;
      setState({ kind: 'web', tabId: tab.id, url, scan: null, scanned: false });
      const scan = await scanTab(tab.id);
      if (active) setState({ kind: 'web', tabId: tab.id, url, scan, scanned: true });
    })();
    return () => {
      active = false;
    };
  }, [version]);

  useEffect(() => {
    // Follow the tab in front. Without the "tabs" permission Chrome only says
    // which tab changed, and shows its address only after a toolbar click.
    const onActivated = () => {
      setNotice(null);
      refresh();
    };
    const onUpdated = (_id: number, change: { status?: string }) => {
      if (change.status === 'complete') refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  const open = (url: string) => {
    setNotice(null);
    void openInEditor(url).then((response) => {
      if (!response.ok) setNotice({ tone: 'danger', text: 'The editor could not be opened.' });
    });
  };

  const download = (url: string) => {
    setNotice(null);
    // Straight from the click: Chrome asks for the downloads permission once.
    void downloadWithChrome(url).then((outcome) => {
      if (outcome === 'denied') {
        setNotice({
          tone: 'info',
          text: 'Downloading needs the downloads permission. Nothing was saved.',
        });
      } else if (outcome === 'failed') {
        setNotice({ tone: 'danger', text: 'Chrome could not start the download.' });
      }
    });
  };

  const print = (tabId: number) => {
    setNotice(null);
    void printTab(tabId).then((printed) => {
      if (!printed) {
        setNotice({
          tone: 'info',
          text: 'Chrome doesn’t let extensions print this page. Press Ctrl+P (⌘P on a Mac) to print it yourself.',
        });
      }
    });
  };

  let body;
  if (state.kind === 'loading') {
    body = null;
  } else if (state.kind === 'no-access') {
    body = (
      <p className="text-xs text-ink-muted">
        To use Folio with the page in this tab, click Folio’s button in Chrome’s toolbar while the
        page is open. Folio cannot see your other tabs.
      </p>
    );
  } else if (state.kind === 'not-web') {
    body = (
      <p className="text-xs text-ink-muted">
        {state.localFile
          ? 'Chrome doesn’t let extensions read files from your computer. To use this one, choose it below.'
          : 'Folio works with web pages whose address starts with https:// or http://.'}
      </p>
    );
  } else {
    const { url, scan, scanned, tabId } = state;
    const isPdf = looksLikePdfUrl(url) || scan?.contentType === 'application/pdf';
    // Chrome may not let Folio look at a tab showing a PDF (its viewer).
    const unreadable = scanned && scan === null;
    body = (
      <>
        <p className="truncate text-xs text-ink-muted" title={url.href}>
          {url.hostname}
        </p>
        {isPdf || unreadable ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => open(url.href)}>
              <ExternalLink size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
              {isPdf ? 'Open this PDF' : 'Open this tab in Folio'}
            </Button>
            <Button size="sm" onClick={() => download(url.href)}>
              <Download size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
              Download
            </Button>
          </div>
        ) : null}
        {scan && scan.links.length > 0 ? (
          <ul aria-label="PDFs on this page" className="mt-3 flex flex-col gap-1">
            {scan.links.map((link) => {
              const label = link.text || describeLink(link.url);
              return (
                <li
                  key={link.url}
                  className="flex items-center gap-2 rounded-md bg-bg px-2 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{label}</span>
                    <span className="block truncate text-ink-muted" title={link.url}>
                      {new URL(link.url).hostname} · {describeLink(link.url)}
                    </span>
                  </span>
                  <Button size="sm" onClick={() => open(link.url)} aria-label={`Open ${label}`}>
                    Open
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => download(link.url)}
                    aria-label={`Download ${label}`}
                  >
                    <Download size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-muted">
            {!scanned
              ? ''
              : scan === null
                ? 'Chrome doesn’t let Folio look at this page. If it shows a PDF, Folio can still open or download it.'
                : isPdf
                  ? ''
                  : 'No links to PDFs on this page.'}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => print(tabId)}>
            <Printer size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
            Save page as PDF
          </Button>
          <Button size="sm" variant="ghost" onClick={refresh}>
            <RefreshCw size={ICON.sm} strokeWidth={ICON.stroke} aria-hidden />
            Look again
          </Button>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="this-tab-title" className="rounded-lg border border-line p-3">
      <h2 id="this-tab-title" className="text-sm font-semibold">
        This tab
      </h2>
      <div className="mt-1">{body}</div>
      {notice ? (
        <p
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={
            notice.tone === 'danger'
              ? 'mt-2 text-xs text-danger-ink'
              : 'mt-2 text-xs text-ink-muted'
          }
        >
          {notice.text}
        </p>
      ) : null}
    </section>
  );
}
