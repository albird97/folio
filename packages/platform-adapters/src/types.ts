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
  | 'open-url'
  | 'save'
  | 'save-as'
  | 'save-copy'
  | 'print'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'undo'
  | 'redo'
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
  | 'find-previous'
  | 'insert-pages'
  | 'insert-blank-page'
  | 'rotate-pages-clockwise'
  | 'rotate-pages-counterclockwise'
  | 'delete-pages'
  | 'extract-pages'
  // Tools
  | 'sign'
  | 'page-numbers'
  | 'watermark'
  | 'recognize-text'
  | 'export-images'
  | 'export-text'
  | 'reduce-file-size'
  | 'protect'
  | 'ask-ai';

export const APP_COMMANDS: readonly AppCommand[] = [
  'open',
  'open-url',
  'save',
  'save-as',
  'save-copy',
  'print',
  'close-tab',
  'next-tab',
  'previous-tab',
  'undo',
  'redo',
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
  'insert-pages',
  'insert-blank-page',
  'rotate-pages-clockwise',
  'rotate-pages-counterclockwise',
  'delete-pages',
  'extract-pages',
  'sign',
  'page-numbers',
  'watermark',
  'recognize-text',
  'export-images',
  'export-text',
  'reduce-file-size',
  'protect',
  'ask-ai',
];

export interface SaveFileRequest {
  /** File name to propose, e.g. "Report.pdf". */
  suggestedName: string;
  bytes: Uint8Array;
  /**
   * Keep write access to the chosen file so later saves can update it (Save
   * As). Platforms that cannot (browser downloads) ignore it.
   */
  keepAccess?: boolean;
}

export type SaveFileResult =
  /**
   * Written where the user chose in a save dialog. `handle` identifies the
   * new file for {@link PlatformAdapter.writeFile} when `keepAccess` was asked
   * for and granted; release it with {@link PlatformAdapter.releaseHandle}.
   */
  | { status: 'saved'; name: string; handle: string | null }
  /** Handed to the browser's downloads. */
  | { status: 'downloaded'; name: string }
  | { status: 'cancelled' };

/** Overwrites a file the user opened or saved before (Save). */
export interface WriteFileRequest {
  /** The `origin.handle` of a document's local file. */
  handle: string;
  bytes: Uint8Array;
  /**
   * SHA-256 of the bytes Folio last read from or wrote to this file. When the
   * file no longer has them, someone else changed it and nothing is written.
   */
  expectedSha256: string;
  /** Write even though the file changed since (the user confirmed). */
  overwriteExternalChanges?: boolean;
}

export type WriteFileResult =
  | { status: 'saved' }
  /** The file changed on disk since Folio read or wrote it; nothing was written. */
  | { status: 'changed-on-disk' }
  /** The file cannot be written any more (moved, deleted, read-only). Use Save As. */
  | { status: 'unavailable'; message: string };

/** A document kept for crash recovery. Never contains passwords. */
export interface RecoveryRecord {
  id: string;
  /** Document title or file name, shown when offering recovery. */
  title: string;
  /** ISO-8601. */
  savedAt: string;
  /** Total size of the stored snapshot and files. */
  byteLength: number;
}

/**
 * Persistent storage for unsaved work: a JSON snapshot per document plus the
 * binary files it needs (original PDFs and added images), content-addressed
 * so autosave writes each file once. Cleared explicitly when the work is
 * saved or discarded.
 */
export interface RecoveryStore {
  list(): Promise<RecoveryRecord[]>;
  /** Writes or replaces the snapshot of a record. */
  saveSnapshot(record: { id: string; title: string }, snapshot: string): Promise<void>;
  /** Stores a file for a record unless one with this key is stored already. */
  saveFile(id: string, key: string, bytes: Uint8Array): Promise<void>;
  hasFile(id: string, key: string): Promise<boolean>;
  load(id: string): Promise<{ snapshot: string; files: Map<string, Uint8Array> } | null>;
  remove(id: string): Promise<void>;
}

/** A recently used file. Only its name reaches the UI; the platform keeps the location. */
export interface RecentFile {
  id: string;
  name: string;
  /** ISO-8601. */
  openedAt: string;
}

export interface RecentFiles {
  list(): Promise<RecentFile[]>;
  /** Opens a recent file again. Resolves to a file that fails to read if it is gone. */
  open(id: string): Promise<IncomingFile[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  onChange(listener: () => void): Unsubscribe;
}

/** A document another Folio component (the Chrome extension) wants to open here. */
export interface TransferRequest {
  id: string;
  name: string;
  size: number;
}

export type SendToDesktopResult =
  | { status: 'sent' }
  /** The desktop app is not installed or not registered for the extension. */
  | { status: 'not-installed' }
  /** The user did not allow the extension to talk to the desktop app. */
  | { status: 'permission-denied' }
  | { status: 'failed'; message: string };

export interface SendToDesktopRequest {
  name: string;
  /** Read once the platform may send: after its permission prompt. */
  bytes(): Promise<Uint8Array>;
  onProgress?(sent: number, total: number): void;
}

export type OpenUrlErrorCode =
  /** The user did not grant access to the site. */
  | 'permission-denied'
  /** The site needs the user's login; retry `withCredentials` after asking. */
  | 'auth-required'
  | 'not-found'
  | 'not-a-pdf'
  | 'too-large'
  | 'network'
  | 'blocked';

export interface OpenUrlOptions {
  /** Send the browser's cookies for the site: only after the user agreed. */
  withCredentials?: boolean;
  onProgress?(received: number, total: number | null): void;
  signal?: AbortSignal;
}

export class OpenUrlError extends Error {
  override readonly name = 'OpenUrlError';
  constructor(
    readonly code: OpenUrlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

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
  /** Unsaved work survives a crash or closed window and is offered again. */
  crashRecovery: boolean;
  recentFiles: boolean;
  /** Open a PDF from a web address. */
  openFromUrl: boolean;
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
  /** Overwrites a local file the user opened or saved (only after they chose Save). */
  writeFile(request: WriteFileRequest): Promise<WriteFileResult>;
  /** Gives up write access obtained from `saveFileAs`. */
  releaseHandle(handle: string): void;
  /**
   * Opens the print dialog. The shared UI first lays out the pages to print
   * in an element that only print styles show.
   */
  print(): Promise<void>;
  recovery: RecoveryStore;
  recentFiles: RecentFiles | null;
  /** Lets the platform warn before unsaved work is lost (browsers' leave-page prompt). */
  setUnsavedChanges(unsaved: boolean): void;
  /** Desktop: the window is about to close. Resolve true to let it close. */
  onCloseRequested?(handler: () => Promise<boolean>): Unsubscribe;
  /** Desktop: the Chrome extension sent a document; ask the user first. */
  onTransferRequest?(listener: (request: TransferRequest) => void): Unsubscribe;
  /** Accepts (and opens) or declines a transfer; declined ones are deleted. */
  answerTransfer?(id: string, accept: boolean): Promise<IncomingFile[]>;
  /**
   * Browsers: fetches a PDF from a web address, asking for access to the site
   * first. Call it straight from a click: the access prompt needs the gesture.
   * Fails with {@link OpenUrlError}.
   */
  openUrl?(url: string, options?: OpenUrlOptions): Promise<IncomingFile>;
  /**
   * Extension: hands a document to the Folio desktop app through native
   * messaging; the app asks the user before opening it. Call it straight
   * from a click: Chrome may ask for permission first.
   */
  sendToDesktop?(request: SendToDesktopRequest): Promise<SendToDesktopResult>;
}
