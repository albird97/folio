import { sha256Hex } from '@folio/pdf-core';
import type { SendToDesktopResult } from '@folio/platform-adapters';
import { z } from 'zod';

/**
 * Hands documents to the Folio desktop app through Chrome native messaging.
 * The host (the desktop binary, registered by the app) spools the file and
 * the app asks the user before opening it. The extension needs the
 * nativeMessaging permission, asked for when this is first used.
 *
 * Protocol (one JSON message per frame; see the desktop's native_host.rs):
 *   → hello                         ← hello { protocol, version }
 *   → begin { name, size, sha256 }  ← ready { transfer }
 *   → chunk { transfer, index, data (base64) } ← ack { index }
 *   → end { transfer }              ← done { transfer }
 *   any step may answer error { code, message }.
 */
export const NATIVE_HOST = 'io.github.albird97.folio';
export const DESKTOP_PROTOCOL = 1;
/** Bytes per chunk; base64 makes a message of about 5.6 MB, within the host's 12 MiB limit. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** The host's limit. */
export const MAX_DESKTOP_BYTES = 512 * 1024 * 1024;

const replySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number(), version: z.string().optional() }),
  z.object({ type: z.literal('ready'), transfer: z.string() }),
  z.object({ type: z.literal('ack'), index: z.number() }),
  z.object({ type: z.literal('done'), transfer: z.string() }),
  z.object({
    type: z.literal('error'),
    code: z.string().max(64),
    message: z.string().max(500),
    transfer: z.string().optional(),
  }),
]);
type Reply = z.infer<typeof replySchema>;

/** What Chrome reports when the host is missing or not registered for this extension. */
const NOT_INSTALLED = /not found|forbidden|access to the specified native messaging host/i;

const HOST_MESSAGES: Record<string, string> = {
  busy: 'Folio for desktop is still holding documents sent earlier. Open or decline them there, then try again.',
  'origin-not-allowed':
    'Folio for desktop does not accept documents from this copy of the extension.',
  'too-large': 'The document is larger than Folio for desktop accepts (512 MB).',
  'launch-failed': 'Folio for desktop could not be started. Open it, then try again.',
};

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** One request at a time over a native port, each answered by the next reply. */
function connect(port: chrome.runtime.Port) {
  const waiting: Array<{ resolve(reply: Reply): void; reject(error: Error): void }> = [];
  let closed: Error | null = null;
  port.onMessage.addListener((raw: unknown) => {
    const next = waiting.shift();
    const reply = replySchema.safeParse(raw);
    if (!next) return;
    if (reply.success) next.resolve(reply.data);
    else next.reject(new Error('Folio for desktop sent an answer Folio does not understand.'));
  });
  port.onDisconnect.addListener(() => {
    closed = new Error(chrome.runtime.lastError?.message ?? 'The connection closed.');
    for (const entry of waiting.splice(0)) entry.reject(closed);
  });
  return (message: object): Promise<Reply> =>
    new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      waiting.push({ resolve, reject });
      try {
        port.postMessage(message);
      } catch (error) {
        waiting.pop();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
}

export interface SendOptions {
  onProgress?(sent: number, total: number): void;
  signal?: AbortSignal;
}

/**
 * Sends a PDF to the desktop app. The caller has the nativeMessaging
 * permission already (see {@link requestDesktopAccess}).
 */
export async function sendToDesktop(
  { name, bytes }: { name: string; bytes: Uint8Array },
  options: SendOptions = {},
): Promise<SendToDesktopResult> {
  if (bytes.byteLength === 0) return { status: 'failed', message: 'The document is empty.' };
  if (bytes.byteLength > MAX_DESKTOP_BYTES) {
    return { status: 'failed', message: HOST_MESSAGES['too-large']! };
  }
  if (typeof chrome.runtime.connectNative !== 'function') {
    return { status: 'failed', message: 'Folio may not talk to the desktop app yet.' };
  }
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  const request = connect(port);
  const failure = (reply: Reply): SendToDesktopResult => ({
    status: 'failed',
    message:
      reply.type === 'error'
        ? (HOST_MESSAGES[reply.code] ?? reply.message)
        : 'Folio for desktop answered unexpectedly.',
  });
  const abort = () => port.disconnect();
  options.signal?.addEventListener('abort', abort);
  try {
    const hello = await request({ type: 'hello' });
    if (hello.type !== 'hello') return failure(hello);
    if (hello.protocol !== DESKTOP_PROTOCOL) {
      return {
        status: 'failed',
        message: 'This version of Folio for desktop does not match the extension. Update both.',
      };
    }
    const ready = await request({
      type: 'begin',
      name,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    });
    if (ready.type !== 'ready') return failure(ready);
    let index = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES, index += 1) {
      options.signal?.throwIfAborted();
      const ack = await request({
        type: 'chunk',
        transfer: ready.transfer,
        index,
        data: base64(bytes.subarray(offset, offset + CHUNK_BYTES)),
      });
      if (ack.type !== 'ack' || ack.index !== index) return failure(ack);
      options.onProgress?.(Math.min(offset + CHUNK_BYTES, bytes.byteLength), bytes.byteLength);
    }
    const done = await request({ type: 'end', transfer: ready.transfer });
    return done.type === 'done' ? { status: 'sent' } : failure(done);
  } catch (error) {
    if (options.signal?.aborted) return { status: 'failed', message: 'Sending was cancelled.' };
    const message = error instanceof Error ? error.message : '';
    if (NOT_INSTALLED.test(message)) return { status: 'not-installed' };
    return {
      status: 'failed',
      message: 'The connection to Folio for desktop was lost. Try again.',
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try {
      port.disconnect();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Asks for the nativeMessaging permission (once; later calls answer at
 * once). Call it straight from a click.
 */
export function requestDesktopAccess(): Promise<boolean> {
  return chrome.permissions.request({ permissions: ['nativeMessaging'] });
}

export type DesktopStatus =
  | { status: 'connected'; version: string | null }
  | { status: 'not-installed' }
  | { status: 'failed'; message: string };

/** Says hello to the desktop app. Needs the nativeMessaging permission. */
export async function checkDesktop(): Promise<DesktopStatus> {
  if (typeof chrome.runtime.connectNative !== 'function') {
    return { status: 'failed', message: 'Folio may not talk to the desktop app yet.' };
  }
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  try {
    const hello = await connect(port)({ type: 'hello' });
    if (hello.type === 'hello' && hello.protocol === DESKTOP_PROTOCOL) {
      return { status: 'connected', version: hello.version ?? null };
    }
    return {
      status: 'failed',
      message: 'This version of Folio for desktop does not match the extension. Update both.',
    };
  } catch (error) {
    return NOT_INSTALLED.test(error instanceof Error ? error.message : '')
      ? { status: 'not-installed' }
      : { status: 'failed', message: 'Folio for desktop did not answer.' };
  } finally {
    try {
      port.disconnect();
    } catch {
      // Already closed.
    }
  }
}
