/**
 * Answers of Anthropic's Messages API for tests, built event by event the
 * way the API streams them (server-sent events: `message_start`, a thinking
 * block whose text is omitted, text blocks with their deltas and citations,
 * pings, `message_delta` with the stop reason and usage, `message_stop`).
 * Tests never call the real API.
 */

interface MockUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface MockAnswer {
  /** Passages of the answer; `pages` cites page blocks [start, end) of the document. */
  parts: Array<{ text: string; pages?: [number, number] }>;
  model?: string;
  stopReason?: 'end_turn' | 'max_tokens' | 'refusal';
  usage?: Partial<MockUsage>;
}

const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** Text in small pieces, as the API streams it. */
function pieces(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

/** The answer's events, one string per server-sent event. */
export function answerEvents(answer: MockAnswer): string[] {
  const usage: MockUsage = {
    input_tokens: 40,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 1,
    ...answer.usage,
  };
  const stopReason = answer.stopReason ?? 'end_turn';
  const events = [
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_01FolioTest',
        type: 'message',
        role: 'assistant',
        model: answer.model ?? 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { ...usage, output_tokens: 1 },
      },
    }),
    // Adaptive thinking with the default display: the thinking text is omitted.
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'EqQBCkgIBhABGAIiQFolioTestSignature' },
    }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('ping', { type: 'ping' }),
  ];
  answer.parts.forEach((part, offset) => {
    const index = offset + 1;
    const cited = part.pages !== undefined;
    events.push(
      event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: cited
          ? { type: 'text', text: '', citations: [] }
          : { type: 'text', text: '' },
      }),
    );
    if (part.pages) {
      events.push(
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'citations_delta',
            citation: {
              type: 'content_block_location',
              cited_text: 'Page text',
              document_index: 0,
              document_title: null,
              start_block_index: part.pages[0],
              end_block_index: part.pages[1],
            },
          },
        }),
      );
    }
    for (const text of pieces(part.text)) {
      events.push(
        event('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        }),
      );
    }
    events.push(event('content_block_stop', { type: 'content_block_stop', index }));
  });
  events.push(
    event('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details:
          stopReason === 'refusal'
            ? { type: 'refusal', category: 'cyber', explanation: null }
            : null,
      },
      usage: { output_tokens: usage.output_tokens },
    }),
    event('message_stop', { type: 'message_stop' }),
  );
  return events;
}

export const answerBody = (answer: MockAnswer) => answerEvents(answer).join('');

/** The answer of `POST /v1/messages/count_tokens`. */
export const countTokensBody = (inputTokens: number) =>
  JSON.stringify({ input_tokens: inputTokens });

/** An error answer, as the API sends it with a 4xx or 5xx status. */
export const errorBody = (type: string, message: string) =>
  JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_01FolioTest' });

export const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };
export const JSON_HEADERS = { 'content-type': 'application/json' };
