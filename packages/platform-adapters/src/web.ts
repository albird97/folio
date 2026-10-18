import { createIndexedDbRecoveryStore } from './recovery';
import type {
  AppCommand,
  IncomingFile,
  KeyValueStorage,
  OperatingSystem,
  PlatformAdapter,
  RecoveryStore,
  RuntimeFeatures,
  RuntimePlatform,
  Unsubscribe,
} from './types';

export function detectOperatingSystem(
  nav: Navigator | undefined = globalThis.navigator,
): OperatingSystem {
  if (!nav) return 'unknown';
  const hint =
    (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    nav.userAgent;
  if (/mac/i.test(hint)) return 'macos';
  if (/win/i.test(hint)) return 'windows';
  if (/cros|chrome ?os/i.test(hint)) return 'chromeos';
  if (/linux/i.test(hint)) return 'linux';
  return 'unknown';
}

export function isPdfFileName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/** Wraps a DOM File (picker or drop) without reading it yet. */
export function incomingFromFile(file: File): IncomingFile {
  return {
    name: file.name,
    size: file.size,
    origin: { kind: 'local-file', handle: null },
    read: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

/** A safe download file name: no path separators or control characters, ending in `.pdf`. */
export function pdfFileName(name: string): string {
  const cleaned = Array.from(name, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || '\\/:*?"<>|'.includes(char) ? ' ' : char;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const base = cleaned.length > 0 ? cleaned : 'Document';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

/**
 * Saves through the browser's download mechanism: an object URL clicked as a
 * download link. Needs no extension permission; Chrome's own settings decide
 * whether a "Save as" dialog appears.
 */
export function downloadBytes(
  name: string,
  bytes: Uint8Array,
  doc: Document = globalThis.document,
): void {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
  );
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  doc.body.append(link);
  link.click();
  link.remove();
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Opens a hidden `<input type="file">`. Resolves to [] when the user cancels. */
export function pickFilesWithInput(
  options: { multiple?: boolean; doc?: Document } = {},
): Promise<File[]> {
  const doc = options.doc ?? globalThis.document;
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    input.multiple = options.multiple ?? false;
    input.style.display = 'none';
    const finish = (files: File[]) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    doc.body.append(input);
    input.click();
  });
}

export function createLocalStorage(
  prefix: string,
  store: Storage | undefined = globalThis.localStorage,
): KeyValueStorage {
  const key = (name: string) => `${prefix}${name}`;
  return {
    async get<T>(name: string) {
      try {
        const raw = store?.getItem(key(name));
        return raw == null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    },
    async set<T>(name: string, value: T) {
      try {
        store?.setItem(key(name), JSON.stringify(value));
      } catch {
        // Storage can be unavailable (private mode, quota); settings then last for the session.
      }
    },
    async remove(name: string) {
      try {
        store?.removeItem(key(name));
      } catch {
        // See above.
      }
    },
  };
}

/** A small listener set with replay for events that may fire before anyone listens. */
export class Channel<T> {
  #listeners = new Set<(value: T) => void>();
  #queue: T[] = [];

  constructor(private readonly replay: boolean = false) {}

  emit(value: T): void {
    if (this.#listeners.size === 0 && this.replay) {
      this.#queue.push(value);
      return;
    }
    for (const listener of this.#listeners) listener(value);
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    this.#listeners.add(listener);
    if (this.#queue.length > 0) {
      const queued = this.#queue.splice(0);
      for (const value of queued) listener(value);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export const WEB_FEATURES: RuntimeFeatures = {
  nativeFileDialogs: false,
  webDragAndDrop: true,
  nativeDragAndDrop: false,
  fileAssociations: false,
  nativeMenus: false,
  saveInPlace: false,
  saveCopy: true,
  printing: true,
  crashRecovery: true,
  recentFiles: false,
  openFromUrl: false,
  clipboardWrite: true,
  browserTabIntegration: false,
  nativeMessaging: false,
};

/**
 * Asks the browser to confirm leaving the page while there is unsaved work.
 * Browsers show their own wording; pages cannot customize it.
 */
export function createLeaveGuard(target: Window | undefined = globalThis.window) {
  let unsaved = false;
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!unsaved) return;
    event.preventDefault();
    // Older Chromium versions still need returnValue to be set.
    event.returnValue = '';
  };
  target?.addEventListener('beforeunload', onBeforeUnload);
  return (value: boolean) => {
    unsaved = value;
  };
}

export interface WebAdapterOptions {
  platform?: RuntimePlatform;
  features?: Partial<RuntimeFeatures>;
  storage?: KeyValueStorage;
  recovery?: RecoveryStore;
}

/**
 * The reference adapter for plain web pages. The Chrome extension builds on
 * it, and the desktop UI falls back to it when run in a normal browser
 * during development and UI tests.
 */
export function createWebPlatformAdapter(options: WebAdapterOptions = {}): PlatformAdapter & {
  deliverFiles(files: IncomingFile[]): void;
} {
  const incoming = new Channel<IncomingFile[]>(true);
  const commands = new Channel<AppCommand>();
  const setUnsavedChanges = createLeaveGuard();
  return {
    platform: options.platform ?? 'web',
    os: detectOperatingSystem(),
    features: { ...WEB_FEATURES, ...options.features },
    storage: options.storage ?? createLocalStorage('folio:'),
    async pickPdfFiles(pickOptions) {
      const files = await pickFilesWithInput({ multiple: pickOptions?.multiple ?? false });
      return files.map(incomingFromFile);
    },
    onIncomingFiles: (listener) => incoming.subscribe(listener),
    onCommand: (listener) => commands.subscribe(listener),
    onNativeDragHover: () => () => undefined,
    async writeClipboardText(text) {
      await globalThis.navigator.clipboard.writeText(text);
    },
    setWindowTitle(title) {
      globalThis.document.title = title;
    },
    async saveFileAs({ suggestedName, bytes }) {
      const name = pdfFileName(suggestedName);
      downloadBytes(name, bytes);
      return { status: 'downloaded', name };
    },
    async writeFile() {
      return {
        status: 'unavailable',
        message: 'This browser cannot write to the original file. Download a copy instead.',
      };
    },
    releaseHandle() {},
    async print() {
      globalThis.window.print();
    },
    recovery: options.recovery ?? createIndexedDbRecoveryStore(),
    recentFiles: null,
    setUnsavedChanges,
    deliverFiles(files) {
      incoming.emit(files);
    },
  };
}
