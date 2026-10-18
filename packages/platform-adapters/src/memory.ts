import { Channel, WEB_FEATURES } from './web';
import type { AppCommand, IncomingFile, KeyValueStorage, PlatformAdapter, RuntimeFeatures } from './types';

export function createMemoryStorage(initial: Record<string, unknown> = {}): KeyValueStorage & {
  data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
    async remove(key: string) {
      data.delete(key);
    },
  };
}

export function memoryFile(name: string, bytes: Uint8Array): IncomingFile {
  return {
    name,
    size: bytes.byteLength,
    origin: { kind: 'local-file', handle: null },
    read: async () => bytes.slice(),
  };
}

/** A scriptable adapter for tests. */
export function createMemoryPlatformAdapter(features: Partial<RuntimeFeatures> = {}) {
  const incoming = new Channel<IncomingFile[]>(true);
  const commands = new Channel<AppCommand>();
  const hover = new Channel<boolean>();
  const picks: IncomingFile[][] = [];
  const clipboard: string[] = [];
  const titles: string[] = [];
  const adapter: PlatformAdapter = {
    platform: 'web',
    os: 'unknown',
    features: { ...WEB_FEATURES, ...features },
    storage: createMemoryStorage(),
    pickPdfFiles: async () => picks.shift() ?? [],
    onIncomingFiles: (listener) => incoming.subscribe(listener),
    onCommand: (listener) => commands.subscribe(listener),
    onNativeDragHover: (listener) => hover.subscribe(listener),
    writeClipboardText: async (text) => {
      clipboard.push(text);
    },
    setWindowTitle: (title) => {
      titles.push(title);
    },
  };
  return {
    adapter,
    clipboard,
    titles,
    queuePick: (files: IncomingFile[]) => picks.push(files),
    deliver: (files: IncomingFile[]) => incoming.emit(files),
    command: (command: AppCommand) => commands.emit(command),
    hover: (value: boolean) => hover.emit(value),
  };
}
