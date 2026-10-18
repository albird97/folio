import type {
  AppCommand,
  IncomingFile,
  KeyValueStorage,
  OperatingSystem,
  PlatformAdapter,
  RuntimeFeatures,
  RuntimePlatform,
  Unsubscribe,
} from './types';

export function detectOperatingSystem(nav: Navigator | undefined = globalThis.navigator): OperatingSystem {
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

/** Opens a hidden `<input type="file">`. Resolves to [] when the user cancels. */
export function pickFilesWithInput(options: { multiple?: boolean; doc?: Document } = {}): Promise<File[]> {
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

export function createLocalStorage(prefix: string, store: Storage | undefined = globalThis.localStorage): KeyValueStorage {
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
  printing: false,
  clipboardWrite: true,
  browserTabIntegration: false,
  nativeMessaging: false,
};

export interface WebAdapterOptions {
  platform?: RuntimePlatform;
  features?: Partial<RuntimeFeatures>;
  storage?: KeyValueStorage;
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
    deliverFiles(files) {
      incoming.emit(files);
    },
  };
}
