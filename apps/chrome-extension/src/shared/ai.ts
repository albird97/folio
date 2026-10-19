import {
  AI_HOST_PERMISSION,
  AI_MAX_BODY_BYTES,
  AiTransportError,
  createResponseRelay,
  isAllowedAiPath,
  normalizeAiKey,
  toAiRequest,
  type AiService,
} from '@folio/platform-adapters';
import { sendMessage } from './messages';
import { z } from './zod';

/**
 * Ask Claude in the extension. The user's API key is kept in
 * `chrome.storage.local` (never `sync`) by the service worker, which alone
 * talks to Anthropic's API, over a port per request, with the key added
 * there. Extension pages keep their `connect-src 'self'` policy: they reach
 * Anthropic only through the worker.
 */
export const AI_PORT = 'folio-ai';

/** Where the service worker keeps the key. Pages never read it. */
export const AI_KEY_STORAGE = 'ai-api-key';

const header = z.tuple([z.string().min(1).max(64), z.string().min(1).max(1024)]);

export const aiStartSchema = z.object({
  type: z.literal('start'),
  path: z.string().max(64).refine(isAllowedAiPath),
  headers: z.array(header).max(8),
  body: z.string().max(AI_MAX_BODY_BYTES),
});
export type AiStart = z.infer<typeof aiStartSchema>;

export const aiReplySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('head'),
    status: z.number().int().min(100).max(599),
    headers: z.array(header).max(16),
  }),
  z.object({ type: z.literal('chunk'), data: z.string() }),
  z.object({ type: z.literal('end') }),
  z.object({
    type: z.literal('error'),
    code: z.enum(['no-key', 'no-access', 'blocked', 'too-large', 'network']),
    message: z.string().max(500),
  }),
]);
export type AiReply = z.infer<typeof aiReplySchema>;

/**
 * The page side: requests travel to the service worker over a port, the
 * answer comes back in text chunks (an SSE stream is text), and
 * disconnecting cancels the request there.
 */
function fetchThroughWorker(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = toAiRequest(input, init);
  const port = chrome.runtime.connect({ name: AI_PORT });
  const encoder = new TextEncoder();
  const relay = createResponseRelay(init?.signal, () => {
    try {
      port.disconnect();
    } catch {
      // Already disconnected.
    }
  });
  port.onMessage.addListener((raw: unknown) => {
    const reply = aiReplySchema.safeParse(raw);
    if (!reply.success) return;
    const message = reply.data;
    if (message.type === 'head') relay.head(message.status, message.headers);
    else if (message.type === 'chunk') relay.chunk(encoder.encode(message.data));
    else if (message.type === 'end') relay.end();
    else relay.fail(new AiTransportError(message.code, message.message));
  });
  port.onDisconnect.addListener(() =>
    relay.fail(new AiTransportError('network', 'The connection to Anthropic stopped.')),
  );
  port.postMessage({ type: 'start', ...request } satisfies AiStart);
  return relay.response;
}

export function createExtensionAiService(): AiService {
  return {
    async hasKey() {
      const response = await sendMessage({ type: 'ai/status' });
      return response.ok && response.ai?.hasKey === true;
    },
    async setKey(raw) {
      const key = normalizeAiKey(raw);
      if (!key) throw new AiTransportError('invalid-key', 'That is not an API key.');
      // First, while the click still counts: Chrome asks only the first time.
      if (!(await chrome.permissions.request({ origins: [AI_HOST_PERMISSION] }))) return false;
      const response = await sendMessage({ type: 'ai/set-key', key });
      if (!response.ok) throw new AiTransportError('storage', 'The key could not be stored.');
      return true;
    },
    async forgetKey() {
      const response = await sendMessage({ type: 'ai/forget-key' });
      if (!response.ok) throw new AiTransportError('storage', 'The key could not be deleted.');
    },
    fetch: async (input, init) => fetchThroughWorker(input, init),
  };
}
