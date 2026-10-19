import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiReplySchema, aiStartSchema, createExtensionAiService } from './ai';
import { parseMessage } from './messages';

const KEY = 'sk-ant-api03-test-key-0123456789';

/** The parts of `chrome` the page side uses: one port per request, runtime messages, permissions. */
function fakeChrome() {
  const ports: Array<{
    name: string;
    posted: unknown[];
    disconnected: boolean;
    reply(message: unknown): void;
    drop(): void;
  }> = [];
  const messages: unknown[] = [];
  const state = { granted: true, hasKey: false };
  const chromeApi = {
    runtime: {
      connect: ({ name }: { name: string }) => {
        const onMessage: Array<(message: unknown) => void> = [];
        const onDisconnect: Array<() => void> = [];
        const entry = {
          name,
          posted: [] as unknown[],
          disconnected: false,
          reply: (message: unknown) => onMessage.forEach((listener) => listener(message)),
          drop: () => onDisconnect.forEach((listener) => listener()),
        };
        ports.push(entry);
        return {
          postMessage: (message: unknown) => entry.posted.push(message),
          disconnect: () => (entry.disconnected = true),
          onMessage: {
            addListener: (listener: (message: unknown) => void) => onMessage.push(listener),
          },
          onDisconnect: { addListener: (listener: () => void) => onDisconnect.push(listener) },
        };
      },
      sendMessage: async (message: { type: string }) => {
        messages.push(message);
        if (message.type === 'ai/status') return { ok: true, ai: { hasKey: state.hasKey } };
        return { ok: true };
      },
    },
    permissions: { request: vi.fn(async () => state.granted) },
  };
  return { chrome: chromeApi, ports, messages, state };
}

const sdkInit = (signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'added-by-folio' },
  body: '{}',
  ...(signal ? { signal } : {}),
});

describe('extension Ask Claude transport', () => {
  let fake: ReturnType<typeof fakeChrome>;
  beforeEach(() => {
    fake = fakeChrome();
    vi.stubGlobal('chrome', fake.chrome);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks Chrome for access to Anthropic’s API before handing the key to the worker', async () => {
    const ai = createExtensionAiService();
    expect(await ai.hasKey()).toBe(false);
    fake.state.granted = false;
    expect(await ai.setKey(KEY)).toBe(false);
    expect(fake.messages).toEqual([{ type: 'ai/status' }]);
    fake.state.granted = true;
    expect(await ai.setKey(` ${KEY} `)).toBe(true);
    expect(fake.chrome.permissions.request).toHaveBeenLastCalledWith({
      origins: ['https://api.anthropic.com/*'],
    });
    expect(fake.messages.at(-1)).toEqual({ type: 'ai/set-key', key: KEY });
    await expect(ai.setKey('not a key')).rejects.toMatchObject({ code: 'invalid-key' });
    await ai.forgetKey();
    expect(fake.messages.at(-1)).toEqual({ type: 'ai/forget-key' });
  });

  it('sends requests to the worker over a port and streams its replies', async () => {
    const ai = createExtensionAiService();
    const pending = ai.fetch('https://api.anthropic.com/v1/messages?beta=true', sdkInit());
    await vi.waitFor(() => expect(fake.ports).toHaveLength(1));
    const [port] = fake.ports;
    expect(port!.name).toBe('folio-ai');
    expect(port!.posted).toEqual([
      {
        type: 'start',
        path: '/v1/messages?beta=true',
        headers: [['content-type', 'application/json']],
        body: '{}',
      },
    ]);
    // What the worker validates the start against.
    expect(aiStartSchema.safeParse(port!.posted[0]).success).toBe(true);
    port!.reply({ type: 'head', status: 200, headers: [['content-type', 'text/event-stream']] });
    port!.reply({ type: 'chunk', data: 'event: ping\n' });
    // Replies that are not understood are ignored.
    port!.reply({ type: 'chunk', data: 42 });
    port!.reply({ type: 'chunk', data: 'data: {}\n\n' });
    port!.reply({ type: 'end' });
    const response = await pending;
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe('event: ping\ndata: {}\n\n');
  });

  it('disconnects when the SDK aborts, and reports the worker’s errors', async () => {
    const ai = createExtensionAiService();
    const controller = new AbortController();
    const pending = ai.fetch('https://api.anthropic.com/v1/messages', sdkInit(controller.signal));
    await vi.waitFor(() => expect(fake.ports).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.ports[0]!.disconnected).toBe(true);

    const refused = ai.fetch('https://api.anthropic.com/v1/messages', sdkInit());
    await vi.waitFor(() => expect(fake.ports).toHaveLength(2));
    fake.ports[1]!.reply({ type: 'error', code: 'no-access', message: 'No access.' });
    await expect(refused).rejects.toMatchObject({ code: 'no-access' });

    const dropped = ai.fetch('https://api.anthropic.com/v1/messages', sdkInit());
    await vi.waitFor(() => expect(fake.ports).toHaveLength(3));
    fake.ports[2]!.drop();
    await expect(dropped).rejects.toMatchObject({ code: 'network' });

    await expect(ai.fetch('https://example.com/v1/messages', sdkInit())).rejects.toMatchObject({
      code: 'blocked',
    });
    expect(fake.ports).toHaveLength(3);
  });

  it('validates the messages both ways', () => {
    expect(parseMessage({ type: 'ai/status' })).toEqual({ type: 'ai/status' });
    expect(parseMessage({ type: 'ai/set-key', key: KEY })).toEqual({
      type: 'ai/set-key',
      key: KEY,
    });
    expect(parseMessage({ type: 'ai/set-key', key: 'k'.repeat(513) })).toBeNull();
    expect(parseMessage({ type: 'ai/set-key' })).toBeNull();
    expect(aiReplySchema.safeParse({ type: 'head', status: 99, headers: [] }).success).toBe(false);
    expect(
      aiReplySchema.safeParse({ type: 'error', code: 'something', message: 'x' }).success,
    ).toBe(false);
  });
});
