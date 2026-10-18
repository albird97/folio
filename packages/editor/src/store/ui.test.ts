import { createMemoryStorage } from '@folio/platform-adapters';
import { describe, expect, it } from 'vitest';
import { createUiStore, UI_STORAGE_KEY } from './ui';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ui store', () => {
  it('hydrates valid settings and ignores invalid ones', async () => {
    const storage = createMemoryStorage({
      [UI_STORAGE_KEY]: { theme: 'dark', leftPanelOpen: 'yes', rightPanelOpen: false },
    });
    const store = createUiStore(storage);
    expect(store.getState().hydrated).toBe(false);
    await settle();
    expect(store.getState()).toMatchObject({
      hydrated: true,
      theme: 'dark',
      leftPanelOpen: true,
      rightPanelOpen: false,
    });
  });

  it('follows changes made by other pages', async () => {
    const listeners: Array<(value: unknown) => void> = [];
    const storage = {
      ...createMemoryStorage(),
      watch: (_key: string, listener: (value: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const store = createUiStore(storage);
    await settle();
    listeners.forEach((listener) =>
      listener({ theme: 'dark', leftPanelOpen: true, rightPanelOpen: true }),
    );
    expect(store.getState().theme).toBe('dark');
  });

  it('persists changes after hydration', async () => {
    const storage = createMemoryStorage();
    const store = createUiStore(storage);
    await settle();
    store.getState().setTheme('light');
    store.getState().toggleLeftPanel();
    await settle();
    expect(storage.data.get(UI_STORAGE_KEY)).toEqual({
      theme: 'light',
      leftPanelOpen: false,
      rightPanelOpen: true,
    });
  });
});
