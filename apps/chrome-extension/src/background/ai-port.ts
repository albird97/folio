import {
  AI_API_ORIGIN,
  AI_HOST_PERMISSION,
  AI_RESPONSE_HEADERS,
  AiTransportError,
  normalizeAiKey,
  toAiRequest,
} from '@folio/platform-adapters';
import { AI_KEY_STORAGE, aiStartSchema, type AiReply } from '../shared/ai';

/**
 * Chrome stops an idle service worker after 30 seconds, and an answer
 * streaming in does not count as activity; an extension API call does.
 */
const KEEP_ALIVE_MS = 20_000;

type ReplyCode = Extract<AiReply, { type: 'error' }>['code'];

/** Errors the page is told about by their reason; anything else is "blocked". */
const REPLY_CODES = new Map<string, ReplyCode>(
  (['no-key', 'no-access', 'blocked', 'too-large', 'network'] as const).map((code) => [code, code]),
);

export interface AiPortDeps {
  fetch: typeof fetch;
  readKey(): Promise<string | null>;
  hasAccess(): Promise<boolean>;
  keepAlive(): void;
}

/** The stored key, if it still looks like one. */
export async function readAiKey(): Promise<string | null> {
  const stored = (await chrome.storage.local.get(AI_KEY_STORAGE))[AI_KEY_STORAGE];
  return typeof stored === 'string' ? normalizeAiKey(stored) : null;
}

const defaultDeps = (): AiPortDeps => ({
  fetch: (input, init) => globalThis.fetch(input, init),
  readKey: readAiKey,
  hasAccess: () => chrome.permissions.contains({ origins: [AI_HOST_PERMISSION] }),
  keepAlive: () => void chrome.runtime.getPlatformInfo(),
});

/**
 * Serves one request to Anthropic's API for a page: a single `start`
 * message, checked again here against the same rules as on the page, then
 * the answer's head, its body as text chunks, and the end (or an error).
 * The key is added here; the page disconnecting cancels the request.
 */
export function serveAiPort(port: chrome.runtime.Port, deps: AiPortDeps = defaultDeps()) {
  const controller = new AbortController();
  let started = false;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const post = (reply: AiReply) => {
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

  const run = async (path: string, init: RequestInit) => {
    const request = toAiRequest(`${AI_API_ORIGIN}${path}`, init);
    const key = await deps.readKey();
    if (!key) throw new AiTransportError('no-key', 'No API key is stored.');
    if (!(await deps.hasAccess())) {
      throw new AiTransportError('no-access', 'Folio may not connect to Anthropic’s API.');
    }
    let response: Response;
    try {
      response = await deps.fetch(`${AI_API_ORIGIN}${request.path}`, {
        method: 'POST',
        headers: [
          ...request.headers,
          ['x-api-key', key],
          // Anthropic's opt-in for calls from a browser with the user's own key.
          ['anthropic-dangerous-direct-browser-access', 'true'],
        ],
        body: request.body,
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    } catch {
      throw new AiTransportError('network', 'Folio could not reach Anthropic.');
    }
    if (controller.signal.aborted) return;
    post({
      type: 'head',
      status: response.status,
      headers: [...response.headers].filter(([name]) => AI_RESPONSE_HEADERS.includes(name)),
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) break;
        const data = decoder.decode(value, { stream: true });
        if (data) post({ type: 'chunk', data });
      }
    } catch {
      if (!controller.signal.aborted) {
        post({ type: 'error', code: 'network', message: 'The answer stopped part-way.' });
      }
      return;
    }
    const rest = decoder.decode();
    if (rest) post({ type: 'chunk', data: rest });
    post({ type: 'end' });
  };

  port.onMessage.addListener((raw: unknown) => {
    const message = aiStartSchema.safeParse(raw);
    if (started || !message.success) {
      post({ type: 'error', code: 'blocked', message: 'Folio does not send this request.' });
      return;
    }
    started = true;
    keepAlive = setInterval(deps.keepAlive, KEEP_ALIVE_MS);
    const { path, headers, body } = message.data;
    void run(path, { method: 'POST', headers, body })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const code = error instanceof AiTransportError ? REPLY_CODES.get(error.code) : undefined;
        post(
          code && error instanceof AiTransportError
            ? { type: 'error', code, message: error.message }
            : { type: 'error', code: 'blocked', message: 'Folio does not send this request.' },
        );
      })
      .finally(stop);
  });
}
