import { ExportError, exportPdf, type ExportOptions, type ExportResult } from './export';
import type { ExportFailure, ExportJob, ExportReply } from './worker-job';

/** Set once a worker could not start (no module workers, or a policy forbids them). */
let workersUnavailable = false;

/**
 * `exportPdf` in a Web Worker, so that writing a large document (and
 * re-encoding its images) never blocks the page. It resolves and fails
 * exactly as `exportPdf` does: `ExportError`s keep their codes and warnings
 * come back as they are. Compression progress is reported as usual, and
 * `compression.signal` stops the worker at once.
 *
 * Byte arrays in `transfer` are given up by the caller: they move to the
 * worker without being copied and are empty afterwards. Every other array is
 * copied first, so callers keep their own data.
 *
 * Where there are no workers (Node, tests) or one cannot start, and for a
 * custom image codec (functions cannot be sent to a worker), the export runs
 * here, on the calling thread, with the same code.
 */
export async function exportInWorker(
  options: ExportOptions,
  transfer: Iterable<Uint8Array> = [],
): Promise<ExportResult> {
  if (typeof Worker === 'undefined' || workersUnavailable || options.compression?.codec) {
    return exportPdf(options);
  }
  options.compression?.signal?.throwIfAborted();
  const result = await runInWorker(options, new Set(transfer));
  if (result) return result;
  workersUnavailable = true;
  return exportPdf(options);
}

/** Exports in a new worker; null when the worker could not start (nothing was sent to it). */
function runInWorker(
  options: ExportOptions,
  owned: ReadonlySet<Uint8Array>,
): Promise<ExportResult | null> {
  const signal = options.compression?.signal;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    let started = false;
    let settled = false;
    const finish = () => {
      settled = true;
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      finish();
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.addEventListener('error', (event) => {
      // Handled here; not reported again as an uncaught error.
      event.preventDefault();
      if (settled) return;
      finish();
      if (started) reject(new Error('The export stopped unexpectedly.'));
      else resolve(null);
    });
    worker.addEventListener('messageerror', () => {
      if (settled) return;
      finish();
      reject(new Error('The export stopped unexpectedly.'));
    });
    worker.addEventListener('message', (event: MessageEvent<ExportReply>) => {
      if (settled) return;
      const reply = event.data;
      switch (reply.type) {
        case 'ready': {
          // Only now are arrays transferred: a worker that failed to load
          // leaves them with the caller for the export on this thread.
          started = true;
          try {
            const { job, buffers } = prepareJob(options, owned);
            worker.postMessage(job, buffers);
          } catch (error) {
            // Options that cannot be cloned would otherwise leave the export waiting.
            finish();
            reject(error);
          }
          break;
        }
        case 'progress':
          options.compression?.onProgress?.(reply.done, reply.total);
          break;
        case 'done':
          finish();
          resolve({ bytes: reply.bytes, warnings: reply.warnings });
          break;
        case 'failed':
          finish();
          reject(toError(reply.error));
          break;
      }
    });
  });
}

/**
 * The options as sent to the worker, and the buffers that move with them:
 * owned arrays (each spanning its whole buffer) as they are, copies of the
 * others. Callbacks and the signal stay on this side.
 */
function prepareJob(
  options: ExportOptions,
  owned: ReadonlySet<Uint8Array>,
): { job: ExportJob; buffers: ArrayBuffer[] } {
  const buffers = new Set<ArrayBuffer>();
  const send = (bytes: Uint8Array): Uint8Array => {
    const { buffer } = bytes;
    const movable =
      owned.has(bytes) &&
      buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === buffer.byteLength &&
      !buffers.has(buffer);
    const sent = movable ? bytes : bytes.slice();
    buffers.add(sent.buffer as ArrayBuffer);
    return sent;
  };
  const { compression, ...rest } = options;
  const job: ExportJob = {
    ...rest,
    sources: new Map(
      [...options.sources].map(([id, source]) => [id, { ...source, bytes: send(source.bytes) }]),
    ),
    assets: new Map([...options.assets].map(([id, bytes]) => [id, send(bytes)])),
    ...(compression ? { compression: { images: compression.images } } : {}),
  };
  return { job, buffers: [...buffers] };
}

function toError(failure: ExportFailure): Error {
  if (failure.code) return new ExportError(failure.code, failure.message);
  const error = new Error(failure.message);
  error.name = failure.name;
  return error;
}
