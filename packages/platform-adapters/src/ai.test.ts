import { describe, expect, it, vi } from 'vitest';
import {
  AI_MAX_BODY_BYTES,
  AiTransportError,
  createMemoryAiService,
  createResponseRelay,
  isAllowedAiPath,
  normalizeAiKey,
  toAiRequest,
} from './ai';

const KEY = 'sk-ant-api03-test-key-0123456789';

/** What the Anthropic SDK passes to `fetch`. */
function sdkInit(overrides: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    headers: new Headers({
      accept: 'application/json',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'x-api-key': 'added-by-folio',
      'user-agent': 'Anthropic/JS 0.135.0',
      'x-stainless-os': 'MacOS',
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: '{"model":"claude-opus-5-5"}',
    ...overrides,
  };
}

const errorOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};

describe('Anthropic API requests', () => {
  it('allows only the messages and token counting endpoints', () => {
    expect(isAllowedAiPath('/v1/messages')).toBe(true);
    expect(isAllowedAiPath('/v1/messages?beta=true')).toBe(true);
    expect(isAllowedAiPath('/v1/messages/count_tokens?beta=true')).toBe(true);
    for (const path of [
      '/v1/models',
      '/v1/files',
      '/v1/messages/batches',
      '/v1/messages?beta=true&x=1',
      '/v1/messages?beta=false',
      '/v1/messages?beta=true?x',
      '/v1/messages/',
    ]) {
      expect(isAllowedAiPath(path), path).toBe(false);
    }
  });

  it('keeps the allowed headers and drops the rest, including any key', () => {
    expect(toAiRequest('https://api.anthropic.com/v1/messages?beta=true', sdkInit())).toEqual({
      path: '/v1/messages?beta=true',
      headers: [
        ['anthropic-version', '2023-06-01'],
        ['anthropic-beta', 'server-side-fallback-2026-07-01'],
        ['content-type', 'application/json'],
      ],
      body: '{"model":"claude-opus-5-5"}',
    });
  });

  it('refuses anything else', () => {
    const blocked = [
      ['https://api.anthropic.com.evil.example/v1/messages', sdkInit()],
      ['http://api.anthropic.com/v1/messages', sdkInit()],
      ['https://user:pass@api.anthropic.com/v1/messages', sdkInit()],
      ['https://api.anthropic.com/v1/messages#x', sdkInit()],
      ['https://api.anthropic.com/v1/files', sdkInit()],
      ['https://api.anthropic.com/v1/messages', sdkInit({ method: 'GET', body: null })],
      ['https://api.anthropic.com/v1/messages', sdkInit({ body: new Uint8Array(4) })],
      ['https://api.anthropic.com/v1/messages', sdkInit({ headers: {} })],
      [
        'https://api.anthropic.com/v1/messages',
        sdkInit({ headers: { 'content-type': 'text/plain' } }),
      ],
      ['not a url', sdkInit()],
    ] as const;
    for (const [url, init] of blocked) {
      const error = errorOf(() => toAiRequest(url, init));
      expect(error, url).toBeInstanceOf(AiTransportError);
      expect((error as AiTransportError).code).toBe('blocked');
    }
    const request = new Request('https://api.anthropic.com/v1/messages', { method: 'POST' });
    expect(errorOf(() => toAiRequest(request))).toMatchObject({ code: 'blocked' });
  });

  it('refuses bodies larger than Anthropic accepts', () => {
    const body = 'é'.repeat(AI_MAX_BODY_BYTES / 2 + 1);
    expect(
      errorOf(() => toAiRequest('https://api.anthropic.com/v1/messages', sdkInit({ body }))),
    ).toMatchObject({ code: 'too-large' });
    // Large in UTF-16 units but within the limit in bytes.
    const ascii = 'a'.repeat(AI_MAX_BODY_BYTES / 2);
    expect(
      toAiRequest('https://api.anthropic.com/v1/messages', sdkInit({ body: ascii })).body,
    ).toHaveLength(AI_MAX_BODY_BYTES / 2);
  });

  it('only accepts text that can be an API key', () => {
    expect(normalizeAiKey(`  ${KEY}\n`)).toBe(KEY);
    expect(normalizeAiKey('short')).toBeNull();
    expect(normalizeAiKey('sk-ant-api03 with spaces 0123')).toBeNull();
    expect(normalizeAiKey('sk-ant-api03-key\r\nx-other: 1')).toBeNull();
  });
});

describe('response relay', () => {
  const read = async (response: Response) => new TextDecoder().decode(await response.arrayBuffer());

  it('resolves at the head and streams the body as it arrives', async () => {
    const relay = createResponseRelay(null, vi.fn());
    relay.head(200, [
      ['content-type', 'text/event-stream'],
      ['request-id', 'req_1'],
      ['set-cookie', 'a=b'],
    ]);
    const response = await relay.response;
    expect(response.status).toBe(200);
    expect([...response.headers]).toEqual([
      ['content-type', 'text/event-stream'],
      ['request-id', 'req_1'],
    ]);
    const reader = response.body!.getReader();
    relay.chunk(new TextEncoder().encode('event: ping\n'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('event: ping\n');
    relay.chunk(new TextEncoder().encode('data: {}\n\n'));
    relay.end();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {}\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('cancels the platform request when the caller aborts, before or during the answer', async () => {
    const before = new AbortController();
    const cancelBefore = vi.fn();
    const waiting = createResponseRelay(before.signal, cancelBefore);
    before.abort();
    await expect(waiting.response).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelBefore).toHaveBeenCalledOnce();

    const during = new AbortController();
    const cancelDuring = vi.fn();
    const streaming = createResponseRelay(during.signal, cancelDuring);
    streaming.head(200, [['content-type', 'text/event-stream']]);
    const body = (await streaming.response).text();
    during.abort();
    await expect(body).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelDuring).toHaveBeenCalledOnce();
    // Nothing after the abort reaches the caller, and the platform is told once.
    streaming.chunk(new Uint8Array([1]));
    streaming.end();
    during.abort();
    expect(cancelDuring).toHaveBeenCalledOnce();
  });

  it('reports failures before and during the answer', async () => {
    const early = createResponseRelay(null, vi.fn());
    early.fail(new AiTransportError('no-key', 'No API key is stored.'));
    await expect(early.response).rejects.toMatchObject({ code: 'no-key' });

    const late = createResponseRelay(null, vi.fn());
    late.head(200, []);
    const body = (await late.response).text();
    late.fail(new AiTransportError('network', 'The answer stopped part-way.'));
    await expect(body).rejects.toMatchObject({ code: 'network' });

    const empty = createResponseRelay(null, vi.fn());
    empty.end();
    await expect(empty.response).rejects.toMatchObject({ code: 'network' });
    const error = createResponseRelay(null, vi.fn());
    error.head(401, [['content-type', 'application/json']]);
    error.chunk(new TextEncoder().encode('{"type":"error"}'));
    error.end();
    const response = await error.response;
    expect(response.status).toBe(401);
    expect(await read(response)).toBe('{"type":"error"}');
  });
});

describe('memory AI service (development)', () => {
  it('adds the key in memory and sends only allowed requests', async () => {
    const send = vi.fn(async () => new Response('{}', { status: 200 }));
    const ai = createMemoryAiService(send);
    expect(await ai.hasKey()).toBe(false);
    await expect(
      ai.fetch('https://api.anthropic.com/v1/messages', sdkInit()),
    ).rejects.toMatchObject({ code: 'no-key' });
    await expect(ai.setKey('nope')).rejects.toMatchObject({ code: 'invalid-key' });
    expect(await ai.setKey(` ${KEY} `)).toBe(true);
    expect(await ai.hasKey()).toBe(true);

    await ai.fetch('https://api.anthropic.com/v1/messages?beta=true', sdkInit());
    expect(send).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages?beta=true',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        headers: [
          ['anthropic-version', '2023-06-01'],
          ['anthropic-beta', 'server-side-fallback-2026-07-01'],
          ['content-type', 'application/json'],
          ['x-api-key', KEY],
          ['anthropic-dangerous-direct-browser-access', 'true'],
        ],
      }),
    );
    await expect(ai.fetch('https://api.anthropic.com/v1/files', sdkInit())).rejects.toMatchObject({
      code: 'blocked',
    });
    expect(send).toHaveBeenCalledOnce();

    await ai.forgetKey();
    expect(await ai.hasKey()).toBe(false);
  });
});
