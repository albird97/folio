import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendToDesktop } from './desktop';

type Host = (message: Record<string, unknown>) => unknown;

/**
 * A stand-in for Chrome's native port: `host` answers each message (or
 * returns undefined to stay silent); throwing disconnects with that error,
 * as Chrome reports a missing or failing host.
 */
function installFakeHost(host: Host) {
  const received: Array<Record<string, unknown>> = [];
  let lastError: { message: string } | undefined;
  const runtime = {
    get lastError() {
      return lastError;
    },
    connectNative: vi.fn((name: string) => {
      const messageListeners: Array<(message: unknown) => void> = [];
      const disconnectListeners: Array<() => void> = [];
      let open = true;
      const disconnect = (error?: string) => {
        if (!open) return;
        open = false;
        lastError = error ? { message: error } : undefined;
        for (const listener of disconnectListeners) listener();
        lastError = undefined;
      };
      return {
        name,
        onMessage: {
          addListener: (listener: (m: unknown) => void) => messageListeners.push(listener),
        },
        onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
        disconnect: () => {
          open = false;
        },
        postMessage(message: Record<string, unknown>) {
          if (!open) throw new Error('Attempting to use a disconnected port object');
          received.push(message);
          queueMicrotask(() => {
            try {
              const reply = host(message);
              if (reply !== undefined) for (const listener of messageListeners) listener(reply);
            } catch (error) {
              disconnect((error as Error).message);
            }
          });
        },
      };
    }),
  };
  vi.stubGlobal('chrome', { runtime });
  return { received, runtime };
}

/** A host that follows the protocol and keeps what it receives. */
function workingHost() {
  const chunks: string[] = [];
  const host: Host = (message) => {
    switch (message.type) {
      case 'hello':
        return { type: 'hello', protocol: 1, version: '0.1.0' };
      case 'begin':
        return { type: 'ready', transfer: '6f1c2c1e-6d1f-4b1a-9a4e-0e6a1c2b3d4e' };
      case 'chunk':
        chunks.push(message.data as string);
        return { type: 'ack', index: message.index };
      case 'end':
        return { type: 'done', transfer: message.transfer };
      default:
        return { type: 'error', code: 'unknown-type', message: 'Unknown.' };
    }
  };
  return { host, chunks };
}

const pdf = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  for (let index = 9; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
};

afterEach(() => vi.unstubAllGlobals());

describe('sending to the desktop app', () => {
  it('sends a document in acknowledged chunks with its checksum', async () => {
    const { host, chunks } = workingHost();
    const { received, runtime } = installFakeHost(host);
    const bytes = pdf(9 * 1024 * 1024 + 5);
    const progress: number[] = [];
    const result = await sendToDesktop(
      { name: 'Report.pdf', bytes },
      { onProgress: (sent) => progress.push(sent) },
    );
    expect(result).toEqual({ status: 'sent' });
    expect(runtime.connectNative).toHaveBeenCalledWith('io.github.albird97.folio');
    const begin = received.find((message) => message.type === 'begin')!;
    expect(begin).toMatchObject({ name: 'Report.pdf', size: bytes.byteLength });
    expect(begin.sha256).toMatch(/^[0-9a-f]{64}$/);
    // 4 MiB chunks, in order, that add up to the document.
    expect(received.filter((m) => m.type === 'chunk').map((m) => m.index)).toEqual([0, 1, 2]);
    const decoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64')));
    expect(decoded.equals(Buffer.from(bytes))).toBe(true);
    expect(progress.at(-1)).toBe(bytes.byteLength);
  });

  it('reports a desktop app that is not installed or not connected', async () => {
    installFakeHost(() => {
      throw new Error('Specified native messaging host not found.');
    });
    expect(await sendToDesktop({ name: 'a.pdf', bytes: pdf(100) })).toEqual({
      status: 'not-installed',
    });
    installFakeHost(() => {
      throw new Error('Access to the specified native messaging host is forbidden.');
    });
    expect(await sendToDesktop({ name: 'a.pdf', bytes: pdf(100) })).toEqual({
      status: 'not-installed',
    });
  });

  it('explains what the desktop app refuses', async () => {
    installFakeHost((message) =>
      message.type === 'hello'
        ? { type: 'hello', protocol: 1 }
        : { type: 'error', code: 'busy', message: 'Documents sent earlier are still waiting.' },
    );
    const busy = await sendToDesktop({ name: 'a.pdf', bytes: pdf(100) });
    expect(busy).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('still holding'),
    });

    installFakeHost(() => ({ type: 'hello', protocol: 2 }));
    expect(await sendToDesktop({ name: 'a.pdf', bytes: pdf(100) })).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('Update both'),
    });

    installFakeHost(() => {
      throw new Error('Native host has exited.');
    });
    expect(await sendToDesktop({ name: 'a.pdf', bytes: pdf(100) })).toMatchObject({
      status: 'failed',
      message: 'The connection to Folio for desktop was lost. Try again.',
    });
  });

  it('refuses empty and oversized documents without connecting', async () => {
    const { runtime } = installFakeHost(workingHost().host);
    expect(await sendToDesktop({ name: 'a.pdf', bytes: new Uint8Array() })).toMatchObject({
      status: 'failed',
    });
    expect(runtime.connectNative).not.toHaveBeenCalled();
  });
});
