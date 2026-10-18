import { z } from './zod';
import { sendMessage } from './messages';

/**
 * Tools for the tab the user clicked Folio's toolbar button on. Chrome's
 * activeTab permission lets Folio see that tab's address and run a script in
 * it until the tab navigates; nothing here touches any other tab. The
 * scripts are Folio's own and only read the page.
 */

export interface PageScan {
  /** The page's MIME type; Chrome's PDF viewer reports application/pdf. */
  contentType: string;
  links: Array<{ url: string; text: string }>;
}

const MAX_LINKS = 50;

/** What a scan may return; the page controls the content, so it is checked. */
export const pageScanSchema = z.object({
  contentType: z.string().max(200),
  links: z
    .array(z.object({ url: z.string().url().max(4096), text: z.string().max(200) }))
    .max(MAX_LINKS),
});

/**
 * Runs inside the page (Chrome serializes it, so it must not use anything
 * from outside): lists links and embeds that point to PDFs.
 */
export function scanPageForPdfs(): PageScan {
  const limit = 50;
  const seen = new Set<string>();
  const links: Array<{ url: string; text: string }> = [];
  const add = (raw: string | null, text: string) => {
    if (!raw || links.length >= limit) return;
    try {
      const url = new URL(raw, document.baseURI);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
      if (url.username || url.password) return;
      url.hash = '';
      if (!/\.pdf$/i.test(url.pathname) || url.href.length > 4096 || seen.has(url.href)) return;
      seen.add(url.href);
      links.push({ url: url.href, text: text.replace(/\s+/g, ' ').trim().slice(0, 200) });
    } catch {
      // Not a URL.
    }
  };
  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    add(anchor.getAttribute('href'), anchor.textContent ?? '');
  }
  for (const element of Array.from(
    document.querySelectorAll('embed[src], iframe[src], object[data]'),
  )) {
    add(element.getAttribute('src') ?? element.getAttribute('data'), '');
  }
  return { contentType: document.contentType, links };
}

/** Scans a tab, or null where Chrome does not allow it (its own pages, the Web Store, PDF viewer). */
export async function scanTab(tabId: number): Promise<PageScan | null> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scanPageForPdfs,
    });
    const parsed = pageScanSchema.safeParse(result?.result);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Opens Chrome's print dialog for the tab, where "Save as PDF" is a
 * destination. Resolves false where Chrome does not let extensions run
 * scripts (its own pages, the Web Store).
 */
export async function printTab(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.print();
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Opens a PDF address in a new editor tab, which asks for access to the site if needed. */
export function openInEditor(url: string) {
  return sendMessage({ type: 'editor/open-url', url });
}

export type DownloadOutcome = 'started' | 'denied' | 'failed';

/**
 * Saves the file at a URL with Chrome's downloads, which use the browser's
 * own sign-in for the site. Asks for the downloads permission the first
 * time; call it straight from a click.
 */
export async function downloadWithChrome(url: string): Promise<DownloadOutcome> {
  const granted = await chrome.permissions.request({ permissions: ['downloads'] });
  if (!granted) return 'denied';
  try {
    await chrome.downloads.download({ url, saveAs: true });
    return 'started';
  } catch {
    return 'failed';
  }
}

export const looksLikePdfUrl = (url: URL) => /\.pdf$/i.test(url.pathname);

export interface ActiveTab {
  id: number;
  /** Null when Chrome does not show Folio the address (no toolbar click on this tab yet). */
  url: URL | null;
}

/** The tab in front, with its address when Folio may see it. */
export async function activeTab(): Promise<ActiveTab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  let url: URL | null = null;
  try {
    url = tab.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }
  return { id: tab.id, url };
}

export const isWebUrl = (url: URL): boolean =>
  url.protocol === 'https:' || url.protocol === 'http:';
