import type { CompressionOptions } from './compress';
import { ExportError, exportPdf, type ExportOptions, type ExportWarning } from './export';

/**
 * What the page sends the export worker: the export's options without what
 * cannot cross to another thread. Compression progress comes back as
 * messages; cancelling stops the worker itself.
 */
export type ExportJob = Omit<ExportOptions, 'compression'> & {
  compression?: Pick<CompressionOptions, 'images'>;
};

/** An error as it crosses back to the page; `code` is an `ExportError`'s. */
export interface ExportFailure {
  name: string;
  message: string;
  code?: ExportError['code'];
}

export type ExportReply =
  /** The worker's code loaded (module workers that cannot load only report an error event). */
  | { type: 'ready' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; bytes: Uint8Array; warnings: ExportWarning[] }
  | { type: 'failed'; error: ExportFailure };

/**
 * Runs one export for the worker and posts its progress and outcome. The
 * written file's buffer is transferred, not copied: the worker keeps nothing.
 */
export async function runExportJob(
  job: ExportJob,
  post: (reply: ExportReply, transfer?: Transferable[]) => void,
): Promise<void> {
  try {
    const { compression, ...options } = job;
    const { bytes, warnings } = await exportPdf({
      ...options,
      ...(compression
        ? {
            compression: {
              images: compression.images,
              onProgress: (done, total) => post({ type: 'progress', done, total }),
            },
          }
        : {}),
    });
    post({ type: 'done', bytes, warnings }, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    post({ type: 'failed', error: describeFailure(error) });
  }
}

/** Errors are sent as plain data: not every engine can clone Error objects. */
function describeFailure(error: unknown): ExportFailure {
  if (error instanceof ExportError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: 'The document could not be written.' };
}
