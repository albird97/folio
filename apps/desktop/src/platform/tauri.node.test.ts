import { isPdfError } from '@folio/pdf-core';
import type { IncomingFile, TransferRequest } from '@folio/platform-adapters';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NativeCommandError,
  createTauriPlatformAdapter,
  nativeMessagingStatus,
  registerNativeMessaging,
  unregisterNativeMessaging,
} from './tauri';

type Handler = (event: { payload: unknown }) => void;
type Responder = (args: unknown, options: unknown) => unknown;

interface Call {
  command: string;
  args: unknown;
  options: { headers?: Record<string, string> } | undefined;
}

const tauri = vi.hoisted(() => ({
  listeners: new Map<string, Handler>(),
  responses: new Map<string, unknown>(),
  calls: [] as Call[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: unknown, options?: Call['options']) => {
    tauri.calls.push({ command, args, options });
    const response = tauri.responses.get(command);
    return typeof response === 'function' ? (response as Responder)(args, options) : response;
  }),
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

/** Rejects like a Tauri command returning `Err(CommandError)`. */
function rejectWith(code: string, message: string): Responder {
  return () => Promise.reject({ code, message });
}

function callsTo(command: string): Call[] {
  return tauri.calls.filter((call) => call.command === command);
}

function lastCall(command: string): Call {
  const call = callsTo(command).at(-1);
  if (!call) throw new Error(`${command} was not invoked`);
  return call;
}

async function readError(file: IncomingFile | undefined): Promise<unknown> {
  return file?.read().then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('desktop platform adapter', () => {
  beforeEach(() => {
    tauri.listeners.clear();
    tauri.responses.clear();
    tauri.calls.length = 0;
    tauri.responses.set('app_info', { version: '0.1.0', os: 'macos', arch: 'aarch64' });
    tauri.responses.set('take_pending_files', nothing);
    tauri.responses.set('take_pending_transfers', []);
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

  it('only forwards menu commands it knows, including the new page commands', async () => {
    const adapter = await createTauriPlatformAdapter();
    const commands = vi.fn();
    adapter.onCommand(commands);
    for (const command of ['save', 'save-as', 'print', 'undo', 'extract-pages', 'quit', 'rm']) {
      fire('folio://menu', command);
    }
    expect(commands.mock.calls.flat()).toEqual([
      'save',
      'save-as',
      'print',
      'undo',
      'extract-pages',
    ]);
  });

  describe('saving', () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45]);

    it('keeps write access to a file saved with Save As', async () => {
      const adapter = await createTauriPlatformAdapter();
      tauri.responses.set('save_pdf_as', { name: 'Final report.pdf', token: 'new-token' });
      const result = await adapter.saveFileAs({
        suggestedName: 'Rapport été.pdf',
        bytes,
        keepAccess: true,
      });
      expect(result).toEqual({ status: 'saved', name: 'Final report.pdf', handle: 'new-token' });
      const call = lastCall('save_pdf_as');
      expect(call.args).toBe(bytes);
      expect(call.options?.headers).toEqual({
        'x-folio-name': 'Rapport%20%C3%A9t%C3%A9.pdf',
        'x-folio-keep-access': '1',
      });
    });

    it('saves a copy without keeping access, and reports cancelling', async () => {
      const adapter = await createTauriPlatformAdapter();
      tauri.responses.set('save_pdf_as', { name: 'Copy.pdf', token: null });
      expect(await adapter.saveFileAs({ suggestedName: 'Copy.pdf', bytes })).toEqual({
        status: 'saved',
        name: 'Copy.pdf',
        handle: null,
      });
      expect(lastCall('save_pdf_as').options?.headers).toEqual({ 'x-folio-name': 'Copy.pdf' });
      tauri.responses.set('save_pdf_as', null);
      expect(await adapter.saveFileAs({ suggestedName: 'Copy.pdf', bytes })).toEqual({
        status: 'cancelled',
      });
      tauri.responses.set('save_pdf_as', rejectWith('not-pdf', 'Only PDF data can be saved.'));
      await expect(adapter.saveFileAs({ suggestedName: 'x', bytes })).rejects.toThrow(
        'Only PDF data can be saved.',
      );
    });

    it('writes back through the grant only while the file is unchanged', async () => {
      const adapter = await createTauriPlatformAdapter();
      const expectedSha256 = 'ab'.repeat(32);
      tauri.responses.set('write_granted_file', { status: 'saved' });
      expect(await adapter.writeFile({ handle: 'tok', bytes, expectedSha256 })).toEqual({
        status: 'saved',
      });
      const call = lastCall('write_granted_file');
      expect(call.args).toBe(bytes);
      expect(call.options?.headers).toEqual({
        'x-folio-token': 'tok',
        'x-folio-expected-sha256': expectedSha256,
      });

      tauri.responses.set('write_granted_file', { status: 'changed-on-disk' });
      expect(await adapter.writeFile({ handle: 'tok', bytes, expectedSha256 })).toEqual({
        status: 'changed-on-disk',
      });

      tauri.responses.set('write_granted_file', { status: 'saved' });
      await adapter.writeFile({
        handle: 'tok',
        bytes,
        expectedSha256,
        overwriteExternalChanges: true,
      });
      expect(lastCall('write_granted_file').options?.headers).toMatchObject({
        'x-folio-overwrite': '1',
      });
    });

    it('reports files that cannot be written back as unavailable', async () => {
      const adapter = await createTauriPlatformAdapter();
      const request = { handle: 'tok', bytes, expectedSha256: '00'.repeat(32) };
      tauri.responses.set('write_granted_file', {
        status: 'unavailable',
        message: 'The file is read-only.',
      });
      expect(await adapter.writeFile(request)).toEqual({
        status: 'unavailable',
        message: 'The file is read-only.',
      });
      tauri.responses.set(
        'write_granted_file',
        rejectWith('unknown-token', 'No longer available.'),
      );
      const released = await adapter.writeFile(request);
      expect(released.status).toBe('unavailable');
      expect(released.status === 'unavailable' && released.message).toMatch(/Save As/);
      tauri.responses.set(
        'write_granted_file',
        rejectWith('not-pdf', 'Only PDF data can be saved.'),
      );
      const error = await adapter.writeFile(request).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NativeCommandError);
      expect((error as NativeCommandError).code).toBe('not-pdf');
    });

    it('gives write access back and prints through the native window', async () => {
      const adapter = await createTauriPlatformAdapter();
      adapter.releaseHandle('tok');
      expect(lastCall('release_file').args).toEqual({ token: 'tok' });
      await adapter.print();
      expect(callsTo('print_window')).toHaveLength(1);
      tauri.responses.set('print_window', rejectWith('print-failed', 'No printer dialog.'));
      await expect(adapter.print()).rejects.toThrow('No printer dialog.');
    });
  });

  describe('crash recovery', () => {
    it('stores snapshots and files as raw data', async () => {
      const adapter = await createTauriPlatformAdapter();
      await adapter.recovery.saveSnapshot({ id: 'doc-1', title: 'Q3 / Été' }, '{"v":1}');
      const snapshot = lastCall('recovery_save_snapshot');
      expect(new TextDecoder().decode(snapshot.args as Uint8Array)).toBe('{"v":1}');
      expect(snapshot.options?.headers).toEqual({
        'x-folio-recovery-id': 'doc-1',
        'x-folio-recovery-title': 'Q3%20%2F%20%C3%89t%C3%A9',
      });

      const file = new Uint8Array([1, 2]);
      await adapter.recovery.saveFile('doc-1', 'sha_abc', file);
      const saved = lastCall('recovery_save_file');
      expect(saved.args).toBe(file);
      expect(saved.options?.headers).toEqual({
        'x-folio-recovery-id': 'doc-1',
        'x-folio-recovery-key': 'sha_abc',
      });

      tauri.responses.set('recovery_has_file', true);
      expect(await adapter.recovery.hasFile('doc-1', 'sha_abc')).toBe(true);
      expect(lastCall('recovery_has_file').args).toEqual({ id: 'doc-1', key: 'sha_abc' });
    });

    it('refuses ids that could name other files before asking the native side', async () => {
      const adapter = await createTauriPlatformAdapter();
      await expect(adapter.recovery.saveSnapshot({ id: '../x', title: 't' }, '{}')).rejects.toThrow(
        /Invalid recovery id/,
      );
      await expect(adapter.recovery.saveFile('doc', 'a/b', new Uint8Array())).rejects.toThrow(
        /Invalid recovery file key/,
      );
      expect(await adapter.recovery.hasFile('..', 'key')).toBe(false);
      expect(await adapter.recovery.load('..')).toBeNull();
      expect(tauri.calls.filter((call) => call.command.startsWith('recovery_'))).toEqual([]);
    });

    it('lists, loads and removes records', async () => {
      const adapter = await createTauriPlatformAdapter();
      const record = {
        id: 'doc-1',
        title: 'a.pdf',
        savedAt: '2026-10-18T10:00:00.000Z',
        byteLength: 9,
      };
      tauri.responses.set('recovery_list', [record]);
      expect(await adapter.recovery.list()).toEqual([record]);

      tauri.responses.set('recovery_load_snapshot', '{"v":1}');
      tauri.responses.set('recovery_file_keys', ['a', 'b']);
      tauri.responses.set(
        'recovery_load_file',
        (args: unknown) => new TextEncoder().encode((args as { key: string }).key.repeat(2)).buffer,
      );
      const loaded = await adapter.recovery.load('doc-1');
      expect(loaded?.snapshot).toBe('{"v":1}');
      expect([...(loaded?.files ?? new Map()).entries()]).toEqual([
        ['a', new TextEncoder().encode('aa')],
        ['b', new TextEncoder().encode('bb')],
      ]);

      tauri.responses.set('recovery_load_snapshot', null);
      expect(await adapter.recovery.load('doc-2')).toBeNull();

      await adapter.recovery.remove('doc-1');
      expect(lastCall('recovery_remove').args).toEqual({ id: 'doc-1' });

      tauri.responses.set('recovery_list', rejectWith('storage-failed', 'Could not read.'));
      await expect(adapter.recovery.list()).rejects.toThrow('Could not read.');
    });
  });

  describe('recent files', () => {
    it('lists, reopens, removes and clears them', async () => {
      const adapter = await createTauriPlatformAdapter();
      const recent = adapter.recentFiles;
      if (!recent) throw new Error('desktop has recent files');
      const files = [{ id: 'r1', name: 'a.pdf', openedAt: '2026-10-18T10:00:00.000Z' }];
      tauri.responses.set('recent_list', files);
      expect(await recent.list()).toEqual(files);

      tauri.responses.set('recent_open', {
        files: [{ token: 'tok', name: 'a.pdf', size: 3 }],
        skipped: [],
        unavailable: [],
      });
      const [opened] = await recent.open('r1');
      expect(lastCall('recent_open').args).toEqual({ id: 'r1' });
      expect(opened?.origin).toEqual({ kind: 'local-file', handle: 'tok' });

      tauri.responses.set('recent_open', { ...nothing, unavailable: ['moved.pdf'] });
      const [gone] = await recent.open('r2');
      expect(gone?.name).toBe('moved.pdf');
      expect((await readError(gone)) as Error).toBeInstanceOf(Error);

      await recent.remove('r1');
      expect(lastCall('recent_remove').args).toEqual({ id: 'r1' });
      await recent.clear();
      expect(callsTo('recent_clear')).toHaveLength(1);
    });

    it('notifies about changes', async () => {
      const adapter = await createTauriPlatformAdapter();
      const changed = vi.fn();
      const unsubscribe = adapter.recentFiles?.onChange(changed);
      fire('folio://recent-changed', null);
      unsubscribe?.();
      fire('folio://recent-changed', null);
      expect(changed).toHaveBeenCalledTimes(1);
    });
  });

  describe('closing with unsaved changes', () => {
    it('reports unsaved changes to the native close guard once per change', async () => {
      const adapter = await createTauriPlatformAdapter();
      // A reloaded page starts without a guard.
      expect(callsTo('set_close_guard').map((call) => call.args)).toEqual([{ enabled: false }]);
      adapter.setUnsavedChanges(true);
      adapter.setUnsavedChanges(true);
      adapter.setUnsavedChanges(false);
      expect(callsTo('set_close_guard').map((call) => call.args)).toEqual([
        { enabled: false },
        { enabled: true },
        { enabled: false },
      ]);
    });

    it('closes only when the UI agrees', async () => {
      const adapter = await createTauriPlatformAdapter();
      const answers = [false, true];
      const handler = vi.fn(async () => answers.shift() ?? false);
      const unsubscribe = adapter.onCloseRequested?.(handler);

      fire('folio://close-requested', null);
      await settle();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(callsTo('confirm_close')).toHaveLength(0);
      // Declining is reported, so the request does not linger natively.
      expect(callsTo('cancel_close')).toHaveLength(1);

      fire('folio://close-requested', null);
      await settle();
      expect(callsTo('confirm_close')).toHaveLength(1);
      expect(callsTo('cancel_close')).toHaveLength(1);

      // Without a handler there is nothing to ask about.
      unsubscribe?.();
      fire('folio://close-requested', null);
      await settle();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(callsTo('confirm_close')).toHaveLength(2);
    });

    it('asks once while a prompt is open and keeps the window when the check fails', async () => {
      const adapter = await createTauriPlatformAdapter();
      let answer: (allowed: boolean) => void = () => undefined;
      const handler = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      );
      adapter.onCloseRequested?.(handler);
      fire('folio://close-requested', null);
      fire('folio://close-requested', null);
      await settle();
      expect(handler).toHaveBeenCalledTimes(1);
      answer(true);
      await settle();
      expect(callsTo('confirm_close')).toHaveLength(1);

      adapter.onCloseRequested?.(() => Promise.reject(new Error('dialog failed')));
      fire('folio://close-requested', null);
      await settle();
      expect(callsTo('confirm_close')).toHaveLength(1);
      expect(callsTo('cancel_close')).toHaveLength(1);
    });
  });

  describe('documents from the Chrome extension', () => {
    const request: TransferRequest = {
      id: 'f0e1d2c3-0000-4000-8000-000000000000',
      name: 'a.pdf',
      size: 3,
    };

    it('offers queued and new transfers', async () => {
      tauri.responses.set('take_pending_transfers', [request]);
      const adapter = await createTauriPlatformAdapter();
      const offered: TransferRequest[] = [];
      adapter.onTransferRequest?.((value) => offered.push(value));
      const later = { ...request, id: 'f0e1d2c3-0000-4000-8000-000000000001' };
      fire('folio://transfer-request', later);
      fire('folio://transfer-request', { id: 42 });
      expect(offered).toEqual([request, later]);
    });

    it('opens accepted documents without a file to save to', async () => {
      const adapter = await createTauriPlatformAdapter();
      tauri.responses.set('answer_transfer', {
        files: [{ token: 'spool', name: 'a.pdf', size: 3 }],
        skipped: [],
        unavailable: [],
      });
      tauri.responses.set('read_granted_file', new Uint8Array([7, 8, 9]).buffer);
      const [file] = (await adapter.answerTransfer?.(request.id, true)) ?? [];
      expect(lastCall('answer_transfer').args).toEqual({ id: request.id, accept: true });
      expect(file?.origin).toEqual({ kind: 'local-file', handle: null });
      expect(await file?.read()).toEqual(new Uint8Array([7, 8, 9]));
      expect(lastCall('read_granted_file').args).toEqual({ token: 'spool' });
      file?.release?.();
      expect(lastCall('release_file').args).toEqual({ token: 'spool' });
    });

    it('declines transfers', async () => {
      const adapter = await createTauriPlatformAdapter();
      tauri.responses.set('answer_transfer', nothing);
      expect(await adapter.answerTransfer?.(request.id, false)).toEqual([]);
      expect(lastCall('answer_transfer').args).toEqual({ id: request.id, accept: false });
      tauri.responses.set(
        'answer_transfer',
        rejectWith('unknown-transfer', 'This document is no longer available.'),
      );
      await expect(adapter.answerTransfer?.(request.id, true)).rejects.toThrow(
        'This document is no longer available.',
      );
    });
  });

  describe('native messaging registration', () => {
    it('reports, registers and unregisters the host', async () => {
      tauri.responses.set('native_messaging_status', { registered: false, extensionIds: [] });
      expect(await nativeMessagingStatus()).toEqual({ registered: false, extensionIds: [] });

      const id = 'abcdefghijklmnopabcdefghijklmnop';
      tauri.responses.set('register_native_messaging', { registered: true, extensionIds: [id] });
      expect(await registerNativeMessaging([id])).toEqual({ registered: true, extensionIds: [id] });
      expect(lastCall('register_native_messaging').args).toEqual({ extensionIds: [id] });

      tauri.responses.set('unregister_native_messaging', { registered: false, extensionIds: [] });
      expect((await unregisterNativeMessaging()).registered).toBe(false);
    });

    it('explains invalid extension ids', async () => {
      tauri.responses.set(
        'register_native_messaging',
        rejectWith('invalid-extension-id', 'Enter the ID of the Folio extension.'),
      );
      const error = await registerNativeMessaging(['nope']).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NativeCommandError);
      expect(error).toMatchObject({
        code: 'invalid-extension-id',
        message: 'Enter the ID of the Folio extension.',
      });
    });
  });
});
