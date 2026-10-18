/**
 * Recovery records belong to the window working on them. Several windows can
 * share one recovery store (editor tabs of the extension), so each window
 * holds a Web Lock per record it writes or restores; records locked by
 * another window are not offered as recovered work. Without the Web Locks API
 * (older webviews, where Folio has a single window) every record counts as
 * free.
 */
const PREFIX = 'folio-recovery:';

/** Releases of the locks this window holds, by record id. */
const held = new Map<string, () => void>();

const locks = (): LockManager | undefined => globalThis.navigator?.locks;

/** Takes a record for this window. Resolves false when another window has it. */
export function claimRecord(id: string): Promise<boolean> {
  const manager = locks();
  if (held.has(id) || !manager) return Promise.resolve(true);
  return new Promise((resolve) => {
    manager
      .request(`${PREFIX}${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        return new Promise<void>((release) => {
          held.set(id, release);
          resolve(true);
        });
      })
      .catch(() => resolve(true));
  });
}

/** Gives a record up, so another window may offer it again. */
export function releaseRecord(id: string): void {
  held.get(id)?.();
  held.delete(id);
}

/** Records another window is working on. */
export async function recordsInUse(): Promise<Set<string>> {
  const manager = locks();
  const ids = new Set<string>();
  if (!manager) return ids;
  try {
    const snapshot = await manager.query();
    for (const lock of snapshot.held ?? []) {
      if (lock.name?.startsWith(PREFIX)) ids.add(lock.name.slice(PREFIX.length));
    }
  } catch {
    // Treat every record as free.
  }
  for (const id of held.keys()) ids.delete(id);
  return ids;
}
