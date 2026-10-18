export interface SchedulableJob {
  promise: Promise<unknown>;
  cancel(): void;
}

interface Entry {
  id: string;
  priority: number;
  order: number;
  start: () => SchedulableJob;
}

/**
 * Runs rendering jobs one (or a few) at a time, lowest priority number
 * first. The PDF.js worker renders pages sequentially anyway; queueing here
 * means pages that scroll away are dropped before they cost anything, and
 * visible pages overtake thumbnails.
 */
export class RenderScheduler {
  #pending = new Map<string, Entry>();
  #running = new Map<string, SchedulableJob>();
  #order = 0;

  constructor(private readonly concurrency = 1) {}

  /** Queues (or re-queues with a new priority) a job. A running job with the same id is left alone. */
  schedule(id: string, priority: number, start: () => SchedulableJob): void {
    if (this.#running.has(id)) return;
    this.#pending.set(id, { id, priority, order: (this.#order += 1), start });
    this.#pump();
  }

  /** Drops a queued job, or cancels it if it is running. */
  cancel(id: string): void {
    this.#pending.delete(id);
    const job = this.#running.get(id);
    if (job) {
      this.#running.delete(id);
      job.cancel();
      this.#pump();
    }
  }

  cancelAll(): void {
    this.#pending.clear();
    for (const [id, job] of this.#running) {
      this.#running.delete(id);
      job.cancel();
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get runningCount(): number {
    return this.#running.size;
  }

  #next(): Entry | undefined {
    let best: Entry | undefined;
    for (const entry of this.#pending.values()) {
      if (
        !best ||
        entry.priority < best.priority ||
        (entry.priority === best.priority && entry.order < best.order)
      ) {
        best = entry;
      }
    }
    return best;
  }

  #pump(): void {
    while (this.#running.size < this.concurrency) {
      const entry = this.#next();
      if (!entry) return;
      this.#pending.delete(entry.id);
      let job: SchedulableJob;
      try {
        job = entry.start();
      } catch {
        continue;
      }
      this.#running.set(entry.id, job);
      const finish = () => {
        if (this.#running.get(entry.id) === job) {
          this.#running.delete(entry.id);
          this.#pump();
        }
      };
      job.promise.then(finish, finish);
    }
  }
}
