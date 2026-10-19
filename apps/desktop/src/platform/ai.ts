import {
  AiTransportError,
  createResponseRelay,
  toAiRequest,
  type AiService,
  type AiTransportErrorCode,
} from '@folio/platform-adapters';
import { Channel, invoke } from '@tauri-apps/api/core';

/** What `ai_request` sends on its channel besides the body's binary chunks (`ai.rs`). */
type RelayMessage =
  | { type: 'head'; status: number; headers: Array<[string, string]> }
  | { type: 'end' }
  | { type: 'error'; code: string };

const CODES: readonly AiTransportErrorCode[] = [
  'invalid-key',
  'no-key',
  'blocked',
  'too-large',
  'storage',
  'network',
];

/** Turns a `{ code, message }` rejection of an AI command into an AiTransportError. */
function toTransportError(error: unknown, fallback: string): AiTransportError {
  const value = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const code = CODES.find((entry) => entry === value.code) ?? 'network';
  return new AiTransportError(code, typeof value.message === 'string' ? value.message : fallback);
}

const isRelayMessage = (value: unknown): value is RelayMessage =>
  typeof value === 'object' && value !== null && 'type' in value;

/**
 * Ask Claude on desktop. The key lives in the OS credential store and never
 * comes back to the webview; requests go through the Rust proxy
 * (`ai_request`), which checks them again, adds the key and streams the
 * answer back over a channel. The webview's CSP still allows no remote
 * connections.
 */
export function createTauriAiService(): AiService {
  return {
    async hasKey() {
      try {
        return await invoke<boolean>('ai_key_status');
      } catch (error) {
        throw toTransportError(error, 'The key could not be checked.');
      }
    },
    async setKey(key) {
      try {
        await invoke('ai_set_key', { key });
        return true;
      } catch (error) {
        throw toTransportError(error, 'The key could not be stored.');
      }
    },
    async forgetKey() {
      try {
        await invoke('ai_forget_key');
      } catch (error) {
        throw toTransportError(error, 'The key could not be deleted.');
      }
    },
    async fetch(input, init) {
      // Checked here too, so the page never even asks for anything else.
      const request = toAiRequest(input, init);
      const id = crypto.randomUUID();
      const relay = createResponseRelay(init?.signal, () => {
        void invoke('ai_cancel', { id }).catch(() => undefined);
      });
      const events = new Channel<ArrayBuffer | RelayMessage>((message) => {
        if (message instanceof ArrayBuffer) {
          relay.chunk(new Uint8Array(message));
        } else if (isRelayMessage(message)) {
          if (message.type === 'head') relay.head(message.status, message.headers);
          else if (message.type === 'end') relay.end();
          else relay.fail(new AiTransportError('network', 'The answer stopped part-way.'));
        }
      });
      // The answer itself arrives on the channel (which keeps its own order;
      // the command's result can overtake its last messages). The command
      // only rejects before an answer starts.
      invoke('ai_request', { id, request, events }).catch((error: unknown) =>
        relay.fail(toTransportError(error, 'Folio could not reach Anthropic.')),
      );
      return relay.response;
    },
  };
}
