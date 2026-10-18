import { PdfError } from '@folio/pdf-core';
import {
  APP_COMMANDS,
  Channel,
  createLocalStorage,
  createMemoryRecoveryStore,
  type AppCommand,
  type IncomingFile,
  type OperatingSystem,
  type PlatformAdapter,
} from '@folio/platform-adapters';
import { invoke } from '@tauri-apps/api/core';
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

interface CommandError {
  code: string;
  message: string;
}

/** Mirrors `files::SavedFile`: the chosen file's name, never its path. */
interface SavedFile {
  name: string;
}

/** Commands the native menus send (shared with `menu.rs`, which tests the same list). */
export const MENU_COMMANDS: ReadonlySet<AppCommand> = new Set(
  (menuCommands as string[]).filter((id): id is AppCommand =>
    (APP_COMMANDS as readonly string[]).includes(id),
  ),
);
/** Header carrying the proposed file name for `save_pdf_as` (see `save.rs`). */
const NAME_HEADER = 'x-folio-name';

const notFound = () =>
  new PdfError('unknown', 'The file could not be found. It may have been moved or deleted.');

function toPdfError(error: unknown): Error {
  const value = error as Partial<CommandError> | undefined;
  if (value?.code === 'too-large') return new PdfError('too-large');
  if (value?.code === 'not-found') return notFound();
  return new PdfError('unknown', value?.message ?? 'The file could not be read.');
}

function grantedToIncoming(file: GrantedFile): IncomingFile {
  return {
    name: file.name,
    size: file.size,
    origin: { kind: 'local-file', handle: file.token },
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

function toIncoming({ files, skipped, unavailable }: OpenedFiles): IncomingFile[] {
  return [
    ...files.map(grantedToIncoming),
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

  const deliver = (opened: OpenedFiles) => {
    const all = toIncoming(opened);
    if (all.length > 0) incoming.emit(all);
  };

  await listen<OpenedFiles>('folio://files-opened', (event) => deliver(event.payload));
  await listen<string>('folio://menu', (event) => {
    const command = event.payload as AppCommand;
    if (MENU_COMMANDS.has(command)) commands.emit(command);
  });
  await listen<boolean>('folio://drag-hover', (event) => hover.emit(event.payload === true));
  // Files from launch arguments or Finder arrive before the UI exists; they
  // are queued natively until the listener above is in place.
  deliver(await invoke<OpenedFiles>('take_pending_files'));

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
    async saveFileAs({ suggestedName, bytes }) {
      try {
        // The bytes travel as the raw request body; the name as a header.
        const saved = await invoke<SavedFile | null>('save_pdf_as', bytes, {
          headers: { [NAME_HEADER]: encodeURIComponent(suggestedName) },
        });
        return saved
          ? { status: 'saved', name: saved.name, handle: null }
          : { status: 'cancelled' };
      } catch (error) {
        const message = (error as Partial<CommandError> | undefined)?.message;
        throw new Error(message ?? 'The file could not be saved.');
      }
    },
    // Phase 4 replaces these with native implementations.
    async writeFile() {
      return {
        status: 'unavailable',
        message: 'Saving to the original file is not available yet.',
      };
    },
    releaseHandle() {},
    async print() {
      globalThis.window.print();
    },
    recovery: createMemoryRecoveryStore(),
    recentFiles: null,
    setUnsavedChanges() {},
  };
}
