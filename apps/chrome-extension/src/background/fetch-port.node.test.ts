import { OpenUrlError } from '@folio/platform-adapters';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveFetchPort, type FetchPortDeps } from './fetch-port';
import type { FetchPdfOptions } from './fetch-pdf';

function fakePort() {
  const messages: Array<(message: unknown) => void> = [];
  const disconnects: Array<() => void> = [];
  const port = {
    name: 'folio-fetch-pdf',
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

const PDF = new TextEncoder().encode('%PDF-1.7 tiny');

function deps(overrides: Partial<FetchPortDeps> = {}): FetchPortDeps {
  return {
    fetchPdf: vi.fn(async () => ({ name: 'a.pdf', bytes: PDF })),
    putHandoff: vi.fn(async () => 'f'.repeat(32)),
    deleteHandoff: vi.fn(async () => undefined),
    hasAccess: async () => true,
    keepAlive: vi.fn(),
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('download port', () => {
  it('downloads once and hands the file over', async () => {
    const { port, posted, send } = fakePort();
    const services = deps();
    serveFetchPort(port, services);
    send({ type: 'start', url: 'https://example.com/a.pdf', withCredentials: false });
    await flush();
    expect(services.fetchPdf).toHaveBeenCalledWith(
      'https://example.com/a.pdf',
      expect.objectContaining({ withCredentials: false }),
    );
    expect(services.putHandoff).toHaveBeenCalledWith('a.pdf', PDF);
    expect(posted).toHaveBeenLastCalledWith({ type: 'done', handoffId: 'f'.repeat(32) });

    // One download per port.
    send({ type: 'start', url: 'https://example.com/b.pdf', withCredentials: false });
    expect(posted).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'error', code: 'blocked' }),
    );
    expect(services.fetchPdf).toHaveBeenCalledOnce();
  });

  it('refuses malformed requests', () => {
    const { port, posted, send } = fakePort();
    const services = deps();
    serveFetchPort(port, services);
    send({ type: 'start', url: 'x'.repeat(5000), withCredentials: false });
    send({ type: 'start', url: 'https://example.com', withCredentials: 'yes' });
    expect(posted).toHaveBeenCalledTimes(2);
    expect(services.fetchPdf).not.toHaveBeenCalled();
  });

  it('reports download errors with their reason', async () => {
    const { port, posted, send } = fakePort();
    serveFetchPort(
      port,
      deps({
        fetchPdf: vi.fn(async () => {
          throw new OpenUrlError('auth-required', 'example.com needs you to be signed in.');
        }),
      }),
    );
    send({ type: 'start', url: 'https://example.com/a.pdf', withCredentials: false });
    await flush();
    expect(posted).toHaveBeenLastCalledWith({
      type: 'error',
      code: 'auth-required',
      message: 'example.com needs you to be signed in.',
    });
  });

  it('cancels when the page leaves and deletes a file nobody collects', async () => {
    const { port, posted, send, disconnect } = fakePort();
    let finish!: () => void;
    let signal!: AbortSignal;
    const services = deps({
      fetchPdf: vi.fn(
        (_url: string, options: FetchPdfOptions) =>
          new Promise<{ name: string; bytes: Uint8Array }>((resolve) => {
            signal = options.signal!;
            finish = () => resolve({ name: 'a.pdf', bytes: PDF });
          }),
      ),
      putHandoff: vi.fn(async () => {
        disconnect();
        return 'e'.repeat(32);
      }),
    });
    serveFetchPort(port, services);
    send({ type: 'start', url: 'https://example.com/a.pdf', withCredentials: false });
    expect(signal.aborted).toBe(false);
    finish();
    await flush();
    expect(signal.aborted).toBe(true);
    expect(services.deleteHandoff).toHaveBeenCalledWith('e'.repeat(32));
    expect(posted).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('keeps the worker alive while downloading', async () => {
    vi.useFakeTimers();
    const { port, send } = fakePort();
    let finish!: () => void;
    const services = deps({
      fetchPdf: vi.fn(
        () =>
          new Promise<{ name: string; bytes: Uint8Array }>((resolve) => {
            finish = () => resolve({ name: 'a.pdf', bytes: PDF });
          }),
      ),
    });
    serveFetchPort(port, services);
    send({ type: 'start', url: 'https://example.com/a.pdf', withCredentials: false });
    vi.advanceTimersByTime(65_000);
    expect(services.keepAlive).toHaveBeenCalledTimes(3);
    finish();
    await vi.runAllTimersAsync();
    vi.advanceTimersByTime(60_000);
    expect(services.keepAlive).toHaveBeenCalledTimes(3);
  });
});
