import { isPdfError } from '@folio/pdf-core';
import type { IncomingFile } from '@folio/platform-adapters';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTauriPlatformAdapter } from './tauri';

type Handler = (event: { payload: unknown }) => void;

const tauri = vi.hoisted(() => ({
  listeners: new Map<string, Handler>(),
  responses: new Map<string, unknown>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => tauri.responses.get(command)),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    tauri.listeners.set(event, handler);
    return () => tauri.listeners.delete(event);
  }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: async () => undefined }),
}));

const nothing = { files: [], skipped: [], unavailable: [] };

function fire(event: string, payload: unknown) {
  const handler = tauri.listeners.get(event);
  if (!handler) throw new Error(`nothing listens to ${event}`);
  handler({ payload });
}

async function readError(file: IncomingFile | undefined): Promise<unknown> {
  return file?.read().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('desktop platform adapter', () => {
  beforeEach(() => {
    tauri.listeners.clear();
    tauri.responses.clear();
    tauri.responses.set('app_info', { version: '0.1.0', os: 'macos', arch: 'aarch64' });
    tauri.responses.set('take_pending_files', nothing);
  });

  it("takes drag hover from Folio's path-free event, not Tauri's drag events", async () => {
    const adapter = await createTauriPlatformAdapter();
    const events = [...tauri.listeners.keys()];
    expect(events).toContain('folio://drag-hover');
    expect(events.filter((event) => event.startsWith('tauri://'))).toEqual([]);

    const hover = vi.fn();
    adapter.onNativeDragHover(hover);
    fire('folio://drag-hover', true);
    fire('folio://drag-hover', false);
    expect(hover.mock.calls).toEqual([[true], [false]]);
  });

  it('reports picked files that could not be granted instead of dropping them', async () => {
    const adapter = await createTauriPlatformAdapter();
    tauri.responses.set('pick_pdf_files', {
      files: [{ token: 't1', name: 'a.pdf', size: 3 }],
      skipped: ['scan.tiff'],
      unavailable: ['moved.pdf'],
    });
    tauri.responses.set('read_granted_file', new Uint8Array([1, 2, 3]).buffer);

    const [granted, skipped, unavailable, ...rest] = await adapter.pickPdfFiles({ multiple: true });
    expect([granted?.name, skipped?.name, unavailable?.name]).toEqual([
      'a.pdf',
      'scan.tiff',
      'moved.pdf',
    ]);
    expect(rest).toEqual([]);
    expect(granted?.origin).toEqual({ kind: 'local-file', handle: 't1' });
    expect(await granted?.read()).toEqual(new Uint8Array([1, 2, 3]));
    expect(isPdfError(await readError(skipped), 'not-a-pdf')).toBe(true);
    const missing = await readError(unavailable);
    expect(isPdfError(missing, 'unknown')).toBe(true);
    expect((missing as Error).message).toMatch(/could not be found/);
  });

  it('delivers files that vanished before the UI was ready as errors', async () => {
    tauri.responses.set('take_pending_files', { ...nothing, unavailable: ['gone.pdf'] });
    const adapter = await createTauriPlatformAdapter();
    const received: IncomingFile[][] = [];
    adapter.onIncomingFiles((files) => received.push(files));
    expect(received.map((files) => files.map((file) => file.name))).toEqual([['gone.pdf']]);
    expect(await readError(received[0]?.[0])).toBeInstanceOf(Error);

    fire('folio://files-opened', { ...nothing, skipped: ['notes.txt'] });
    expect(received[1]?.map((file) => file.name)).toEqual(['notes.txt']);
  });
});
