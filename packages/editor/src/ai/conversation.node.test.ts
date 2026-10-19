import { createPdfEngine } from '@folio/pdf-core';
import { createMemoryAiService, memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  answerBody,
  answerEvents,
  countTokensBody,
  errorBody,
  JSON_HEADERS,
  SSE_HEADERS,
  type MockAnswer,
} from '../../../../tests/setup/anthropic';
import { nodeWorkerSrc, readFixture, type FixtureName } from '../../../../tests/setup/fixtures';
import { createWorkspaceStore } from '../store/workspace';
import {
  answerText,
  createAiConversations,
  historyOf,
  type AiConversations,
  type AiTurn,
} from './conversation';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const KEY = 'sk-ant-api03-test-key-0123456789';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }> };
  signal: AbortSignal | null;
}

type Responder = (sent: Sent) => Response | Promise<Response>;

/**
 * A workspace with a document open and Ask Claude set up with a key, whose
 * requests (after the platform checked them and added the key) `respond`
 * answers.
 */
async function setUp(name: FixtureName, respond: Responder) {
  const workspace = createWorkspaceStore(engine);
  await workspace.getState().openFiles([memoryFile(name, readFixture(name))]);
  const key = workspace.getState().documents[0]!.key;
  const requests: Sent[] = [];
  const ai = createMemoryAiService(async (input, init) => {
    const sent: Sent = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body)) as Sent['body'],
      signal: init?.signal ?? null,
    };
    requests.push(sent);
    return respond(sent);
  });
  await ai.setKey(KEY);
  // Every call the SDK makes, retries included.
  const service = { ...ai, fetch: vi.fn(ai.fetch) };
  const conversations = createAiConversations(workspace, service);
  const conversation = () => conversations.store.getState().conversations[key]!;
  const lastTurn = () => conversation().turns.at(-1)!;
  return { workspace, key, ai: service, conversations, conversation, lastTurn, requests };
}

const isCount = (sent: Sent) => sent.url.includes('/count_tokens');

/** Answers token counting with `tokens` and questions with `answer`. */
const answering =
  (answer: MockAnswer | ((sent: Sent) => MockAnswer), tokens = 1_200): Responder =>
  (sent) =>
    isCount(sent)
      ? new Response(countTokensBody(tokens), { headers: JSON_HEADERS })
      : new Response(answerBody(typeof answer === 'function' ? answer(sent) : answer), {
          headers: SSE_HEADERS,
        });

/** An answer the test streams event by event; aborting stops it, as with `fetch`. */
function streamedByTest() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (value) => {
      controller = value;
    },
  });
  const encoder = new TextEncoder();
  return {
    respond(signal: AbortSignal | null) {
      signal?.addEventListener('abort', () =>
        controller.error(new DOMException('The request was cancelled.', 'AbortError')),
      );
      return new Response(body, { headers: SSE_HEADERS });
    },
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

const ask = (conversations: AiConversations, key: string, question: string, pages = [0, 1, 2]) => {
  if (!conversations.store.getState().conversations[key]?.document) {
    conversations.start(key, 'claude-opus-5-5', pages);
  }
  return conversations.ask(key, question);
};

const statusOf = (turn: AiTurn) => ({ status: turn.status, text: answerText(turn.answer) });

describe('Ask Claude conversations', () => {
  it('reads the pages, counts the tokens, then streams an answer that cites pages', async () => {
    const { key, conversations, conversation, lastTurn, requests } = await setUp(
      'basic-3-pages.pdf',
      answering({
        parts: [{ text: 'Three fixture pages.', pages: [1, 2] }, { text: ' Nothing else.' }],
      }),
    );
    await ask(conversations, key, 'Summarize this document.');

    // Counted first, then asked, both with the user's key added by the platform.
    expect(requests.map((sent) => sent.url)).toEqual([
      'https://api.anthropic.com/v1/messages/count_tokens?beta=true',
      'https://api.anthropic.com/v1/messages?beta=true',
    ]);
    for (const sent of requests) {
      expect(sent.headers['x-api-key']).toBe(KEY);
      expect(sent.headers['user-agent']).toBeUndefined();
    }
    const [, asked] = requests;
    expect(asked!.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(asked!.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
    const document = (asked!.body.messages![0]!.content as Array<Record<string, unknown>>)[0]!;
    const blocks = (document.source as { content: Array<{ text: string }> }).content;
    expect(blocks.map((block) => block.text.split('\n')[0])).toEqual([
      'Page 1',
      'Page 2',
      'Page 3',
    ]);
    expect(blocks[1]!.text).toContain('Folio fixture page 2');

    expect(conversation()).toMatchObject({ tokens: 1_200, preparing: null, problem: null });
    expect(conversation().document!.pages).toHaveLength(3);
    expect(statusOf(lastTurn())).toEqual({
      status: 'done',
      text: 'Three fixture pages. Nothing else.',
    });
    expect(lastTurn().answer[0]!.citations).toEqual([
      expect.objectContaining({ type: 'content_block_location', start_block_index: 1 }),
    ]);
    expect(lastTurn().usage).toEqual({ input: 40, cacheRead: 0, cacheWrite: 0, output: 1 });
  });

  it('sends follow-ups with the history after the same cached prefix', async () => {
    const { key, conversations, lastTurn, requests } = await setUp(
      'basic-3-pages.pdf',
      answering((sent) =>
        sent.body.messages!.length === 1
          ? {
              parts: [{ text: 'A test document.' }],
              usage: { input_tokens: 30, cache_creation_input_tokens: 1_150 },
            }
          : {
              parts: [{ text: 'Three.' }],
              usage: { input_tokens: 20, cache_read_input_tokens: 1_150 },
            },
      ),
    );
    await ask(conversations, key, 'Summarize this document.');
    expect(lastTurn().usage).toMatchObject({ cacheWrite: 1_150, cacheRead: 0 });
    await ask(conversations, key, 'How many pages?');

    // Counted once, before the first question only.
    expect(requests.filter(isCount)).toHaveLength(1);
    const [first, second] = requests.filter((sent) => !isCount(sent));
    expect(second!.body.messages).toEqual([
      first!.body.messages![0],
      { role: 'assistant', content: [{ type: 'text', text: 'A test document.' }] },
      { role: 'user', content: [{ type: 'text', text: 'How many pages?' }] },
    ]);
    expect(JSON.stringify(second!.body.system)).toBe(JSON.stringify(first!.body.system));
    // Anthropic served the prefix from its cache.
    expect(lastTurn().usage).toEqual({ input: 20, cacheRead: 1_150, cacheWrite: 0, output: 1 });
  });

  it('shows the answer while it streams in', async () => {
    const stream = streamedByTest();
    const { key, conversations, lastTurn } = await setUp('basic-3-pages.pdf', (sent) =>
      isCount(sent)
        ? new Response(countTokensBody(900), { headers: JSON_HEADERS })
        : stream.respond(sent.signal),
    );
    const done = ask(conversations, key, 'Summarize this document.');
    const events = answerEvents({ parts: [{ text: 'The quick brown fox jumps.' }] });
    // message_start, thinking, ping, the text block's start and first word.
    const head = events.findIndex((text) => text.includes('"text_delta"')) + 1;
    stream.push(events.slice(0, head).join(''));
    await vi.waitFor(() =>
      expect(statusOf(lastTurn())).toEqual({ status: 'answering', text: 'The ' }),
    );
    stream.push(events[head]!);
    await vi.waitFor(() => expect(answerText(lastTurn().answer)).toBe('The quick '));
    stream.push(events.slice(head + 1).join(''));
    stream.close();
    await done;
    expect(statusOf(lastTurn())).toEqual({ status: 'done', text: 'The quick brown fox jumps.' });
  });

  it('stops an answer, keeping what arrived, and cancels the request', async () => {
    const stream = streamedByTest();
    let signal: AbortSignal | null = null;
    const { key, conversations, lastTurn } = await setUp('basic-3-pages.pdf', (sent) => {
      if (isCount(sent)) return new Response(countTokensBody(900), { headers: JSON_HEADERS });
      signal = sent.signal;
      return stream.respond(sent.signal);
    });
    const done = ask(conversations, key, 'Summarize this document.');
    const events = answerEvents({ parts: [{ text: 'Partial answer that never ends' }] });
    stream.push(events.slice(0, 7).join(''));
    await vi.waitFor(() => expect(answerText(lastTurn().answer)).not.toBe(''));
    conversations.stop(key);
    await done;
    expect(signal!.aborted).toBe(true);
    expect(lastTurn().status).toBe('stopped');
    expect(answerText(lastTurn().answer)).toBe('Partial ');
    // A stopped answer still counts as what was said.
    expect(historyOf([lastTurn()])).toEqual([
      { question: 'Summarize this document.', answer: 'Partial ' },
    ]);
  });

  it('refuses documents too large to send, saying how large, and asks nothing', async () => {
    const { key, conversations, conversation, requests } = await setUp(
      'basic-3-pages.pdf',
      answering({ parts: [{ text: 'never' }] }, 900_000),
    );
    await ask(conversations, key, 'Summarize this document.');
    expect(conversation()).toMatchObject({
      document: null,
      turns: [],
      problem: { kind: 'too-large', tokens: 900_000 },
    });
    expect(requests.filter((sent) => !isCount(sent))).toEqual([]);
  });

  it('says when the pages have no text, without sending anything', async () => {
    const { key, conversations, conversation, requests } = await setUp(
      'scanned-pages.pdf',
      answering({ parts: [{ text: 'never' }] }),
    );
    await ask(conversations, key, 'Summarize this document.', [0]);
    expect(conversation().problem).toEqual({ kind: 'no-text', pagesRead: 1 });
    expect(requests).toEqual([]);
  });

  it('drops a refused answer and marks one cut off at the length limit', async () => {
    let next: MockAnswer = {
      parts: [{ text: 'Partly answered, then' }],
      stopReason: 'refusal',
    };
    const { key, conversations, conversation, lastTurn } = await setUp(
      'basic-3-pages.pdf',
      answering(() => next),
    );
    await ask(conversations, key, 'Something declined');
    expect(statusOf(lastTurn())).toEqual({ status: 'refused', text: '' });

    next = { parts: [{ text: 'A long answer' }], stopReason: 'max_tokens' };
    await ask(conversations, key, 'Something long');
    expect(lastTurn()).toMatchObject({ status: 'done', cutOff: true });
    // The declined question is not repeated in later requests.
    expect(historyOf(conversation().turns)).toEqual([
      { question: 'Something long', answer: 'A long answer' },
    ]);
  });

  it('reports a key Anthropic does not accept, and offers to change it', async () => {
    const { key, conversations, conversation } = await setUp(
      'basic-3-pages.pdf',
      () =>
        new Response(errorBody('authentication_error', 'invalid x-api-key'), {
          status: 401,
          headers: JSON_HEADERS,
        }),
    );
    await ask(conversations, key, 'Summarize this document.');
    expect(conversation().problem).toEqual({
      kind: 'failed',
      failure: {
        message: 'Anthropic did not accept your API key. Check it and set it up again.',
        fixKey: true,
      },
    });
  });

  it('fails at once, without retries, when the key is gone', async () => {
    const { key, ai, conversations, conversation, requests } = await setUp(
      'basic-3-pages.pdf',
      answering({ parts: [{ text: 'never' }] }),
    );
    // Forgotten meanwhile (in another window, or the extension's options).
    await ai.forgetKey();
    await ask(conversations, key, 'Summarize this document.');
    expect(conversation().problem).toEqual({
      kind: 'failed',
      failure: {
        message: 'Your API key is no longer stored. Set up Ask Claude again.',
        fixKey: true,
      },
    });
    expect(ai.fetch).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });

  it('forgets a conversation when its document closes', async () => {
    const { workspace, key, conversations } = await setUp(
      'basic-3-pages.pdf',
      answering({ parts: [{ text: 'Hello.' }] }),
    );
    await ask(conversations, key, 'Hi');
    expect(conversations.store.getState().conversations[key]).toBeDefined();
    await workspace.getState().close(key);
    expect(conversations.store.getState().conversations[key]).toBeUndefined();
  });
});
