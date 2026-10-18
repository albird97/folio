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
  | 'save-copy'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'toggle-left-panel'
  | 'toggle-right-panel'
  | 'cycle-theme'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-actual-size'
  | 'zoom-fit-width'
  | 'zoom-fit-page'
  | 'rotate-clockwise'
  | 'rotate-counterclockwise'
  | 'go-to-page'
  | 'find'
  | 'find-next'
  | 'find-previous';

export const APP_COMMANDS: readonly AppCommand[] = [
  'open',
  'save-copy',
  'close-tab',
  'next-tab',
  'previous-tab',
  'toggle-left-panel',
  'toggle-right-panel',
  'cycle-theme',
  'zoom-in',
  'zoom-out',
  'zoom-actual-size',
  'zoom-fit-width',
  'zoom-fit-page',
  'rotate-clockwise',
  'rotate-counterclockwise',
  'go-to-page',
  'find',
  'find-next',
  'find-previous',
];

export interface SaveFileRequest {
  /** File name to propose, e.g. "Report.pdf". */
  suggestedName: string;
  bytes: Uint8Array;
}

export type SaveFileResult =
  /** Written where the user chose in a save dialog. */
  | { status: 'saved'; name: string }
  /** Handed to the browser's downloads. */
  | { status: 'downloaded'; name: string }
  | { status: 'cancelled' };

export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** Notifies about changes made elsewhere (another extension page, another window). */
  watch?(key: string, listener: (value: unknown) => void): Unsubscribe;
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
  /** Writing a new file: a save dialog on desktop, a download in browsers. */
  saveCopy: boolean;
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
  /** Saves a new PDF file (never overwrites the open document without the user choosing it). */
  saveFileAs(request: SaveFileRequest): Promise<SaveFileResult>;
}
