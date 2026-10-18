import { describe, expect, it } from 'vitest';
import { RenderScheduler } from './render-scheduler';

function deferredJob(log: string[], id: string) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return {
    start: () => {
      log.push(`start ${id}`);
      return { promise, cancel: () => log.push(`cancel ${id}`) };
    },
    finish: async () => {
      resolve();
      await promise;
      await Promise.resolve();
    },
  };
}

describe('render scheduler', () => {
  it('runs the most urgent job first, one at a time', async () => {
    const log: string[] = [];
    const scheduler = new RenderScheduler(1);
    const a = deferredJob(log, 'a');
    const b = deferredJob(log, 'b');
    const c = deferredJob(log, 'c');
    scheduler.schedule('a', 5, a.start);
    scheduler.schedule('b', 9, b.start);
    scheduler.schedule('c', 1, c.start);
    expect(log).toEqual(['start a']);
    await a.finish();
    expect(log).toEqual(['start a', 'start c']);
    await c.finish();
    expect(log.at(-1)).toBe('start b');
    await b.finish();
    expect(scheduler.runningCount).toBe(0);
  });

  it('drops queued jobs and cancels running ones', async () => {
    const log: string[] = [];
    const scheduler = new RenderScheduler(1);
    const a = deferredJob(log, 'a');
    const b = deferredJob(log, 'b');
    scheduler.schedule('a', 1, a.start);
    scheduler.schedule('b', 2, b.start);
    scheduler.cancel('b');
    scheduler.cancel('a');
    expect(log).toEqual(['start a', 'cancel a']);
    expect(scheduler.pendingCount).toBe(0);
    await a.finish();
    expect(log).toEqual(['start a', 'cancel a']);
  });

  it('re-prioritises queued jobs and keeps going after failures', async () => {
    const log: string[] = [];
    const scheduler = new RenderScheduler(1);
    const blocker = deferredJob(log, 'x');
    scheduler.schedule('x', 0, blocker.start);
    const failing = {
      start: () => ({ promise: Promise.reject(new Error('boom')), cancel: () => undefined }),
    };
    const late = deferredJob(log, 'late');
    scheduler.schedule('late', 10, late.start);
    scheduler.schedule('fail', 5, failing.start);
    scheduler.schedule('late', 1, late.start);
    await blocker.finish();
    expect(log).toEqual(['start x', 'start late']);
    await late.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.runningCount + scheduler.pendingCount).toBe(0);
  });

  it('honours its concurrency', () => {
    const log: string[] = [];
    const scheduler = new RenderScheduler(2);
    for (const id of ['a', 'b', 'c']) scheduler.schedule(id, 1, deferredJob(log, id).start);
    expect(log).toEqual(['start a', 'start b']);
    scheduler.cancelAll();
    expect(log).toEqual(['start a', 'start b', 'cancel a', 'cancel b']);
  });
});
