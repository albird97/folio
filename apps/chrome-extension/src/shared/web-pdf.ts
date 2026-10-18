import { OpenUrlError, type OpenUrlErrorCode } from '@folio/platform-adapters';
import { z } from 'zod';
import { takeHandoff } from './handoff';

/**
 * Opening PDFs from the web. Pages ask the service worker, over a port, to
 * download a URL; it hands the bytes back through the single-use hand-off
 * store. Pages themselves cannot reach other servers (their CSP), and the
 * worker only fetches sites the user gave Folio access to.
 */
export const FETCH_PORT = 'folio-fetch-pdf';

/**
 * Web addresses waiting for a new editor tab to open them, in session
 * storage (gone when the browser closes), so the address never shows in the
 * tab's URL or history.
 */
export const OPEN_URL_JOB_PREFIX = 'open-url:';

/** Only web addresses; `file:`, `chrome:`, `data:` and others are refused. */
export function parseWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OpenUrlError('blocked', 'That is not a web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OpenUrlError(
      'blocked',
      'Folio can only open web addresses that start with https:// or http://.',
    );
  }
  if (url.username || url.password) {
    throw new OpenUrlError('blocked', 'Addresses with a user name or password are not opened.');
  }
  url.hash = '';
  return url;
}

/** The host permission pattern that covers a URL: `https://example.com/*`. */
export const originPattern = (url: URL) => `${url.protocol}//${url.hostname}/*`;

const errorCodes = [
  'permission-denied',
  'auth-required',
  'not-found',
  'not-a-pdf',
  'too-large',
  'network',
  'blocked',
] as const satisfies readonly OpenUrlErrorCode[];

export const fetchRequestSchema = z.object({
  type: z.literal('start'),
  url: z.string().min(1).max(4096),
  withCredentials: z.boolean(),
});
export type FetchRequest = z.infer<typeof fetchRequestSchema>;

export const fetchReplySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    received: z.number().int().nonnegative(),
    total: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal('done'),
    handoffId: z.string().regex(/^[0-9a-f]{32}$/),
  }),
  z.object({
    type: z.literal('error'),
    code: z.enum(errorCodes),
    message: z.string().max(500),
  }),
]);
export type FetchReply = z.infer<typeof fetchReplySchema>;

export interface DownloadOptions {
  withCredentials?: boolean;
  onProgress?(received: number, total: number | null): void;
  signal?: AbortSignal;
}

/** Downloads a PDF through the service worker. The caller has checked access already. */
export function downloadPdf(
  url: string,
  options: DownloadOptions = {},
): Promise<{ name: string; bytes: Uint8Array }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('The download was cancelled.', 'AbortError'));
      return;
    }
    const port = chrome.runtime.connect({ name: FETCH_PORT });
    let settled = false;
    /** The bytes are on their way out of the hand-off store; a disconnect no longer matters. */
    let collecting = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
      finish();
    };
    const onAbort = () =>
      settle(() => reject(new DOMException('The download was cancelled.', 'AbortError')));
    options.signal?.addEventListener('abort', onAbort);

    port.onMessage.addListener((raw: unknown) => {
      const reply = fetchReplySchema.safeParse(raw);
      if (!reply.success || settled) return;
      const message = reply.data;
      if (message.type === 'progress') {
        options.onProgress?.(message.received, message.total);
      } else if (message.type === 'error') {
        settle(() => reject(new OpenUrlError(message.code, message.message)));
      } else {
        collecting = true;
        void takeHandoff(message.handoffId).then(
          (record) =>
            settle(() =>
              record
                ? resolve({ name: record.name, bytes: new Uint8Array(record.bytes) })
                : reject(new OpenUrlError('network', 'The downloaded file was lost. Try again.')),
            ),
          () =>
            settle(() =>
              reject(new OpenUrlError('network', 'The downloaded file could not be read.')),
            ),
        );
      }
    });
    port.onDisconnect.addListener(() => {
      if (collecting) return;
      settle(() => reject(new OpenUrlError('network', 'The download stopped. Try again.')));
    });
    port.postMessage({
      type: 'start',
      url,
      withCredentials: options.withCredentials ?? false,
    } satisfies FetchRequest);
  });
}
