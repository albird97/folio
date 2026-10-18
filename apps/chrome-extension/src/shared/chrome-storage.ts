import type { KeyValueStorage } from '@folio/platform-adapters';

/** chrome.storage.local, which every extension page and the service worker share. */
export function createChromeStorage(
  area: chrome.storage.StorageArea = chrome.storage.local,
): KeyValueStorage {
  return {
    async get<T>(key: string) {
      const values = await area.get(key);
      return values[key] as T | undefined;
    },
    async set<T>(key: string, value: T) {
      await area.set({ [key]: value });
    },
    async remove(key: string) {
      await area.remove(key);
    },
    watch(key, listener) {
      const onChanged = (
        changes: Record<string, chrome.storage.StorageChange>,
        areaName: string,
      ) => {
        if (areaName === 'local' && key in changes) listener(changes[key]?.newValue);
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    },
  };
}
