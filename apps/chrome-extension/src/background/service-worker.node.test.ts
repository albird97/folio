import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEntry } from '../shared/activity';
import type { MessageResponse } from '../shared/messages';
import { ACTIVITY_KEY, DEFAULT_SETTINGS, SETTINGS_KEY } from '../shared/settings';

type Listener<A extends unknown[]> = (...args: A) => unknown;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve));

/**
 * A stand-in for the parts of `chrome` the worker uses. Like Chrome, storage
 * applies operations in the order they are issued and answers each one
 * asynchronously; here the test decides when the next one runs.
 */
function createFakeChrome(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = structuredClone(initial);
  const pending: (() => void)[] = [];
  const changeListeners: Listener<[Record<string, chrome.storage.StorageChange>, string]>[] = [];
  const permissionListeners: Listener<[chrome.permissions.Permissions]>[] = [];
  let onMessage: Listener<[unknown, chrome.runtime.MessageSender, (r: unknown) => void]> | null =
    null;
  let failNextSet = false;

  const enqueue = <T>(operation: () => T) =>
    new Promise<T>((resolve, reject) => {
      pending.push(() => {
        try {
          resolve(operation());
        } catch (error) {
          reject(error as Error);
        }
      });
    });

  const local = {
    get: (keys: string | string[]) =>
      enqueue(() =>
        Object.fromEntries(
          (typeof keys === 'string' ? [keys] : keys)
            .filter((key) => key in data)
            .map((key) => [key, structuredClone(data[key])]),
        ),
      ),
    set: (items: Record<string, unknown>) =>
      enqueue(() => {
        if (failNextSet) {
          failNextSet = false;
          throw new Error('QUOTA_BYTES quota exceeded');
        }
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        for (const listener of changeListeners) listener(changes, 'local');
      }),
    remove: (keys: string | string[]) =>
      enqueue(() => {
        for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
      }),
  };

  const chromeApi = {
    runtime: {
      id: 'folio',
      getURL: (path: string) => `chrome-extension://folio/${path}`,
      getManifest: () => ({ version: '0.1.0' }),
      onMessage: { addListener: (listener: typeof onMessage) => (onMessage = listener) },
      onConnect: { addListener: () => undefined },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
    },
    storage: {
      local,
      onChanged: {
        addListener: (listener: (typeof changeListeners)[number]) => changeListeners.push(listener),
      },
    },
    tabs: { create: async () => ({}) },
    sidePanel: { setPanelBehavior: async () => undefined },
    permissions: {
      remove: async () => true,
      onRemoved: {
        addListener: (listener: Listener<[chrome.permissions.Permissions]>) =>
          permissionListeners.push(listener),
      },
    },
  };

  return {
    chrome: chromeApi,
    data,
    failNextSet: () => (failNextSet = true),
    /** Delivers a message from one of the extension's pages. */
    send: (message: unknown) =>
      new Promise<MessageResponse>((resolve) => {
        const sender = { id: 'folio', url: 'chrome-extension://folio/editor.html' };
        onMessage!(message, sender, (response) => resolve(response as MessageResponse));
      }),
    /** Chrome reports that the user removed some of Folio's permissions. */
    removePermissions: (removed: chrome.permissions.Permissions) =>
      permissionListeners.forEach((listener) => listener(removed)),
    /** Applies the next storage operation and lets the worker react to it. */
    async step() {
      pending.shift()?.();
      await tick();
    },
    /** Applies storage operations until none are left. */
    async run() {
      await tick();
      while (pending.length > 0) await this.step();
    },
  };
}

async function loadWorker(initial: Record<string, unknown> = {}) {
  const fake = createFakeChrome(initial);
  vi.resetModules();
  vi.stubGlobal('chrome', fake.chrome);
  await import('./service-worker');
  return fake;
}

const record = (fileName?: string) => ({ type: 'activity/record', kind: 'opened', fileName });

function entry(id: string, fileName: string | null = null): ActivityEntry {
  return { id, at: '2026-10-18T10:00:00.000Z', kind: 'opened', pageCount: 1, fileName };
}

describe('service worker activity log', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps every entry when several records overlap', async () => {
    const fake = await loadWorker();
    const responses = Promise.all([fake.send(record()), fake.send(record()), fake.send(record())]);
    await fake.run();
    expect(await responses).toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    expect(fake.data[ACTIVITY_KEY]).toHaveLength(3);
  });

  it('does not let a record in flight undo a Clear', async () => {
    const fake = await loadWorker({ [ACTIVITY_KEY]: [entry('old-1'), entry('old-2')] });
    const responses = Promise.all([fake.send(record()), fake.send({ type: 'activity/clear' })]);
    await fake.run();
    await responses;
    expect(fake.data[ACTIVITY_KEY]).toEqual([]);

    const later = Promise.all([fake.send({ type: 'activity/clear' }), fake.send(record())]);
    await fake.run();
    await later;
    expect(fake.data[ACTIVITY_KEY]).toEqual([expect.objectContaining({ kind: 'opened' })]);
  });

  it('does not let a redaction in flight undo a Clear', async () => {
    const fake = await loadWorker({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, activityIncludesNames: true },
      [ACTIVITY_KEY]: [entry('old', 'salary.pdf')],
    });
    // The user turns file names off and clicks Clear while the worker is
    // still reading the log to redact it.
    void fake.chrome.storage.local.set({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, activityIncludesNames: false },
    });
    await fake.step();
    const cleared = fake.send({ type: 'activity/clear' });
    await fake.run();
    await cleared;
    expect(fake.data[ACTIVITY_KEY]).toEqual([]);
  });

  it('never keeps a file name recorded under settings that were just turned off', async () => {
    const fake = await loadWorker({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, activityIncludesNames: true },
    });
    const response = fake.send(record('salary.pdf'));
    // Let the record read the log and the settings while names are still on…
    await fake.step();
    await fake.step();
    // …then turn names off before it writes. The redaction must remove the name.
    void fake.chrome.storage.local.set({
      [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, activityIncludesNames: false },
    });
    await fake.run();
    await response;
    expect(fake.data[ACTIVITY_KEY]).toEqual([expect.objectContaining({ fileName: null })]);
  });

  it('keeps processing after a failed write', async () => {
    const fake = await loadWorker();
    fake.failNextSet();
    const failed = fake.send(record());
    const next = fake.send(record());
    await fake.run();
    expect(await failed).toEqual({ ok: false, error: 'failed' });
    expect(await next).toMatchObject({ ok: true });
    expect(fake.data[ACTIVITY_KEY]).toHaveLength(1);
  });
});

describe('service worker Ask Claude key', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const KEY = 'sk-ant-api03-test-key-0123456789';

  it('stores a key, says only whether one is stored, and forgets it', async () => {
    const fake = await loadWorker();
    const status = async () => {
      const response = fake.send({ type: 'ai/status' });
      await fake.run();
      return response;
    };
    expect(await status()).toEqual({ ok: true, ai: { hasKey: false } });

    const set = fake.send({ type: 'ai/set-key', key: `  ${KEY}\n` });
    await fake.run();
    expect(await set).toEqual({ ok: true });
    expect(fake.data['ai-api-key']).toBe(KEY);
    // The key never comes back to a page.
    expect(JSON.stringify(await status())).not.toContain(KEY);
    expect(await status()).toEqual({ ok: true, ai: { hasKey: true } });

    const forget = fake.send({ type: 'ai/forget-key' });
    await fake.run();
    expect(await forget).toEqual({ ok: true });
    expect(fake.data).not.toHaveProperty('ai-api-key');
  });

  it('refuses text that cannot be a key', async () => {
    const fake = await loadWorker();
    const response = fake.send({ type: 'ai/set-key', key: 'not a key\r\nx-other: 1' });
    await fake.run();
    expect(await response).toEqual({ ok: false, error: 'invalid-message' });
    expect(fake.data).not.toHaveProperty('ai-api-key');
  });

  it('forgets the key when access to Anthropic’s API is removed', async () => {
    const fake = await loadWorker({ 'ai-api-key': KEY });
    fake.removePermissions({ origins: ['https://example.com/*'] });
    await fake.run();
    expect(fake.data['ai-api-key']).toBe(KEY);
    fake.removePermissions({ origins: ['https://api.anthropic.com/*'] });
    await fake.run();
    expect(fake.data).not.toHaveProperty('ai-api-key');
  });
});
