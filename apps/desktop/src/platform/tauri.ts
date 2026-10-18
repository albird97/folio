import { PdfError } from '@folio/pdf-core';
import {
  APP_COMMANDS,
  Channel,
  createLocalStorage,
  type AppCommand,
  type IncomingFile,
  type OperatingSystem,
  type PlatformAdapter,
  type RecentFile,
  type RecentFiles,
  type RecoveryRecord,
  type RecoveryStore,
  type TransferRequest,
  type WriteFileResult,
} from '@folio/platform-adapters';
import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { TAURI_FEATURES } from './features';
import menuCommands from './menu-commands.json';

/** Mirrors `files::GrantedFile` in Rust. */
interface GrantedFile {
  token: string;
  name: string;
  size: number;
}

/** Mirrors `files::OpenedFiles` in Rust. Names only, never paths. */
interface OpenedFiles {
  files: GrantedFile[];
  /** Names of files that are not PDFs. */
  skipped: string[];
  /** Names of files that could no longer be found when they were granted. */
  unavailable: string[];
}

interface AppInfo {
  version: string;
  os: string;
  arch: string;
}

/** What Folio's commands reject with: `{ code, message }`, never paths. */
interface CommandError {
  code: string;
  message: string;
}

/** Mirrors `commands::SavedFile`: the chosen file's name, never its path. */
interface SavedFile {
  name: string;
  /** A grant for the new file when write access was asked for (Save As). */
  token: string | null;
}

/** Mirrors `native_messaging::Status`. */
export interface NativeMessagingStatus {
  /** Chrome would start this copy of Folio for the extensions below. */
  registered: boolean;
  extensionIds: string[];
}

/** An error reported by one of Folio's native commands. */
export class NativeCommandError extends Error {
  override readonly name = 'NativeCommandError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Commands the native menus send (shared with `menu.rs`, which tests the same list). */
export const MENU_COMMANDS: ReadonlySet<AppCommand> = new Set(
  (menuCommands as string[]).filter((id): id is AppCommand =>
    (APP_COMMANDS as readonly string[]).includes(id),
  ),
);

/** Request headers of Folio's binary commands (see `save.rs` and `recovery.rs`). */
const HEADERS = {
  name: 'x-folio-name',
  keepAccess: 'x-folio-keep-access',
  token: 'x-folio-token',
  expectedSha256: 'x-folio-expected-sha256',
  overwrite: 'x-folio-overwrite',
  recoveryId: 'x-folio-recovery-id',
  recoveryKey: 'x-folio-recovery-key',
  recoveryTitle: 'x-folio-recovery-title',
} as const;

const EVENTS = {
  filesOpened: 'folio://files-opened',
  menu: 'folio://menu',
  dragHover: 'folio://drag-hover',
  recentChanged: 'folio://recent-changed',
  closeRequested: 'folio://close-requested',
  transferRequest: 'folio://transfer-request',
} as const;

/** Recovery record ids and file keys, as `recovery.rs` validates them. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

const encoder = new TextEncoder();

const notFound = () =>
  new PdfError('unknown', 'The file could not be found. It may have been moved or deleted.');

function commandError(error: unknown): Partial<CommandError> {
  if (typeof error === 'string') return { message: error };
  return (error ?? {}) as Partial<CommandError>;
}

function toNativeError(error: unknown, fallback: string): NativeCommandError {
  const { code, message } = commandError(error);
  return new NativeCommandError(code ?? 'unknown', message ?? fallback);
}

/** Invokes a command, turning its `{ code, message }` rejection into an Error. */
async function call<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
  fallback = 'Folio could not complete this action.',
): Promise<T> {
  try {
    return await invoke<T>(command, args, options);
  } catch (error) {
    throw toNativeError(error, fallback);
  }
}

function toPdfError(error: unknown): Error {
  const value = commandError(error);
  if (value.code === 'too-large') return new PdfError('too-large');
  if (value.code === 'not-found') return notFound();
  return new PdfError('unknown', value.message ?? 'The file could not be read.');
}

/**
 * Documents from Chrome are read through their token but have no file to
 * save to, so their origin carries no handle (Save becomes Save As).
 */
function grantedToIncoming(file: GrantedFile, writable = true): IncomingFile {
  return {
    name: file.name,
    size: file.size,
    origin: { kind: 'local-file', handle: writable ? file.token : null },
    async read() {
      try {
        return new Uint8Array(
          await invoke<ArrayBuffer>('read_granted_file', { token: file.token }),
        );
      } catch (error) {
        throw toPdfError(error);
      }
    },
    release() {
      void invoke('release_file', { token: file.token }).catch(() => undefined);
    },
  };
}

/** A file that was not granted, so it can still get a notice or an error tab. */
function failedToIncoming(name: string, error: () => Error): IncomingFile {
  return {
    name,
    size: 0,
    origin: { kind: 'local-file', handle: null },
    read: () => Promise.reject(error()),
  };
}

function toIncoming({ files, skipped, unavailable }: OpenedFiles, writable = true): IncomingFile[] {
  return [
    ...files.map((file) => grantedToIncoming(file, writable)),
    ...skipped.map((name) => failedToIncoming(name, () => new PdfError('not-a-pdf'))),
    ...unavailable.map((name) => failedToIncoming(name, notFound)),
  ];
}

function toOperatingSystem(os: string): OperatingSystem {
  if (os === 'macos') return 'macos';
  if (os === 'windows') return 'windows';
  if (os === 'linux') return 'linux';
  return 'unknown';
}

function isTransferRequest(value: unknown): value is TransferRequest {
  const request = value as Partial<TransferRequest> | null;
  return (
    typeof request?.id === 'string' &&
    typeof request.name === 'string' &&
    typeof request.size === 'number'
  );
}

function assertSafeName(kind: string, value: string): void {
  if (!SAFE_NAME.test(value)) throw new Error(`Invalid recovery ${kind}.`);
}

/**
 * Crash recovery data in Folio's app data folder (`recovery.rs`). Snapshots
 * and files travel as raw request bodies; ids and keys are validated on both
 * sides before anything is stored.
 */
function createTauriRecoveryStore(): RecoveryStore {
  const failed = 'Recovery data could not be stored.';
  return {
    list: () => call<RecoveryRecord[]>('recovery_list'),
    async saveSnapshot({ id, title }, snapshot) {
      assertSafeName('id', id);
      await call<void>(
        'recovery_save_snapshot',
        encoder.encode(snapshot),
        {
          headers: {
            [HEADERS.recoveryId]: id,
            [HEADERS.recoveryTitle]: encodeURIComponent(title),
          },
        },
        failed,
      );
    },
    async saveFile(id, key, bytes) {
      assertSafeName('id', id);
      assertSafeName('file key', key);
      await call<void>(
        'recovery_save_file',
        bytes,
        { headers: { [HEADERS.recoveryId]: id, [HEADERS.recoveryKey]: key } },
        failed,
      );
    },
    async hasFile(id, key) {
      if (!SAFE_NAME.test(id) || !SAFE_NAME.test(key)) return false;
      return call<boolean>('recovery_has_file', { id, key });
    },
    async load(id) {
      if (!SAFE_NAME.test(id)) return null;
      const snapshot = await call<string | null>('recovery_load_snapshot', { id });
      if (snapshot === null) return null;
      const keys = await call<string[]>('recovery_file_keys', { id });
      const files = new Map<string, Uint8Array>();
      for (const key of keys) {
        files.set(key, new Uint8Array(await call<ArrayBuffer>('recovery_load_file', { id, key })));
      }
      return { snapshot, files };
    },
    async remove(id) {
      if (!SAFE_NAME.test(id)) return;
      await call<void>('recovery_remove', { id });
    },
  };
}

/** Whether Chrome can reach this copy of Folio (desktop settings). */
export function nativeMessagingStatus(): Promise<NativeMessagingStatus> {
  return call<NativeMessagingStatus>('native_messaging_status');
}

/**
 * Registers Folio as the native messaging host for the Folio extension
 * (ids are 32 letters from a to p) and returns the new status.
 */
export function registerNativeMessaging(extensionIds: string[]): Promise<NativeMessagingStatus> {
  return call<NativeMessagingStatus>('register_native_messaging', { extensionIds });
}

export function unregisterNativeMessaging(): Promise<NativeMessagingStatus> {
  return call<NativeMessagingStatus>('unregister_native_messaging');
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The desktop adapter. Files are only reachable through opaque tokens the
 * Rust side issues after the user picked, dropped or launched them, so the
 * webview can never read a file it was not granted. It does not need or
 * receive paths from Folio's own commands and events, which carry tokens and
 * names only. Drag hover therefore comes from `folio://drag-hover`: Tauri's
 * built-in `tauri://drag-*` events include the dragged paths and are not
 * listened to (`core:event:allow-listen` cannot be scoped by event name, so a
 * compromised page could still subscribe to them).
 */
export async function createTauriPlatformAdapter(): Promise<PlatformAdapter & { info: AppInfo }> {
  const info = await invoke<AppInfo>('app_info');
  const incoming = new Channel<IncomingFile[]>(true);
  const commands = new Channel<AppCommand>();
  const hover = new Channel<boolean>();
  const recentChanged = new Channel<undefined>();
  const transfers = new Channel<TransferRequest>(true);
  let closeHandler: (() => Promise<boolean>) | null = null;
  let closing = false;
  let unsaved = false;

  const deliver = (opened: OpenedFiles) => {
    const all = toIncoming(opened);
    if (all.length > 0) incoming.emit(all);
  };

  /** Runs the UI's check, then lets the window close or Folio quit. */
  const onCloseRequested = async () => {
    if (closing) return;
    closing = true;
    try {
      const allowed = closeHandler ? await closeHandler() : true;
      if (allowed) await invoke('confirm_close');
    } catch {
      // Keeping the window open is the safe outcome for unsaved work.
    } finally {
      closing = false;
    }
  };

  await listen<OpenedFiles>(EVENTS.filesOpened, (event) => deliver(event.payload));
  await listen<string>(EVENTS.menu, (event) => {
    const command = event.payload as AppCommand;
    if (MENU_COMMANDS.has(command)) commands.emit(command);
  });
  await listen<boolean>(EVENTS.dragHover, (event) => hover.emit(event.payload === true));
  await listen(EVENTS.recentChanged, () => recentChanged.emit(undefined));
  await listen(EVENTS.closeRequested, () => void onCloseRequested());
  await listen<TransferRequest>(EVENTS.transferRequest, (event) => {
    if (isTransferRequest(event.payload)) transfers.emit(event.payload);
  });
  // A reloaded page starts without unsaved work.
  await invoke('set_close_guard', { enabled: false }).catch(() => undefined);
  // Files from launch arguments or Finder, and documents from Chrome, arrive
  // before the UI exists; they are queued natively until the listeners above
  // are in place.
  deliver(await invoke<OpenedFiles>('take_pending_files'));
  for (const request of await invoke<TransferRequest[]>('take_pending_transfers')) {
    if (isTransferRequest(request)) transfers.emit(request);
  }

  const recentFiles: RecentFiles = {
    list: () => call<RecentFile[]>('recent_list'),
    async open(id) {
      return toIncoming(await call<OpenedFiles>('recent_open', { id }));
    },
    async remove(id) {
      await call<void>('recent_remove', { id });
    },
    async clear() {
      await call<void>('recent_clear');
    },
    onChange: (listener) => recentChanged.subscribe(() => listener()),
  };

  const window = getCurrentWindow();
  return {
    info,
    platform: 'desktop',
    os: toOperatingSystem(info.os),
    features: TAURI_FEATURES,
    storage: createLocalStorage('folio:'),
    async pickPdfFiles(options) {
      const opened = await invoke<OpenedFiles>('pick_pdf_files', {
        multiple: options?.multiple ?? false,
      });
      return toIncoming(opened);
    },
    onIncomingFiles: (listener) => incoming.subscribe(listener),
    onCommand: (listener) => commands.subscribe(listener),
    onNativeDragHover: (listener) => hover.subscribe(listener),
    async writeClipboardText(text) {
      await navigator.clipboard.writeText(text);
    },
    setWindowTitle(title) {
      void window.setTitle(title).catch(() => undefined);
    },
    async saveFileAs({ suggestedName, bytes, keepAccess }) {
      // The bytes travel as the raw request body; the name as a header.
      const headers: Record<string, string> = {
        [HEADERS.name]: encodeURIComponent(suggestedName),
      };
      if (keepAccess) headers[HEADERS.keepAccess] = '1';
      const saved = await call<SavedFile | null>(
        'save_pdf_as',
        bytes,
        { headers },
        'The file could not be saved.',
      );
      return saved
        ? { status: 'saved', name: saved.name, handle: saved.token ?? null }
        : { status: 'cancelled' };
    },
    async writeFile({ handle, bytes, expectedSha256, overwriteExternalChanges }) {
      const headers: Record<string, string> = {
        [HEADERS.token]: handle,
        [HEADERS.expectedSha256]: expectedSha256,
      };
      if (overwriteExternalChanges) headers[HEADERS.overwrite] = '1';
      try {
        return await invoke<WriteFileResult>('write_granted_file', bytes, { headers });
      } catch (error) {
        // The grant was released (or never existed): only Save As can help.
        if (commandError(error).code === 'unknown-token') {
          return {
            status: 'unavailable',
            message: 'This file is no longer available to Folio. Use Save As to save the document.',
          };
        }
        throw toNativeError(error, 'The file could not be saved.');
      }
    },
    releaseHandle(handle) {
      void invoke('release_file', { token: handle }).catch(() => undefined);
    },
    async print() {
      await call<void>('print_window', undefined, undefined, 'The document could not be printed.');
    },
    recovery: createTauriRecoveryStore(),
    recentFiles,
    setUnsavedChanges(value) {
      if (value === unsaved) return;
      unsaved = value;
      void invoke('set_close_guard', { enabled: value }).catch(() => undefined);
    },
    onCloseRequested(handler) {
      closeHandler = handler;
      return () => {
        if (closeHandler === handler) closeHandler = null;
      };
    },
    onTransferRequest: (listener) => transfers.subscribe(listener),
    async answerTransfer(id, accept) {
      const opened = await call<OpenedFiles>('answer_transfer', { id, accept });
      return toIncoming(opened, false);
    },
  };
}
