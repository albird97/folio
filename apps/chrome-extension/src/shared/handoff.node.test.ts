import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteHandoff,
  HANDOFF_TTL_MS,
  isHandoffExpired,
  purgeExpiredHandoffs,
  putHandoff,
  takeHandoff,
} from './handoff';

type Row = Record<string, unknown>;
type Rows = Map<string, Row>;

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

/** Answers requests asynchronously and in order, and completes once none are pending. */
class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;
  #pending = 0;
  #complete = false;

  constructor(private readonly stores: Map<string, Rows>) {
    this.#settle();
  }

  objectStore(name: string) {
    const rows = this.stores.get(name)!;
    const schedule = <T>(request: FakeRequest<T>, compute: () => T) => {
      this.#pending += 1;
      setTimeout(() => {
        request.result = compute();
        request.onsuccess?.();
        this.#pending -= 1;
        this.#settle();
      });
      return request;
    };
    return {
      put: (value: Row) =>
        schedule(new FakeRequest(), () => {
          rows.set(value.id as string, structuredClone(value));
          return value.id;
        }),
      get: (key: string) => schedule(new FakeRequest(), () => structuredClone(rows.get(key))),
      delete: (key: string) => schedule(new FakeRequest(), () => void rows.delete(key)),
      openCursor: () => {
        const request = new FakeRequest<unknown>();
        const keys = [...rows.keys()].sort();
        const step = () =>
          schedule(request, () => {
            let key = keys.shift();
            while (key !== undefined && !rows.has(key)) key = keys.shift();
            if (key === undefined) return null;
            return {
              value: structuredClone(rows.get(key)),
              delete: () => schedule(new FakeRequest(), () => void rows.delete(key)),
              continue: step,
            };
          });
        step();
        return request;
      },
    };
  }

  #settle() {
    setTimeout(() => {
      if (this.#pending > 0 || this.#complete) return;
      this.#complete = true;
      this.oncomplete?.();
    });
  }
}

/** Just enough of IndexedDB for handoff.ts, kept in memory. */
function createFakeIndexedDb() {
  const databases = new Map<string, { version: number; stores: Map<string, Rows> }>();
  const factory = {
    open(name: string, version: number) {
      const request = new FakeRequest<unknown>();
      setTimeout(() => {
        const existing = databases.get(name);
        const database = existing ?? { version: 0, stores: new Map<string, Rows>() };
        databases.set(name, database);
        request.result = {
          createObjectStore: (store: string) => database.stores.set(store, new Map()),
          transaction: () => new FakeTransaction(database.stores),
          close: () => undefined,
        };
        if (database.version < version) {
          database.version = version;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return {
    factory,
    /** Ids of the hand-offs still on "disk". */
    ids: () => [...(databases.get('folio')?.stores.get('handoffs')?.keys() ?? [])].sort(),
  };
}

describe('handoffs', () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  let db: ReturnType<typeof createFakeIndexedDb>;
  let now: number;

  beforeEach(() => {
    db = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', db.factory);
    now = Date.UTC(2026, 9, 18, 10);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hands a document over exactly once', async () => {
    const id = await putHandoff('report.pdf', bytes);
    const record = await takeHandoff(id);
    expect(record?.name).toBe('report.pdf');
    expect(new Uint8Array(record!.bytes)).toEqual(bytes);
    expect(await takeHandoff(id)).toBeNull();
    expect(db.ids()).toEqual([]);
  });

  it('ignores and deletes a record older than ten minutes', async () => {
    const id = await putHandoff('report.pdf', bytes);
    now += HANDOFF_TTL_MS + 1;
    expect(await takeHandoff(id)).toBeNull();
    expect(db.ids()).toEqual([]);
  });

  it('purges expired records whenever a hand-off is written', async () => {
    await putHandoff('never-read.pdf', bytes);
    now += HANDOFF_TTL_MS + 1;
    const fresh = await putHandoff('fresh.pdf', bytes);
    expect(db.ids()).toEqual([fresh]);
  });

  it('purges expired records whenever a hand-off is read', async () => {
    const neverRead = await putHandoff('never-read.pdf', bytes);
    now += HANDOFF_TTL_MS / 2;
    const read = await putHandoff('read.pdf', bytes);
    expect(db.ids()).toEqual([neverRead, read].sort());
    now += HANDOFF_TTL_MS / 2 + 1;
    expect((await takeHandoff(read))?.name).toBe('read.pdf');
    expect(db.ids()).toEqual([]);
  });

  it('purges only expired records at start-up and counts them', async () => {
    await putHandoff('old.pdf', bytes);
    now += HANDOFF_TTL_MS / 2;
    const recent = await putHandoff('recent.pdf', bytes);
    now += HANDOFF_TTL_MS / 2 + 1;
    expect(await purgeExpiredHandoffs()).toBe(1);
    expect(db.ids()).toEqual([recent]);
    expect(await purgeExpiredHandoffs()).toBe(0);
  });

  it('deletes a hand-off that will not be read', async () => {
    const id = await putHandoff('report.pdf', bytes);
    await deleteHandoff(id);
    expect(db.ids()).toEqual([]);
  });

  it('expires records strictly after the time to live', () => {
    expect(isHandoffExpired({ createdAt: 0 }, HANDOFF_TTL_MS)).toBe(false);
    expect(isHandoffExpired({ createdAt: 0 }, HANDOFF_TTL_MS + 1)).toBe(true);
  });
});
