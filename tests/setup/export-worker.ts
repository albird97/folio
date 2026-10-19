import {
  runExportJob,
  type ExportJob,
  type ExportReply,
} from '../../packages/pdf-core/src/export/worker-job';

/**
 * The export worker for Node tests (`vi.stubGlobal('Worker', FakeExportWorker)`),
 * on this thread: messages cross with `structuredClone`, so transferred
 * buffers are detached on the sending side as with a real worker, and
 * replies arrive as later tasks. The job runs as the worker entry runs it.
 */
export class FakeExportWorker extends EventTarget {
  static created: FakeExportWorker[] = [];
  /** The next workers fail to load, as when a policy forbids them. */
  static failToLoad = false;
  terminated = false;

  static reset() {
    FakeExportWorker.created = [];
    FakeExportWorker.failToLoad = false;
  }

  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    super();
    FakeExportWorker.created.push(this);
    setTimeout(() => {
      if (FakeExportWorker.failToLoad) this.dispatchEvent(new Event('error', { cancelable: true }));
      else this.reply({ type: 'ready' });
    });
  }

  postMessage(job: ExportJob, transfer: Transferable[]) {
    const received = structuredClone(job, { transfer });
    void runExportJob(received, (reply, replyTransfer) => this.reply(reply, replyTransfer));
  }

  terminate() {
    this.terminated = true;
  }

  private reply(reply: ExportReply, transfer: Transferable[] = []) {
    const data: unknown = structuredClone(reply, { transfer });
    setTimeout(() => {
      if (!this.terminated) this.dispatchEvent(new MessageEvent('message', { data }));
    });
  }
}
