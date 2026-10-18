import { OpenUrlError } from '@folio/platform-adapters';
import { putHandoff, deleteHandoff } from '../shared/handoff';
import { fetchRequestSchema, type FetchReply } from '../shared/web-pdf';
import { fetchPdf, type FetchPdfOptions } from './fetch-pdf';

/** Progress is reported at most this often. */
const PROGRESS_INTERVAL_MS = 250;
/**
 * Chrome stops an idle service worker after 30 seconds, and a download in
 * progress does not count as activity; an extension API call does.
 */
const KEEP_ALIVE_MS = 20_000;

export interface FetchPortDeps {
  fetchPdf: typeof fetchPdf;
  putHandoff: typeof putHandoff;
  deleteHandoff: typeof deleteHandoff;
  hasAccess: FetchPdfOptions['hasAccess'];
  keepAlive(): void;
}

const defaultDeps = (): FetchPortDeps => ({
  fetchPdf,
  putHandoff,
  deleteHandoff,
  hasAccess: (origin) => chrome.permissions.contains({ origins: [origin] }),
  keepAlive: () => void chrome.runtime.getPlatformInfo(),
});

/**
 * Serves one download for a page: a single `start` request, then progress
 * and a hand-off id (or an error). The page disconnecting cancels it, and
 * a finished download nobody collects is deleted.
 */
export function serveFetchPort(port: chrome.runtime.Port, deps: FetchPortDeps = defaultDeps()) {
  const controller = new AbortController();
  let started = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const post = (reply: FetchReply) => {
    try {
      port.postMessage(reply);
    } catch {
      // The page went away.
    }
  };
  const stop = () => {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
  };
  port.onDisconnect.addListener(() => {
    controller.abort();
    stop();
  });
  port.onMessage.addListener((raw: unknown) => {
    const request = fetchRequestSchema.safeParse(raw);
    if (started || !request.success) {
      post({ type: 'error', code: 'blocked', message: 'The request was not understood.' });
      return;
    }
    started = true;
    keepAlive = setInterval(deps.keepAlive, KEEP_ALIVE_MS);
    let reported = 0;
    void deps
      .fetchPdf(request.data.url, {
        withCredentials: request.data.withCredentials,
        signal: controller.signal,
        hasAccess: deps.hasAccess,
        onProgress: (received, total) => {
          const now = Date.now();
          if (now - reported < PROGRESS_INTERVAL_MS) return;
          reported = now;
          post({ type: 'progress', received, total });
        },
      })
      .then(
        async ({ name, bytes }) => {
          if (controller.signal.aborted) return;
          const handoffId = await deps.putHandoff(name, bytes);
          // The page left while the file was stored: nobody will collect it.
          if (controller.signal.aborted) {
            await deps.deleteHandoff(handoffId);
            return;
          }
          post({ type: 'done', handoffId });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          post(
            error instanceof OpenUrlError
              ? { type: 'error', code: error.code, message: error.message }
              : { type: 'error', code: 'network', message: 'The download failed. Try again.' },
          );
        },
      )
      .catch(() =>
        post({
          type: 'error',
          code: 'network',
          message: 'The file could not be kept for opening.',
        }),
      )
      .finally(stop);
  });
}
