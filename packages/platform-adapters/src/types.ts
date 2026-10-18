import type { DocumentOrigin } from '@folio/document-model';

export type RuntimePlatform = 'desktop' | 'chrome-extension' | 'web';
export type OperatingSystem = 'macos' | 'windows' | 'linux' | 'chromeos' | 'unknown';
export type Unsubscribe = () => void;

/**
 * A file the user chose (picker, drop, file association, extension hand-off).
 * Bytes are read lazily so large files are only loaded once they are opened.
 */
export interface IncomingFile {
  name: string;
  size: number;
  origin: DocumentOrigin;
  read(): Promise<Uint8Array>;
  /** Releases native resources (e.g. a desktop file grant) once the file is closed. */
  release?(): void;
}

/** Commands that a native menu or the keyboard can trigger. */
export type AppCommand =
  | 'open'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'toggle-left-panel'
  | 'toggle-right-panel'
  | 'cycle-theme';

export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * What this running adapter can actually do. Keys correspond to rows of the
 * capability matrix and are checked against it in tests.
 */
export interface RuntimeFeatures {
  nativeFileDialogs: boolean;
  /** Files dropped on the page arrive as DOM drop events. */
  webDragAndDrop: boolean;
  /** Files dropped on the window are delivered by the native layer. */
  nativeDragAndDrop: boolean;
  fileAssociations: boolean;
  nativeMenus: boolean;
  saveInPlace: boolean;
  printing: boolean;
  clipboardWrite: boolean;
  browserTabIntegration: boolean;
  nativeMessaging: boolean;
}

export interface PlatformAdapter {
  readonly platform: RuntimePlatform;
  readonly os: OperatingSystem;
  readonly features: RuntimeFeatures;
  readonly storage: KeyValueStorage;

  /** Shows a PDF picker. Must be called from a user gesture. Resolves to [] on cancel. */
  pickPdfFiles(options?: { multiple?: boolean }): Promise<IncomingFile[]>;
  /** Files that arrive without a picker. Listeners registered late still receive queued files. */
  onIncomingFiles(listener: (files: IncomingFile[]) => void): Unsubscribe;
  onCommand(listener: (command: AppCommand) => void): Unsubscribe;
  /** OS-level drag hover, for platforms where the page cannot observe it. */
  onNativeDragHover(listener: (hovering: boolean) => void): Unsubscribe;
  writeClipboardText(text: string): Promise<void>;
  setWindowTitle(title: string): void;
}
