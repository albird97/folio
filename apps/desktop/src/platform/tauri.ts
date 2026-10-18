import { PdfError } from '@folio/pdf-core';
import {
  Channel,
  createLocalStorage,
  type AppCommand,
  type IncomingFile,
  type OperatingSystem,
  type PlatformAdapter,
  type RuntimeFeatures,
} from '@folio/platform-adapters';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Mirrors `files::GrantedFile` in Rust. */
interface GrantedFile {
  token: string;
  name: string;
  size: number;
}

/** Mirrors `lib::OpenedFiles` in Rust. */
interface OpenedFiles {
  files: GrantedFile[];
  /** Names of dropped files that were not PDFs (never paths). */
  skipped: string[];
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

/** What the desktop build supports. Checked against the capability matrix in tests. */
export const TAURI_FEATURES: RuntimeFeatures = {
  nativeFileDialogs: true,
  webDragAndDrop: false,
  nativeDragAndDrop: true,
  fileAssociations: true,
  nativeMenus: true,
  saveInPlace: false,
  printing: false,
  clipboardWrite: true,
  browserTabIntegration: false,
  nativeMessaging: false,
};

const MENU_COMMANDS: ReadonlySet<string> = new Set<AppCommand>([
  'open',
  'close-tab',
  'next-tab',
  'previous-tab',
  'toggle-left-panel',
  'toggle-right-panel',
  'cycle-theme',
]);

function toPdfError(error: unknown): Error {
  const value = error as Partial<CommandError> | undefined;
  if (value?.code === 'too-large') return new PdfError('too-large');
  if (value?.code === 'not-found') return new PdfError('unknown', 'The file could not be found. It may have been moved or deleted.');
  return new PdfError('unknown', value?.message ?? 'The file could not be read.');
}

function grantedToIncoming(file: GrantedFile): IncomingFile {
  return {
    name: file.name,
    size: file.size,
    origin: { kind: 'local-file', handle: file.token },
    async read() {
      try {
        return new Uint8Array(await invoke<ArrayBuffer>('read_granted_file', { token: file.token }));
      } catch (error) {
        throw toPdfError(error);
      }
    },
    release() {
      void invoke('release_file', { token: file.token }).catch(() => undefined);
    },
  };
}

function skippedToIncoming(name: string): IncomingFile {
  return {
    name,
    size: 0,
    origin: { kind: 'local-file', handle: null },
    read: () => Promise.reject(new PdfError('not-a-pdf')),
  };
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
 * webview never handles filesystem paths.
 */
export async function createTauriPlatformAdapter(): Promise<PlatformAdapter & { info: AppInfo }> {
  const info = await invoke<AppInfo>('app_info');
  const incoming = new Channel<IncomingFile[]>(true);
  const commands = new Channel<AppCommand>();
  const hover = new Channel<boolean>();

  const deliver = ({ files, skipped }: OpenedFiles) => {
    const all = [...files.map(grantedToIncoming), ...skipped.map(skippedToIncoming)];
    if (all.length > 0) incoming.emit(all);
  };

  await listen<OpenedFiles>('folio://files-opened', (event) => deliver(event.payload));
  await listen<string>('folio://menu', (event) => {
    if (MENU_COMMANDS.has(event.payload)) commands.emit(event.payload as AppCommand);
  });
  await getCurrentWebview().onDragDropEvent((event) => {
    hover.emit(event.payload.type === 'enter' || event.payload.type === 'over');
  });
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
      const files = await invoke<GrantedFile[]>('pick_pdf_files', { multiple: options?.multiple ?? false });
      return files.map(grantedToIncoming);
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
  };
}
