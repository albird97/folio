import { AiTransportError } from '@folio/platform-adapters';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTauriAiService } from './ai';

type Listener = (message: unknown) => void;

interface Call {
  command: string;
  args: Record<string, unknown> | undefined;
}

const tauri = vi.hoisted(() => ({
  calls: [] as Call[],
  responses: new Map<string, (args: unknown) => unknown>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  // Like Tauri's: the Rust side delivers messages to `onmessage`.
  Channel: class {
    constructor(readonly onmessage: Listener) {}
  },
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    tauri.calls.push({ command, args });
    return tauri.responses.get(command)?.(args);
  }),
}));

const KEY = 'sk-ant-api03-test-key-0123456789';

const sdkInit = (signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: new Headers({
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': 'added-by-folio',
    'user-agent': 'Anthropic/JS',
  }),
  body: '{"stream":true}',
  ...(signal ? { signal } : {}),
});

/** The pending `ai_request`: its arguments, and a way to send on its channel. */
function lastRequest() {
  const call = tauri.calls.findLast((entry) => entry.command === 'ai_request');
  if (!call) throw new Error('ai_request was not invoked');
  const events = call.args!.events as { onmessage: Listener };
  return { args: call.args!, send: (message: unknown) => events.onmessage(message) };
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer;

describe('desktop Ask Claude transport', () => {
  beforeEach(() => {
    tauri.calls.length = 0;
    tauri.responses.clear();
  });

  it('keeps the key on the native side', async () => {
    const ai = createTauriAiService();
    tauri.responses.set('ai_key_status', () => true);
    expect(await ai.hasKey()).toBe(true);
    expect(await ai.setKey(KEY)).toBe(true);
    await ai.forgetKey();
    expect(tauri.calls).toEqual([
      { command: 'ai_key_status', args: undefined },
      { command: 'ai_set_key', args: { key: KEY } },
      { command: 'ai_forget_key', args: undefined },
    ]);
    tauri.responses.set('ai_set_key', () =>
      Promise.reject({ code: 'invalid-key', message: 'That is not an API key.' }),
    );
    await expect(ai.setKey('nope')).rejects.toEqual(
      new AiTransportError('invalid-key', 'That is not an API key.'),
    );
  });

  it('sends the checked request through Rust and streams the answer from its channel', async () => {
    const ai = createTauriAiService();
    const pending = ai.fetch('https://api.anthropic.com/v1/messages?beta=true', sdkInit());
    await vi.waitFor(() => lastRequest());
    const { args, send } = lastRequest();
    expect(args).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      request: {
        path: '/v1/messages?beta=true',
        headers: [
          ['anthropic-version', '2023-06-01'],
          ['content-type', 'application/json'],
        ],
        body: '{"stream":true}',
      },
    });
    send({ type: 'head', status: 200, headers: [['content-type', 'text/event-stream']] });
    const response = await pending;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    send(bytes('event: message_start\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: message_start\n');
    send(bytes('data: {}\n\n'));
    send({ type: 'end' });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {}\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('cancels the native request when the SDK aborts', async () => {
    const ai = createTauriAiService();
    const controller = new AbortController();
    const pending = ai.fetch('https://api.anthropic.com/v1/messages', sdkInit(controller.signal));
    await vi.waitFor(() => lastRequest());
    const { args, send } = lastRequest();
    send({ type: 'head', status: 200, headers: [] });
    const body = (await pending).text();
    controller.abort();
    await expect(body).rejects.toMatchObject({ name: 'AbortError' });
    expect(tauri.calls.filter((call) => call.command === 'ai_cancel')).toEqual([
      { command: 'ai_cancel', args: { id: args.id } },
    ]);
  });

  it('reports refusals and failures with their reason', async () => {
    const ai = createTauriAiService();
    tauri.responses.set('ai_request', () =>
      Promise.reject({ code: 'no-key', message: 'No API key is stored.' }),
    );
    await expect(ai.fetch('https://api.anthropic.com/v1/messages', sdkInit())).rejects.toEqual(
      new AiTransportError('no-key', 'No API key is stored.'),
    );

    tauri.responses.clear();
    const pending = ai.fetch('https://api.anthropic.com/v1/messages', sdkInit());
    await vi.waitFor(() => lastRequest());
    const { send } = lastRequest();
    send({ type: 'head', status: 200, headers: [] });
    const body = (await pending).text();
    send({ type: 'error', code: 'network' });
    await expect(body).rejects.toMatchObject({ code: 'network' });

    // Nothing outside the allow-list reaches Rust.
    tauri.calls.length = 0;
    await expect(ai.fetch('https://api.anthropic.com/v1/files', sdkInit())).rejects.toMatchObject({
      code: 'blocked',
    });
    expect(tauri.calls).toEqual([]);
  });
});
