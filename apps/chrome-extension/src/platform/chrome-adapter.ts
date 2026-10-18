import {
  createWebPlatformAdapter,
  OpenUrlError,
  WEB_FEATURES,
  type IncomingFile,
  type OpenUrlOptions,
  type PlatformAdapter,
  type RuntimeFeatures,
} from '@folio/platform-adapters';
import { createChromeStorage } from '../shared/chrome-storage';
import { downloadPdf, originPattern, parseWebUrl } from '../shared/web-pdf';

/** What the extension supports today. Checked against the capability matrix in tests. */
export const CHROME_FEATURES: RuntimeFeatures = {
  ...WEB_FEATURES,
  webDragAndDrop: true,
  clipboardWrite: true,
  openFromUrl: true,
  browserTabIntegration: true,
};

/**
 * Opens a PDF from the web. With `ask`, Folio asks for access to the site
 * if it has none (this must run straight from a click); without, it only
 * uses access granted earlier, e.g. from the toolbar popup.
 */
export async function openWebPdf(
  raw: string,
  options: OpenUrlOptions & { ask: boolean },
): Promise<IncomingFile> {
  const url = parseWebUrl(raw);
  const origins = [originPattern(url)];
  // `request` comes first, while the click still counts as a user gesture; it
  // answers at once, without a prompt, for sites Folio may already read.
  const allowed = options.ask
    ? await chrome.permissions.request({ origins })
    : await chrome.permissions.contains({ origins });
  if (!allowed) {
    throw new OpenUrlError(
      'permission-denied',
      `Folio was not given access to ${url.hostname}, so nothing was downloaded.`,
    );
  }
  const { name, bytes } = await downloadPdf(url.href, {
    withCredentials: options.withCredentials ?? false,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    name,
    size: bytes.byteLength,
    origin: { kind: 'url', url: url.href },
    read: async () => bytes,
  };
}

export function createChromePlatformAdapter(): PlatformAdapter & {
  deliverFiles: ReturnType<typeof createWebPlatformAdapter>['deliverFiles'];
} {
  return {
    ...createWebPlatformAdapter({
      platform: 'chrome-extension',
      features: CHROME_FEATURES,
      storage: createChromeStorage(),
    }),
    openUrl: (url, options = {}) => openWebPdf(url, { ...options, ask: true }),
  };
}
