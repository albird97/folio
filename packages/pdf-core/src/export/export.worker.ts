import { runExportJob, type ExportJob, type ExportReply } from './worker-job';

/**
 * The export worker (see `exportInWorker`): one worker writes one document
 * and is then stopped, so the memory pdf-lib used goes with it.
 */

/** What is used of a dedicated worker's global scope (the DOM library types `self` as a window). */
interface WorkerScope {
  postMessage(message: ExportReply, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<ExportJob>) => void,
    options: { once: true },
  ): void;
}

const scope = globalThis as unknown as WorkerScope;
scope.addEventListener(
  'message',
  (event) => void runExportJob(event.data, (reply, transfer) => scope.postMessage(reply, transfer)),
  { once: true },
);
scope.postMessage({ type: 'ready' });
