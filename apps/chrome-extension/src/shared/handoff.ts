/**
 * Moves a PDF from one extension page to another (side panel → editor tab)
 * through IndexedDB, which all pages of the extension share. Records are
 * single use: reading one deletes it. A record older than ten minutes is
 * ignored, and expired records are purged on every hand-off written or read,
 * when the browser starts and when the extension is installed or updated, so
 * documents do not linger on disk. (A timer would need the "alarms"
 * permission, which Folio does not request.)
 */
const DB_NAME = 'folio';
const STORE = 'handoffs';
export const HANDOFF_TTL_MS = 10 * 60 * 1000;

export interface HandoffRecord {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      let result: T;
      run(transaction.objectStore(STORE), (value) => {
        result = value;
      });
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export function newHandoffId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isHandoffExpired(record: Pick<HandoffRecord, 'createdAt'>, now: number): boolean {
  return now - record.createdAt > HANDOFF_TTL_MS;
}

/** Deletes every expired record, reporting the running count to `counted`. */
function deleteExpired(
  store: IDBObjectStore,
  now: number,
  counted: (purged: number) => void = () => undefined,
): void {
  let purged = 0;
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (isHandoffExpired(cursor.value as HandoffRecord, now)) {
      cursor.delete();
      purged += 1;
      counted(purged);
    }
    cursor.continue();
  };
}

export async function putHandoff(name: string, bytes: Uint8Array): Promise<string> {
  const id = newHandoffId();
  const now = Date.now();
  const record: HandoffRecord = {
    id,
    name,
    bytes: bytes.slice().buffer as ArrayBuffer,
    createdAt: now,
  };
  await withStore<void>('readwrite', (store, done) => {
    deleteExpired(store, now);
    store.put(record);
    done(undefined);
  });
  return id;
}

/** Reads and deletes a handoff in one transaction. */
export async function takeHandoff(id: string): Promise<HandoffRecord | null> {
  const now = Date.now();
  return withStore<HandoffRecord | null>('readwrite', (store, done) => {
    done(null);
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as HandoffRecord | undefined;
      if (!record) return;
      store.delete(id);
      if (!isHandoffExpired(record, now)) done(record);
    };
    deleteExpired(store, now);
  });
}

/** Deletes a handoff that will never be read, e.g. because the editor did not open. */
export async function deleteHandoff(id: string): Promise<void> {
  await withStore<void>('readwrite', (store, done) => {
    store.delete(id);
    done(undefined);
  });
}

export async function purgeExpiredHandoffs(now: number = Date.now()): Promise<number> {
  return withStore<number>('readwrite', (store, done) => {
    done(0);
    deleteExpired(store, now, done);
  });
}
