/**
 * Moves a PDF from one extension page to another (side panel → editor tab)
 * through IndexedDB, which all pages of the extension share. Records are
 * single-use, deleted when read and purged after a short time, so documents
 * do not linger on disk.
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

export async function putHandoff(name: string, bytes: Uint8Array): Promise<string> {
  const id = newHandoffId();
  const record: HandoffRecord = {
    id,
    name,
    bytes: bytes.slice().buffer as ArrayBuffer,
    createdAt: Date.now(),
  };
  await withStore<void>('readwrite', (store, done) => {
    store.put(record);
    done(undefined);
  });
  return id;
}

/** Reads and deletes a handoff in one transaction. */
export async function takeHandoff(id: string): Promise<HandoffRecord | null> {
  return withStore<HandoffRecord | null>('readwrite', (store, done) => {
    done(null);
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as HandoffRecord | undefined;
      if (!record) return;
      store.delete(id);
      if (Date.now() - record.createdAt <= HANDOFF_TTL_MS) done(record);
    };
  });
}

export async function purgeExpiredHandoffs(now: number = Date.now()): Promise<number> {
  return withStore<number>('readwrite', (store, done) => {
    let purged = 0;
    done(0);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const record = cursor.value as HandoffRecord;
      if (now - record.createdAt > HANDOFF_TTL_MS) {
        cursor.delete();
        purged += 1;
        done(purged);
      }
      cursor.continue();
    };
  });
}
