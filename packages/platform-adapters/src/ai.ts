import type { AiService } from './types';

/**
 * Ask Claude (opt-in, with the user's own Anthropic API key). These are the
 * rules every platform's transport applies before anything leaves the
 * device: one fixed origin, two endpoints, `POST` only, JSON bodies of a
 * bounded size and an allow-list of request headers. The desktop app's Rust
 * proxy (`ai.rs`) and the extension's service worker check them again on
 * their side, because the page is the part a malicious PDF could subvert.
 */
export const AI_API_ORIGIN = 'https://api.anthropic.com';

/** The extension's host permission for {@link AI_API_ORIGIN}. */
export const AI_HOST_PERMISSION = `${AI_API_ORIGIN}/*`;

/** Messages (answers) and token counting; the SDK adds `?beta=true` for beta features. */
const AI_API_PATHS: readonly string[] = ['/v1/messages', '/v1/messages/count_tokens'];

/**
 * Request headers that reach Anthropic. Everything else the SDK sends (its
 * user agent and platform details, retry counters) is dropped, and the key
 * is added by the platform, never by the page.
 */
const AI_REQUEST_HEADERS: readonly string[] = [
  'anthropic-version',
  'anthropic-beta',
  'content-type',
];

/** Response headers handed back to the SDK: the body's type and its retry hints. */
export const AI_RESPONSE_HEADERS: readonly string[] = [
  'content-type',
  'request-id',
  'retry-after',
  'retry-after-ms',
  'x-should-retry',
];

/** Anthropic's own request size limit (32 MB). */
export const AI_MAX_BODY_BYTES = 32 * 1024 * 1024;

export type AiTransportErrorCode =
  /** Text that cannot be an API key. */
  | 'invalid-key'
  /** No key is stored (it was forgotten meanwhile). */
  | 'no-key'
  /** The extension may no longer reach Anthropic's API (access was removed). */
  | 'no-access'
  /** A request outside the allow-list. */
  | 'blocked'
  /** The key could not be stored or read (the OS credential store failed). */
  | 'storage'
  | 'too-large'
  | 'network';

/** A request the transport refused or could not carry. Messages never contain document text. */
export class AiTransportError extends Error {
  override readonly name = 'AiTransportError';
  constructor(
    readonly code: AiTransportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A request as the platform sends it on: path (with query), allowed headers, JSON body. */
export interface AiRequest {
  /** `/v1/messages` or `/v1/messages/count_tokens`, optionally with `?beta=true`. */
  path: string;
  headers: Array<[string, string]>;
  body: string;
}

/** Whether a path (with its query) is one Folio may call. */
export function isAllowedAiPath(path: string): boolean {
  const [pathname = '', query, ...rest] = path.split('?');
  return (
    rest.length === 0 &&
    AI_API_PATHS.includes(pathname) &&
    (query === undefined || query === 'beta=true')
  );
}

const blocked = () => new AiTransportError('blocked', 'Folio does not send this request.');

/** A printable ASCII header value of reasonable length (no line breaks). */
const isSafeHeaderValue = (value: string) => /^[\x20-\x7e]{1,1024}$/.test(value);

/**
 * Checks a request the SDK is about to make and keeps only what may be
 * sent. Throws {@link AiTransportError} for anything outside the rules.
 */
export function toAiRequest(input: string | URL | Request, init: RequestInit = {}): AiRequest {
  // The SDK always passes a URL string and a plain body; a Request object
  // (whose body could be a stream) is not expected and not accepted.
  if (input instanceof Request) throw blocked();
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw blocked();
  }
  const path = `${url.pathname}${url.search}`;
  if (
    url.origin !== AI_API_ORIGIN ||
    url.username ||
    url.password ||
    url.hash ||
    (init.method ?? 'GET').toUpperCase() !== 'POST' ||
    !isAllowedAiPath(path)
  ) {
    throw blocked();
  }
  if (typeof init.body !== 'string') throw blocked();
  // UTF-8 takes at most 3 bytes per UTF-16 unit; only measure when it matters.
  if (
    init.body.length * 3 > AI_MAX_BODY_BYTES &&
    new TextEncoder().encode(init.body).byteLength > AI_MAX_BODY_BYTES
  ) {
    throw new AiTransportError('too-large', 'The request is too large to send.');
  }
  const source = new Headers(init.headers);
  const headers: Array<[string, string]> = [];
  for (const name of AI_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value === null) continue;
    if (!isSafeHeaderValue(value)) throw blocked();
    headers.push([name, value]);
  }
  if (!/^application\/json\b/i.test(source.get('content-type') ?? '')) throw blocked();
  return { path, headers, body: init.body };
}

/**
 * What an API key can look like: Anthropic's keys are long strings of
 * letters, digits, `-` and `_` (`sk-ant-…`). Returns the trimmed key, or
 * null for anything else (so it never reaches a header or the keychain).
 */
export function normalizeAiKey(raw: string): string | null {
  const key = raw.trim();
  return /^[A-Za-z0-9_-]{16,512}$/.test(key) ? key : null;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const abortError = () => new DOMException('The request was cancelled.', 'AbortError');

/**
 * Turns an answer that a platform relays in parts (status and headers, then
 * chunks of the body) into a streaming `Response`, the way `fetch` resolves
 * as soon as the headers arrive. `cancel` runs once when the caller aborts
 * or stops reading, so the platform can stop the request too.
 */
export function createResponseRelay(signal: AbortSignal | null | undefined, cancel: () => void) {
  let resolveResponse!: (response: Response) => void;
  let rejectResponse!: (error: unknown) => void;
  const response = new Promise<Response>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  let body: ReadableStreamDefaultController<Uint8Array> | null = null;
  let state: 'waiting' | 'streaming' | 'finished' = 'waiting';
  let cancelled = false;
  const stop = () => {
    if (cancelled) return;
    cancelled = true;
    signal?.removeEventListener('abort', onAbort);
    cancel();
  };
  const fail = (error: unknown) => {
    if (state === 'waiting') rejectResponse(error);
    else if (state === 'streaming') body?.error(error);
    state = 'finished';
  };
  const onAbort = () => {
    fail(abortError());
    stop();
  };
  if (signal?.aborted) {
    state = 'finished';
    cancelled = true;
    rejectResponse(abortError());
  } else {
    signal?.addEventListener('abort', onAbort);
  }
  return {
    response,
    head(status: number, headers: Iterable<[string, string]>) {
      if (state !== 'waiting') return;
      const allowed = [...headers].filter(([name]) =>
        AI_RESPONSE_HEADERS.includes(name.toLowerCase()),
      );
      if (NULL_BODY_STATUSES.has(status) || status < 200 || status > 599) {
        state = 'finished';
        stop();
        rejectResponse(new AiTransportError('network', 'Anthropic’s answer could not be read.'));
        return;
      }
      state = 'streaming';
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          body = controller;
        },
        // The SDK stops reading (an abort, or an answer it no longer wants).
        cancel: () => {
          state = 'finished';
          stop();
        },
      });
      resolveResponse(new Response(stream, { status, headers: allowed }));
    },
    chunk(bytes: Uint8Array) {
      if (state === 'streaming') body?.enqueue(bytes);
    },
    end() {
      if (state === 'streaming') body?.close();
      else if (state === 'waiting') {
        rejectResponse(new AiTransportError('network', 'Anthropic’s answer ended early.'));
      }
      state = 'finished';
      signal?.removeEventListener('abort', onAbort);
      cancelled = true;
    },
    fail(error: AiTransportError) {
      fail(error);
      signal?.removeEventListener('abort', onAbort);
      cancelled = true;
    },
  };
}

/**
 * The web adapter's transport, for development and UI tests only: the key
 * lives in this page's memory (it is gone on reload) and the page calls
 * Anthropic's API directly, which browsers allow only with the API's
 * explicit opt-in header for browser access.
 */
export function createMemoryAiService(
  send: typeof fetch = (input, init) => globalThis.fetch(input, init),
): AiService {
  let key: string | null = null;
  return {
    hasKey: async () => key !== null,
    async setKey(raw) {
      const normalized = normalizeAiKey(raw);
      if (!normalized) throw new AiTransportError('invalid-key', 'That is not an API key.');
      key = normalized;
      return true;
    },
    async forgetKey() {
      key = null;
    },
    async fetch(input, init) {
      const request = toAiRequest(input, init);
      if (key === null) throw new AiTransportError('no-key', 'No API key is stored.');
      return send(`${AI_API_ORIGIN}${request.path}`, {
        method: 'POST',
        headers: [
          ...request.headers,
          ['x-api-key', key],
          ['anthropic-dangerous-direct-browser-access', 'true'],
        ],
        body: request.body,
        signal: init?.signal ?? null,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    },
  };
}
