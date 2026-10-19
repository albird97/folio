import { describe, expect, it, vi } from 'vitest';
import { serveAiPort, type AiPortDeps } from './ai-port';

const KEY = 'sk-ant-api03-test-key-0123456789';

function fakePort() {
  const messages: Array<(message: unknown) => void> = [];
  const disconnects: Array<() => void> = [];
  const port = {
    name: 'folio-ai',
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: (message: unknown) => void) => messages.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
  };
  return {
    port: port as unknown as chrome.runtime.Port,
    posted: port.postMessage,
    send: (message: unknown) => messages.forEach((listener) => listener(message)),
    disconnect: () => disconnects.forEach((listener) => listener()),
  };
}

/** A body the test writes to, as a server streams it. */
function streamedBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (value) => void (controller = value) });
  return {
    body,
    push: (bytes: Uint8Array) => controller.enqueue(bytes),
    close: () => controller.close(),
    fail: (error: unknown) => controller.error(error),
  };
}

function deps(overrides: Partial<AiPortDeps> = {}): AiPortDeps {
  return {
    fetch: vi.fn(
      async () => new Response('', { headers: { 'content-type': 'text/event-stream' } }),
    ),
    readKey: async () => KEY,
    hasAccess: async () => true,
    keepAlive: vi.fn(),
    ...overrides,
  };
}

const START = {
  type: 'start',
  path: '/v1/messages?beta=true',
  headers: [
    ['anthropic-version', '2023-06-01'],
    ['content-type', 'application/json'],
  ],
  body: '{"stream":true}',
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Ask Claude port', () => {
  it('sends the request with the key and relays the answer as it arrives', async () => {
    const { port, posted, send } = fakePort();
    const stream = streamedBody();
    const services = deps({
      fetch: vi.fn(
        async () =>
          new Response(stream.body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'request-id': 'req_1', 'x-other': '1' },
          }),
      ),
    });
    serveAiPort(port, services);
    send(START);
    await flush();
    expect(services.fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages?beta=true',
      expect.objectContaining({
        method: 'POST',
        body: '{"stream":true}',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: [
          ['anthropic-version', '2023-06-01'],
          ['content-type', 'application/json'],
          ['x-api-key', KEY],
          ['anthropic-dangerous-direct-browser-access', 'true'],
        ],
      }),
    );
    expect(posted).toHaveBeenLastCalledWith({
      type: 'head',
      status: 200,
      headers: [
        ['content-type', 'text/event-stream'],
        ['request-id', 'req_1'],
      ],
    });
    // "é" split between two network chunks still arrives whole.
    const text = new TextEncoder().encode('data: é\n\n');
    stream.push(text.slice(0, 7));
    await flush();
    expect(posted).toHaveBeenLastCalledWith({ type: 'chunk', data: 'data: ' });
    stream.push(text.slice(7));
    stream.close();
    await flush();
    expect(posted.mock.calls.slice(-2)).toEqual([
      [{ type: 'chunk', data: 'é\n\n' }],
      [{ type: 'end' }],
    ]);
  });

  it('refuses requests outside the rules, and more than one per port', async () => {
    for (const message of [
      { ...START, path: '/v1/files' },
      { ...START, path: '/v1/messages?beta=true&x=1' },
      { ...START, headers: [['anthropic-version', '2023-06-01']] },
      { ...START, headers: Array.from({ length: 9 }, () => ['content-type', 'application/json']) },
      { ...START, body: 42 },
      { type: 'other' },
    ]) {
      const { port, posted, send } = fakePort();
      const services = deps();
      serveAiPort(port, services);
      send(message);
      await flush();
      expect(posted, JSON.stringify(message).slice(0, 80)).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'error', code: 'blocked' }),
      );
      expect(services.fetch).not.toHaveBeenCalled();
    }
    const { port, posted, send } = fakePort();
    const services = deps();
    serveAiPort(port, services);
    send(START);
    send(START);
    await flush();
    expect(services.fetch).toHaveBeenCalledOnce();
    expect(posted).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', code: 'blocked' }),
    );
  });

  it('says why when there is no key, no access or no connection', async () => {
    const cases: Array<[Partial<AiPortDeps>, string]> = [
      [{ readKey: async () => null }, 'no-key'],
      [{ hasAccess: async () => false }, 'no-access'],
      [{ fetch: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) }, 'network'],
    ];
    for (const [overrides, code] of cases) {
      const { port, posted, send } = fakePort();
      serveAiPort(port, deps(overrides));
      send(START);
      await flush();
      expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', code }));
    }
  });

  it('cancels the request when the page disconnects', async () => {
    const { port, posted, send, disconnect } = fakePort();
    const stream = streamedBody();
    let signal: AbortSignal | null | undefined;
    serveAiPort(
      port,
      deps({
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal;
          // As with `fetch`, aborting ends the body with an error.
          signal?.addEventListener('abort', () =>
            stream.fail(new DOMException('The request was cancelled.', 'AbortError')),
          );
          return new Response(stream.body);
        }),
      }),
    );
    send(START);
    await flush();
    const before = posted.mock.calls.length;
    disconnect();
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(posted.mock.calls.length).toBe(before);
  });
});
