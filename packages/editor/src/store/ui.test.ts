import { createMemoryStorage } from '@folio/platform-adapters';
import { describe, expect, it } from 'vitest';
import { createUiStore, DEFAULT_STYLE, UI_STORAGE_KEY } from './ui';

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
    await settle();
    // The other page already stored it.
    expect(storage.data.has(UI_STORAGE_KEY)).toBe(false);
  });

  it('does not write back late echoes of its own writes', async () => {
    // Like chrome.storage: changes reach every watcher, the writer included,
    // asynchronously and only when the stored value actually changed.
    const base = createMemoryStorage();
    const listeners: Array<(value: unknown) => void> = [];
    let writes = 0;
    const storage = {
      ...base,
      async set<T>(key: string, value: T) {
        writes += 1;
        const changed = JSON.stringify(base.data.get(key)) !== JSON.stringify(value);
        await base.set(key, value);
        if (changed) {
          const echoed = structuredClone(value);
          setTimeout(() => listeners.forEach((listener) => listener(echoed)), 5);
        }
      },
      watch: (_key: string, listener: (value: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    };
    const store = createUiStore(storage);
    await settle();
    const rightPanel: boolean[] = [];
    store.subscribe((state) => rightPanel.push(state.rightPanelOpen));
    // Both changes land before the first echo arrives.
    store.getState().toggleLeftPanel();
    store.getState().toggleRightPanel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(writes).toBe(2);
    // The late echo of the first write must not briefly reopen the panel.
    expect(rightPanel).toEqual([true, false]);
    expect(store.getState()).toMatchObject({ leftPanelOpen: false, rightPanelOpen: false });
    expect(base.data.get(UI_STORAGE_KEY)).toMatchObject({
      leftPanelOpen: false,
      rightPanelOpen: false,
    });
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
      sidebarTab: 'pages',
      style: DEFAULT_STYLE,
      authorName: '',
      ocrLanguages: ['eng'],
    });
  });

  it('remembers the languages text was recognized in, keeping only known ones', async () => {
    const storage = createMemoryStorage({
      [UI_STORAGE_KEY]: { ocrLanguages: ['klingon', 'ind', 'chi_sim', 'ind'] },
    });
    const store = createUiStore(storage);
    await settle();
    expect(store.getState().ocrLanguages).toEqual(['ind', 'chi_sim']);
    store.getState().setOcrLanguages(['eng', 'chi_tra']);
    // A choice of nothing is not remembered.
    store.getState().setOcrLanguages([]);
    await settle();
    expect(storage.data.get(UI_STORAGE_KEY)).toMatchObject({ ocrLanguages: ['eng', 'chi_tra'] });

    const empty = createUiStore(createMemoryStorage({ [UI_STORAGE_KEY]: { ocrLanguages: [] } }));
    await settle();
    expect(empty.getState().ocrLanguages).toEqual(['eng']);
  });

  it('remembers annotation styles, keeping only valid values', async () => {
    const storage = createMemoryStorage({
      [UI_STORAGE_KEY]: {
        style: { colors: { ink: '#123456', note: 'red' }, strokeWidth: 400, fontFamily: 'comic' },
        authorName: 'Ada',
      },
    });
    const store = createUiStore(storage);
    await settle();
    expect(store.getState().style).toMatchObject({
      colors: { ink: '#123456', note: DEFAULT_STYLE.colors.note },
      strokeWidth: 24,
      fontFamily: 'sans',
    });
    expect(store.getState().authorName).toBe('Ada');
    store.getState().setToolColor('highlight', '#0ca678');
    store.getState().setStyle({ fontSize: 18 });
    // The tool itself is not remembered: every session starts with Select.
    store.getState().setTool('ink');
    await settle();
    expect(storage.data.get(UI_STORAGE_KEY)).toMatchObject({
      style: { colors: { highlight: '#0ca678' }, fontSize: 18 },
    });
    expect(storage.data.get(UI_STORAGE_KEY)).not.toHaveProperty('tool');
  });

  it('opens the sidebar on a tab and remembers the tab', async () => {
    const storage = createMemoryStorage({
      [UI_STORAGE_KEY]: { leftPanelOpen: false, sidebarTab: 'bookmarks' },
    });
    const store = createUiStore(storage);
    await settle();
    expect(store.getState()).toMatchObject({ leftPanelOpen: false, sidebarTab: 'pages' });
    store.getState().showSidebar('results');
    await settle();
    expect(store.getState()).toMatchObject({ leftPanelOpen: true, sidebarTab: 'results' });
    expect(storage.data.get(UI_STORAGE_KEY)).toMatchObject({ sidebarTab: 'results' });
  });

  it('gives waiting questions the cautious answer when their dialog goes away', async () => {
    const store = createUiStore(createMemoryStorage());
    const conflict = new Promise((resolve) =>
      store.getState().openDialog({ kind: 'save-conflict', docKey: 'a', resolve }),
    );
    // Another dialog takes its place: the save is cancelled, not left hanging.
    const quit = new Promise((resolve) => store.getState().openDialog({ kind: 'quit', resolve }));
    expect(await conflict).toBe('cancel');
    store.getState().closeDialog();
    expect(await quit).toBe(false);
    expect(store.getState().dialog).toBeNull();

    // An answer given before the dialog closes stands.
    const answered = new Promise<boolean>((resolve) =>
      store.getState().openDialog({ kind: 'quit', resolve }),
    );
    const dialog = store.getState().dialog;
    if (dialog?.kind === 'quit') dialog.resolve(true);
    store.getState().closeDialog();
    expect(await answered).toBe(true);
  });
});
