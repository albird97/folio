import type { RuntimeFeatures } from './types';

/**
 * The single source of truth for what Folio supports where.
 * `PLATFORM_CAPABILITIES.md` is generated from this file
 * (`pnpm capabilities:generate`) and a test fails when they drift.
 *
 * Rule: a feature is only "full" when it works end to end for users on that
 * target, not when a button exists.
 */
export type ProductTarget = 'macos' | 'windows' | 'chrome';
export type SupportLevel = 'full' | 'limited' | 'external-service' | 'none';

export interface TargetSupport {
  level: SupportLevel;
  note?: string;
}

export interface FeatureCapability {
  id: string;
  area: string;
  feature: string;
  /** Phase in IMPLEMENTATION_PLAN.md that completes the feature; null when done or never. */
  plannedPhase: number | null;
  targets: Record<ProductTarget, TargetSupport>;
  /** How support was verified. */
  verification: string;
  /**
   * Runtime flag(s) that adapters must report consistently with this row:
   * the feature counts as available when any of them is true.
   */
  runtimeFeature?: keyof RuntimeFeatures | ReadonlyArray<keyof RuntimeFeatures>;
}

const full = (note?: string): TargetSupport => (note ? { level: 'full', note } : { level: 'full' });
const limited = (note: string): TargetSupport => ({ level: 'limited', note });
const none = (note?: string): TargetSupport => (note ? { level: 'none', note } : { level: 'none' });
const all = (support: TargetSupport): Record<ProductTarget, TargetSupport> => ({
  macos: support,
  windows: support,
  chrome: support,
});

type DesktopTarget = Exclude<ProductTarget, 'chrome'>;
const REAL_MACHINE: Record<DesktopTarget, string> = {
  macos: 'a real Mac',
  windows: 'a real Windows PC',
};

/**
 * A native integration that compiles in the macOS and Windows CI builds but
 * that no test or person has used on that OS yet. It stays Limited until it
 * has been tried on a real machine (Phase 4).
 */
const unverified = (target: DesktopTarget, note: string): TargetSupport =>
  limited(`${note} Implemented and built in CI, but not yet verified on ${REAL_MACHINE[target]}.`);

/** A native integration someone has used in a release build on a real Mac. */
const triedOnMac = (note: string): TargetSupport =>
  full(`${note} Tried in a release build on macOS 26 (Apple silicon).`);

const EDITING_VERIFIED =
  'Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back.';

const SHORTCUTS =
  'Open, Save, Save as, Save a copy, Print, undo and redo, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous, single keys for the drawing tools';
const NO_THEME_SHORTCUT = 'Switching the theme has no shortcut.';

const SAVE_NOTE =
  'Writes changes back to the file you opened or last saved as, through a temporary file and an atomic replace. If another program changed the file, Folio asks before overwriting it; files that cannot be written fall back to Save As.';
const PRINT_NOTE =
  'All, current or chosen pages, with or without comments, through the system print dialog. Folio draws the pages at print resolution first.';
const RECOVERY_NOTE =
  'Unsaved changes are kept in Folio’s data folder two seconds after each change and offered when Folio starts after a crash. Saving, closing or discarding deletes them.';
const NATIVE_MESSAGING_NOTE =
  'Receives documents from the Chrome extension after File › Connect to Chrome… and asks before opening each one; declined documents are deleted.';
const CLIPBOARD_NOTE =
  'Selected page text, document property values, and comments (copy, cut, paste, also between documents); images on the clipboard paste as added images.';
const FORMS_NOTE =
  'Text (multi-line, comb, password), check boxes, radio buttons, drop-down and list boxes filled in on the page, with undo, crash recovery and printing; values saved as the form’s own (other readers show them) or flattened into the pages. XFA forms are shown as saved but cannot be filled in; form scripts (calculations, formatting) do not run.';
const SIGNATURES_NOTE =
  'Draw (mouse, trackpad, pen or touch), type in a bundled handwriting font, or use a PNG, JPEG or WebP picture with its paper made transparent; placed with a click (Enter: middle of the page) or into a signature field, then moved and resized like images. A picture of a signature, not a digital (certificate) signature. Optionally remembered (up to five)';
const OCR_NOTE =
  'Tools › Recognize text (OCR): English, Indonesian and Chinese (Simplified, Traditional), read on this device with the bundled Tesseract engine; nothing is downloaded or uploaded. Recognized text can be searched, selected, copied and highlighted, and is saved into the PDF as invisible text. Pages must show their text upright.';
const STAMPS_NOTE =
  'Page numbers (“1”, “Page 1”, “Page 1 of 12”, “1 / 12” or custom text with {page} and {total}) at the top or bottom, left, centre or right, and a text watermark at any of nine positions, angle and opacity, over or under the content, on all pages or a range. They show on the pages straight away, can be undone, and are drawn into the pages when saving or printing, in the standard PDF fonts (characters those fonts lack are saved as “?” and the user is told), marked as artifacts for assistive technology. This adds new content; it does not edit the pages’ own text.';
const UPDATES_NOTE =
  'Check for Updates…, and Check for Updates Automatically (off by default; at most once a day). Updates must be signed with Folio’s key for the version announced; unsaved work is asked about before Folio restarts. The feed is this repository’s GitHub releases, which users cannot reach while the repository is private.';
const IMAGES_NOTE =
  'Tools › Export pages as images: chosen pages as PNG or JPEG at 72, 150 or 300 dpi, with or without comments, form values and stamps; several pages as one ZIP file (up to 300 pages at a time).';
const TEXT_NOTE =
  'Tools › Export text: the text of chosen pages, including text recognized by OCR, to copy or save as .txt.';
const PROTECT_NOTE =
  'Tools › Password protection saves a copy with a password to open and/or restrictions on printing, copying and changes (AES-256), or without the password of a document you opened with it. Each copy is re-opened before it is saved to check the protection. Restrictions set by a document’s author stay locked.';
const COMPRESS_NOTE =
  'Tools › Reduce file size saves a smaller copy: lossless (compressing streams, dropping thumbnails) or re-encoding large images as JPEG (2000 or 1400 px on the long side), keeping every image whose new version is not smaller. Protected documents stay protected.';
const RECENT_NOTE =
  'Start screen list and File › Open Recent; only names reach the UI, and files that moved are reported.';

export const CAPABILITY_MATRIX: readonly FeatureCapability[] = [
  // Opening documents
  {
    id: 'open-picker',
    area: 'Opening documents',
    feature: 'Open a PDF with a file picker',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        'Native dialog shown by the Rust layer; the webview only receives tokens and file names.',
      ),
      windows: unverified(
        'windows',
        'Native dialog shown by the Rust layer; the webview only receives tokens and file names.',
      ),
      chrome: full(
        'Picker in the editor page and side panel. The popup hands off to the editor because Chrome closes popups when a file dialog opens.',
      ),
    },
    verification:
      'Extension and desktop UI (web adapter): Playwright e2e. Native dialog: Rust unit tests for granting the chosen files; the dialog itself cannot be automated.',
  },
  {
    id: 'open-drag-drop',
    area: 'Opening documents',
    feature: 'Open PDFs by drag and drop',
    plannedPhase: 4,
    targets: {
      macos: triedOnMac('Dropped files are granted by the native layer.'),
      windows: unverified('windows', 'Dropped files are granted by the native layer.'),
      chrome: full('Drop onto the editor page or the side panel.'),
    },
    verification:
      'Extension and desktop UI (web adapter): Playwright e2e. Native drops: Rust unit tests for grant filtering and the drag-hover signal.',
    runtimeFeature: ['nativeDragAndDrop', 'webDragAndDrop'],
  },
  {
    id: 'open-file-association',
    area: 'Opening documents',
    feature: 'Open from Finder / File Explorer (file association)',
    plannedPhase: 4,
    targets: {
      macos: triedOnMac(
        'Handles Finder “Open With” events and files passed at launch; a file opened while Folio runs opens in a new tab of the running window. Folio is registered as an alternate PDF handler.',
      ),
      windows: unverified(
        'windows',
        'Opens a PDF passed on launch; opening another file while Folio runs sends it to the running window.',
      ),
      chrome: none('Extensions cannot register as the operating system’s PDF handler.'),
    },
    verification:
      'Launch-argument opening: tauri-driver e2e against the real binary on Linux. Finder events and Explorer registration: compiled in CI only.',
    runtimeFeature: 'fileAssociations',
  },
  {
    id: 'open-password',
    area: 'Opening documents',
    feature: 'Open password-protected PDFs',
    plannedPhase: null,
    targets: all(
      full(
        'Standard security handler: AES-256 and legacy 128-bit RC4, both tested. The password is only kept in memory.',
      ),
    ),
    verification: 'Unit tests with qpdf-encrypted fixtures; extension e2e.',
  },
  {
    id: 'open-errors',
    area: 'Opening documents',
    feature: 'Clear errors for damaged, empty or non-PDF files',
    plannedPhase: null,
    targets: all(full()),
    verification: 'Unit tests with invalid fixtures; e2e for the error state.',
  },
  {
    id: 'multi-document',
    area: 'Opening documents',
    feature: 'Multiple documents in tabs',
    plannedPhase: null,
    targets: {
      macos: full(),
      windows: full(),
      chrome: full('Tabs inside the editor page; each browser tab is its own workspace.'),
    },
    verification: 'Desktop UI and extension e2e.',
  },
  {
    id: 'document-properties',
    area: 'Opening documents',
    feature: 'Document properties (metadata, page sizes, security)',
    plannedPhase: null,
    targets: all(full()),
    verification: 'Unit tests (metadata normalization) and e2e.',
  },
  {
    id: 'open-current-tab',
    area: 'Opening documents',
    feature: 'Open the PDF in the current browser tab',
    plannedPhase: null,
    targets: {
      macos: none('Not applicable.'),
      windows: none('Not applicable.'),
      chrome: full(
        'Click Folio’s toolbar button on a tab showing a PDF, then Open: a new editor tab asks Chrome for access to the site the first time and downloads the file. Chrome does not let extensions read PDFs opened from your computer (file://); choose those with Open a PDF.',
      ),
    },
    verification:
      'E2E (Chromium): the popup, service worker download and editor hand-off run for real against a local server; the toolbar click (activeTab) and Chrome’s permission prompt are stubbed because they cannot be automated. Unit tests for the download rules.',
    runtimeFeature: 'browserTabIntegration',
  },
  {
    id: 'open-url',
    area: 'Opening documents',
    feature: 'Open a PDF from a web address',
    plannedPhase: null,
    targets: {
      macos: none(
        'Not applicable: the desktop app makes no network requests. Download the PDF in a browser, or send it from the Chrome extension.',
      ),
      windows: none(
        'Not applicable: the desktop app makes no network requests. Download the PDF in a browser, or send it from the Chrome extension.',
      ),
      chrome: full(
        'Chrome asks for access to each site on first use. No cookies are sent unless the site asks for a sign-in and you agree, for that one request; no referrer is sent. Up to 256 MB; web pages, missing files and other errors are explained.',
      ),
    },
    verification:
      'Unit tests for URLs, file names, sign-in detection, size limits and errors; e2e (Chromium) downloads from a local server through the service worker, with Chrome’s permission prompt stubbed.',
    runtimeFeature: 'openFromUrl',
  },
  // Viewing
  {
    id: 'render-pages',
    area: 'Viewing',
    feature: 'Render pages (continuous, virtualized scrolling)',
    plannedPhase: null,
    targets: all(
      full(
        'Only pages near the window are kept; renders are queued by distance and cached within a memory budget. Documents with thousands of pages open at the first page while the remaining page sizes are read in the background.',
      ),
    ),
    verification:
      'E2E in Chromium (extension, desktop UI) including a 1,500-page budget for time to first page, mounted pages and memory; WebKitGTK through the real desktop binary (tauri-driver).',
  },
  {
    id: 'thumbnails',
    area: 'Viewing',
    feature: 'Page thumbnails and page navigation',
    plannedPhase: null,
    targets: all(
      full(
        'Virtualized thumbnails, page number field, previous/next page and keyboard navigation (arrow keys, Page Up/Down, Home/End).',
      ),
    ),
    verification: 'E2E (Chromium) including keyboard navigation.',
  },
  {
    id: 'outline',
    area: 'Viewing',
    feature: 'Bookmarks (document outline)',
    plannedPhase: null,
    targets: all(
      full(
        'Explicit and named destinations, as an accessible tree. Bookmarks that link to websites are listed but not opened.',
      ),
    ),
    verification: 'Unit tests for destination resolution; DOM tests for the tree; e2e (Chromium).',
  },
  {
    id: 'search',
    area: 'Viewing',
    feature: 'Text search',
    plannedPhase: null,
    targets: all(
      full(
        'Whole-document search with highlights, a results list, match case and whole words; ignores accents and finds words drawn in separate pieces. Scanned pages are searchable after Tools › Recognize text (OCR).',
      ),
    ),
    verification:
      'Unit tests for matching; e2e accuracy checks on fixtures (Chromium); highlighting in WebKitGTK (tauri-driver).',
  },
  {
    id: 'zoom-rotate-view',
    area: 'Viewing',
    feature: 'Zoom, fit width/page and view rotation',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        'Toolbar, menu and keyboard zoom and rotation; trackpad pinch through WebKit gesture events.',
      ),
      windows: unverified(
        'windows',
        'Toolbar, menu and keyboard zoom and rotation; Ctrl+wheel and touchpad pinch.',
      ),
      chrome: full(
        'Toolbar, menu and keyboard zoom, Ctrl+wheel and trackpad pinch (kept to the document, not the browser page), view rotation. Rotation is for viewing only.',
      ),
    },
    verification:
      'E2E in Chromium for the toolbar, keyboard, Ctrl+wheel and synthetic pinch events, including the anchor point. WebKit gesture events and the desktop menus have not been exercised.',
  },
  {
    id: 'text-selection',
    area: 'Viewing',
    feature: 'Text selection and copying',
    plannedPhase: null,
    targets: all(full('Selectable text layer over each page.')),
    verification:
      'E2E (Chromium) selects with the mouse and reads the clipboard; text layer placement in WebKitGTK (tauri-driver).',
  },
  // Editing
  {
    id: 'markup',
    area: 'Editing',
    feature: 'Highlight, underline, strikethrough and comments',
    plannedPhase: null,
    targets: all(
      full(
        'Marks the selected text (across pages too) and places notes; a Comments list finds, reviews and deletes them. Saved as standard PDF annotations with appearance streams, so other viewers show them.',
      ),
    ),
    verification: EDITING_VERIFIED,
  },
  {
    id: 'drawing',
    area: 'Editing',
    feature: 'Freehand drawing and shapes',
    plannedPhase: null,
    targets: all(
      full(
        'Pen, rectangle, ellipse, line and arrow, with colour, fill, opacity and line width; select, move, resize, nudge and delete.',
      ),
    ),
    verification: EDITING_VERIFIED,
  },
  {
    id: 'added-text',
    area: 'Editing',
    feature: 'Add text (new content on top of the page)',
    plannedPhase: null,
    targets: all(
      full(
        'Text boxes in the standard PDF fonts (Helvetica, Times, Courier), laid out identically on screen and in the file; characters those fonts lack are saved as “?” and the user is told. This adds new text; it does not edit the PDF’s existing text.',
      ),
    ),
    verification: EDITING_VERIFIED,
  },
  {
    id: 'added-images',
    area: 'Editing',
    feature: 'Add images',
    plannedPhase: null,
    targets: all(
      full(
        'PNG, JPEG, WebP, GIF or BMP pictures, re-encoded as PNG or JPEG with their orientation applied and their metadata (such as location) removed.',
      ),
    ),
    verification: EDITING_VERIFIED,
  },
  {
    id: 'undo-redo',
    area: 'Editing',
    feature: 'Undo and redo',
    plannedPhase: null,
    targets: all(
      full(
        'Every change to annotations, pages and properties, from the toolbar, menus or keyboard; typing in a text field keeps its own undo.',
      ),
    ),
    verification: 'Model and store unit tests; e2e (Chromium) with the keyboard.',
  },
  {
    id: 'page-operations',
    area: 'Editing',
    feature: 'Insert, delete, duplicate, extract and reorder pages',
    plannedPhase: null,
    targets: all(
      full(
        'Multi-select in the pages panel, drag to reorder, rotate, duplicate, delete, insert blank pages or pages of other PDFs (protected ones ask for their password), extract pages to a new file. Removed pages leave no content, form values or bookmarks targets behind in saved files.',
      ),
    ),
    verification: EDITING_VERIFIED,
  },
  {
    id: 'merge-split',
    area: 'Editing',
    feature: 'Merge and split',
    plannedPhase: null,
    targets: all(
      full(
        'Merge by inserting the pages of other PDFs; split every N pages or before selected pages into new documents.',
      ),
    ),
    verification: EDITING_VERIFIED,
  },
  {
    id: 'metadata-edit',
    area: 'Editing',
    feature: 'Edit metadata',
    plannedPhase: null,
    targets: all(
      full('Title, author, subject and keywords, written to both the Info dictionary and XMP.'),
    ),
    verification: 'Export tests read the saved metadata back with PDF.js; e2e (Chromium).',
  },
  {
    id: 'permissions',
    area: 'Editing',
    feature: 'Respect the document’s permission settings',
    plannedPhase: null,
    targets: all(
      full(
        'Commenting, page changes, editing properties and copying pages out follow the PDF’s permission flags, with an explanation; saved copies keep the original’s password and permissions.',
      ),
    ),
    verification: 'Store unit tests; export tests re-open protected results; e2e (Chromium).',
  },
  {
    id: 'watermarks',
    area: 'Editing',
    feature: 'Page numbers and watermarks',
    plannedPhase: null,
    targets: all(full(STAMPS_NOTE)),
    verification:
      'Layout unit tests (every rotation, position and user unit, shrinking to fit); export tests re-open results with PDF.js (text where the layout puts it, order under and over the content, extracts, duplicated and blank pages, protected files) and check them with qpdf; e2e in Chromium for the desktop UI and the extension, reading saved files back, with axe and a pixel check of the under-the-content preview.',
  },
  // Saving & export
  {
    id: 'save',
    area: 'Saving and export',
    feature: 'Save (write changes back to the opened file)',
    plannedPhase: 4,
    targets: {
      macos: triedOnMac(SAVE_NOTE),
      windows: unverified('windows', SAVE_NOTE),
      chrome: none(
        'Extensions cannot write back to the original file; Download PDF saves a copy instead.',
      ),
    },
    verification:
      'Rust unit tests for atomic replacement, changed-on-disk detection, read-only files and permissions; tauri-driver e2e on Linux saves through the real binary and refuses a file changed behind its back. Shared Save logic: unit and e2e tests with the web adapter.',
    runtimeFeature: 'saveInPlace',
  },
  {
    id: 'save-as-edited',
    area: 'Saving and export',
    feature: 'Save changes as a new PDF (Save as)',
    plannedPhase: 4,
    targets: {
      macos: triedOnMac(
        'Writes the edited document through the native save dialog; comments can be kept editable or flattened into the pages.',
      ),
      windows: unverified(
        'windows',
        'Writes the edited document through the native save dialog; comments can be kept editable or flattened into the pages.',
      ),
      chrome: full(
        'Downloads the edited document; comments can be kept editable or flattened into the pages.',
      ),
    },
    verification:
      'Export tests re-open every result with PDF.js and check it with qpdf; e2e (Chromium) reads downloaded files back with pdf-lib. The native save dialog cannot be automated.',
    runtimeFeature: 'saveCopy',
  },
  {
    id: 'export-pdf',
    area: 'Saving and export',
    feature: 'Save a copy of the original PDF',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        'Native save dialog shown by the Rust layer, which only writes PDF data, through a temporary file. The webview never sees the path.',
      ),
      windows: unverified(
        'windows',
        'Native save dialog shown by the Rust layer, which only writes PDF data, through a temporary file. The webview never sees the path.',
      ),
      chrome: full('Downloaded through Chrome’s downloads; needs no extra permission.'),
    },
    verification:
      'Extension and desktop UI: e2e compares the SHA-256 of the saved file with the original. Desktop: Rust unit tests for validation, file names and atomic writes; tauri-driver checks that non-PDF data is refused. The native dialog cannot be automated.',
    runtimeFeature: 'saveCopy',
  },
  {
    id: 'export-images',
    area: 'Saving and export',
    feature: 'Export pages as images',
    plannedPhase: 7,
    targets: {
      macos: unverified(
        'macos',
        `${IMAGES_NOTE} Saved through the native save dialog, which only accepts real image or ZIP data.`,
      ),
      windows: unverified(
        'windows',
        `${IMAGES_NOTE} Saved through the native save dialog, which only accepts real image or ZIP data.`,
      ),
      chrome: full(`${IMAGES_NOTE} Downloaded; the side panel offers the same for any PDF.`),
    },
    verification:
      'Unit tests of page images, ZIP output (the writer is checked against Python’s zipfile) and the Rust content checks; e2e (Chromium) in the desktop UI, the editor and the side panel reads the ZIP and images back. The native save dialog cannot be automated.',
  },
  {
    id: 'extract-text',
    area: 'Saving and export',
    feature: 'Extract text',
    plannedPhase: 7,
    targets: {
      macos: unverified('macos', `${TEXT_NOTE} Saved through the native save dialog.`),
      windows: unverified('windows', `${TEXT_NOTE} Saved through the native save dialog.`),
      chrome: full(`${TEXT_NOTE} Downloaded; the side panel offers the same for any PDF.`),
    },
    verification:
      'Unit tests on the text fixture and recognized text; e2e (Chromium) copies and saves it from the desktop UI, the editor and the side panel, including a page read by OCR.',
  },
  {
    id: 'export-worker',
    area: 'Saving and export',
    feature: 'Saving without freezing the window (export in a worker)',
    plannedPhase: 7,
    targets: {
      macos: triedOnMac(
        'Save, print, extract, split and Reduce file size write the PDF in a Web Worker.',
      ),
      windows: unverified(
        'windows',
        'Save, print, extract, split and Reduce file size write the PDF in a Web Worker.',
      ),
      chrome: full(
        'Save, print, extract, split and Reduce file size write the PDF in a Web Worker of the extension’s own.',
      ),
    },
    verification:
      'Unit tests drive the worker client through a stand-in worker (the same output as the in-page exporter, error codes, warnings, progress, cancelling, transfer and copy, fallback). E2E (Chromium): saving 5,000 stamped pages and compressing two large photos leave no main-thread task over 250 ms (0.55 s and 0.8 s before); the extension’s export worker loads with no CSP violation.',
  },
  {
    id: 'printing',
    area: 'Saving and export',
    feature: 'Print',
    plannedPhase: 4,
    targets: {
      macos: unverified('macos', PRINT_NOTE),
      windows: unverified('windows', PRINT_NOTE),
      chrome: full(
        'All, current or chosen pages, with or without comments, through Chrome’s print dialog. Folio draws the pages at print resolution on this device first.',
      ),
    },
    verification:
      'E2E (Chromium) prints through the print layout to a PDF and counts its pages; unit tests for page ranges and print resolution.',
    runtimeFeature: 'printing',
  },
  {
    id: 'webpage-to-pdf',
    area: 'Saving and export',
    feature: 'Save the current webpage as PDF',
    plannedPhase: null,
    targets: {
      macos: none('Not applicable.'),
      windows: none('Not applicable.'),
      chrome: limited(
        'Opens Chrome’s print dialog for the tab, where “Save as PDF” is a destination; Chrome writes the file, and Folio does not open it afterwards. Chrome’s own pages and the Web Store cannot be printed this way: extensions cannot run scripts there.',
      ),
    },
    verification:
      'E2E (Chromium) checks that the popup asks Chrome to print the tab (activeTab stubbed); the print dialog cannot be automated.',
  },
  // Advanced
  {
    id: 'forms',
    area: 'Advanced tools',
    feature: 'Fill forms',
    plannedPhase: null,
    targets: all(full(FORMS_NOTE)),
    verification:
      'Unit tests of the engine (saved values re-read with PDF.js and pdf-lib, encryption kept), the exporter (flattening; results re-opened with PDF.js and checked with qpdf), the store and the form layer; e2e in Chromium for the desktop UI and the extension, reading saved files back with pdf-lib; axe in both themes.',
  },
  {
    id: 'signatures',
    area: 'Advanced tools',
    feature: 'Place signatures',
    plannedPhase: null,
    targets: {
      macos: full(`${SIGNATURES_NOTE} in the app’s settings on this computer.`),
      windows: full(`${SIGNATURES_NOTE} in the app’s settings on this computer.`),
      chrome: full(`${SIGNATURES_NOTE} in the extension’s local storage on this computer.`),
    },
    verification:
      'Unit tests for cropping, background removal, stored-signature checks and placement geometry; e2e (Chromium) in the desktop UI (draw, type, import, remember across a reload, a signature field, a turned page, copying, permissions, axe in both themes) reading saved files back with pdf-lib, and in the extension (a typed signature with the bundled font under the extension’s CSP).',
  },
  {
    id: 'ocr',
    area: 'Advanced tools',
    feature: 'Recognize text in scanned pages (OCR)',
    plannedPhase: 7,
    targets: {
      macos: triedOnMac(OCR_NOTE),
      windows: unverified('windows', OCR_NOTE),
      chrome: full(OCR_NOTE),
    },
    verification:
      'Unit tests: data validation, pixel↔page mapping at every rotation with a crop box, real Tesseract in Node on a scanned fixture, exporter output re-opened with PDF.js and checked with qpdf (rendering unchanged). E2E (Chromium): search, highlight, copy, save and re-open, undo and axe in the desktop UI; the extension editor with no CSP violations or network requests.',
  },
  {
    id: 'ask-ai',
    area: 'Advanced tools',
    feature: 'Ask Claude about a document (opt-in, your own Anthropic API key)',
    plannedPhase: null,
    targets: {
      macos: {
        level: 'external-service',
        note: 'Off until you turn it on with your own Anthropic API key, kept in the macOS Keychain. When you ask, the text of the chosen pages (not the file) and your questions go to Anthropic’s API through Folio’s native proxy; the page cannot read the key or reach other servers. Built in CI; the Keychain and the proxy have not been tried on a real Mac.',
      },
      windows: {
        level: 'external-service',
        note: 'As on macOS, with the key in the Windows Credential Manager. Built in CI; not tried on a real Windows PC.',
      },
      chrome: {
        level: 'external-service',
        note: 'Off until you turn it on with your own Anthropic API key, kept in this browser profile’s extension storage (never synced). Chrome asks for access to api.anthropic.com; only the service worker sends requests, and removing that access forgets the key.',
      },
    },
    verification:
      'Unit tests of prompt building (a cached prefix, one block per page), token limits, error mapping and every transport (the Rust proxy against a local server, the Tauri channel, the service worker port) with mocked API streams; e2e in Chromium for the desktop UI (web adapter) and the extension (service worker requests routed). Tests never call the real API.',
    runtimeFeature: 'aiAssistant',
  },
  {
    id: 'password-protect',
    area: 'Advanced tools',
    feature: 'Password protection',
    plannedPhase: 7,
    targets: {
      macos: unverified('macos', PROTECT_NOTE),
      windows: unverified('windows', PROTECT_NOTE),
      chrome: full(PROTECT_NOTE),
    },
    verification:
      'Export tests check every protected copy with qpdf (--check and --show-encryption with the password) and PDF.js, including that strings are not readable without the password; e2e (Chromium) reads protected, re-protected and unprotected copies back with pdf-lib.',
  },
  {
    id: 'compression',
    area: 'Advanced tools',
    feature: 'Reduce file size',
    plannedPhase: 7,
    targets: {
      macos: unverified(
        'macos',
        `${COMPRESS_NOTE} Re-encoding images was tried in a release build on a Mac; saving the copy uses the native save dialog.`,
      ),
      windows: unverified(
        'windows',
        `${COMPRESS_NOTE} Re-encoding images uses the browser engine’s image decoder, so far only tried in Chromium.`,
      ),
      chrome: full(COMPRESS_NOTE),
    },
    verification:
      'Unit tests compress Flate and JPEG images (predictors, soft masks, every skipped image type), compare rendered pixels and run qpdf; e2e (Chromium) reduces a document with a large photo and re-opens it.',
  },
  // App & platform
  {
    id: 'native-menus',
    area: 'App and platform',
    feature: 'Native menus',
    plannedPhase: 4,
    targets: {
      macos: triedOnMac(
        'Folio (app, with Check for Updates), File (with Open Recent, Save, Save As, Print), Edit, View, Pages, Tools and Window menus with the editing, zoom, rotation, page and tool commands.',
      ),
      windows: unverified(
        'windows',
        'File, Edit, View, Pages, Tools and Help (with Check for Updates) menus in the window menu bar, with the same commands.',
      ),
      chrome: none('Not applicable.'),
    },
    verification:
      'Rust unit tests for command forwarding on Linux, macOS and Windows CI runners; the menus were used in a release build on a Mac.',
    runtimeFeature: 'nativeMenus',
  },
  {
    id: 'shortcuts',
    area: 'App and platform',
    feature: 'Keyboard shortcuts',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        `${SHORTCUTS}, rotate (⌘R/⌘L) and Close Window. ${NO_THEME_SHORTCUT}`,
      ),
      windows: unverified('windows', `${SHORTCUTS}, rotate (Ctrl+R/Ctrl+L). ${NO_THEME_SHORTCUT}`),
      chrome: limited(
        `${SHORTCUTS}. Closing and switching documents use Alt keys because Chrome reserves Ctrl/⌘+W and Ctrl+Tab; rotation has no shortcut because Chrome keeps Ctrl+R and Ctrl+L. ${NO_THEME_SHORTCUT}`,
      ),
    },
    verification:
      'Key matching: unit tests. Browser key set: extension e2e. Desktop key set: desktop UI e2e in Chromium. Menu accelerators: Rust unit tests only.',
  },
  {
    id: 'themes',
    area: 'App and platform',
    feature: 'Light, dark and system themes',
    plannedPhase: null,
    targets: all(full()),
    verification: 'E2E (including axe checks in both themes).',
  },
  {
    id: 'clipboard',
    area: 'App and platform',
    feature: 'Clipboard',
    plannedPhase: 4,
    targets: {
      macos: unverified('macos', CLIPBOARD_NOTE),
      windows: unverified('windows', CLIPBOARD_NOTE),
      chrome: full(CLIPBOARD_NOTE),
    },
    verification:
      'E2E (Chromium) reads the clipboard after copying and pastes comments and images. The desktop webviews (WebKit on macOS, WebView2 on Windows) have not run these tests.',
    runtimeFeature: 'clipboardWrite',
  },
  {
    id: 'recovery',
    area: 'App and platform',
    feature: 'Autosave and crash recovery',
    plannedPhase: 4,
    targets: {
      macos: unverified('macos', RECOVERY_NOTE),
      windows: unverified('windows', RECOVERY_NOTE),
      chrome: full(
        'Unsaved changes are kept in the extension’s storage on this device two seconds after each change and offered when the editor opens again. Saving, closing or discarding deletes them; documents open in another editor tab are not offered.',
      ),
    },
    verification:
      'Unit tests restore documents with their history, passwords asked again and damaged records refused; e2e (Chromium) restores after closing the tab and checks that saved work leaves nothing behind. Desktop store: Rust unit tests and tauri-driver e2e on Linux.',
    runtimeFeature: 'crashRecovery',
  },
  {
    id: 'recent-files',
    area: 'App and platform',
    feature: 'Recent files',
    plannedPhase: 4,
    targets: {
      macos: triedOnMac(RECENT_NOTE),
      windows: unverified('windows', RECENT_NOTE),
      chrome: none('Not applicable: browsers do not let extensions reopen local files later.'),
    },
    verification:
      'Rust unit tests for the list (order, limit, removal, damaged lists, no paths); DOM tests for the start screen list with a fake list.',
    runtimeFeature: 'recentFiles',
  },
  {
    id: 'single-instance',
    area: 'App and platform',
    feature: 'One running app, remembered window size and position',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        'Finder sends files to the running app; the window’s size and position are restored.',
      ),
      windows: unverified(
        'windows',
        'Opening a PDF while Folio runs hands it to the running window; the window’s size and position are restored.',
      ),
      chrome: none('Not applicable.'),
    },
    verification:
      'tauri-driver e2e on Linux starts a second copy with a file and checks that the first window opens it.',
  },
  {
    id: 'auto-update',
    area: 'App and platform',
    feature: 'Automatic updates (opt-in)',
    plannedPhase: 7,
    targets: {
      macos: unverified('macos', `Folio › ${UPDATES_NOTE}`),
      windows: unverified(
        'windows',
        `Help › ${UPDATES_NOTE} Installs through the per-user NSIS installer.`,
      ),
      chrome: none('Handled by the Chrome Web Store once published.'),
    },
    verification:
      'Rust unit and property tests (the setting, the daily rule, versions, messages, configuration, menu wiring, no updater permission for the page); a locally built signed bundle verified against the configured key. No update has been installed end to end.',
  },
  {
    id: 'installers',
    area: 'App and platform',
    feature: 'Installers',
    plannedPhase: 4,
    targets: {
      macos: limited(
        'Unsigned .app/.dmg; Developer ID signing and notarization need Apple credentials.',
      ),
      windows: limited('Unsigned NSIS .exe and .msi; Authenticode signing needs a certificate.'),
      chrome: limited('Unpacked build and a Web Store zip; not yet published.'),
    },
    verification: 'CI release builds on macOS and Windows runners (see README).',
  },
  {
    id: 'native-messaging',
    area: 'App and platform',
    feature: 'Send documents between the extension and the desktop app',
    plannedPhase: 5,
    targets: {
      macos: unverified('macos', NATIVE_MESSAGING_NOTE),
      windows: unverified('windows', NATIVE_MESSAGING_NOTE),
      chrome: full(
        'Open in Folio for desktop, from the editor (with your changes) or the side panel. Chrome asks for the permission the first time; the desktop app asks before it opens anything. When the app is missing or not connected, Folio explains how to set it up.',
      ),
    },
    verification:
      'Unit tests of the protocol against a scripted host, and property tests that fuzz the host’s framing and messages; e2e (Chromium, Linux) sends documents from the side panel and the editor to the real desktop host binary, with the permission granted at install in a test copy of the extension (Chrome’s prompt cannot be automated).',
    runtimeFeature: 'nativeMessaging',
  },
  // Extension surfaces
  {
    id: 'extension-popup',
    area: 'Chrome extension',
    feature: 'Toolbar popup with quick actions and recent activity',
    plannedPhase: null,
    targets: { macos: none('Not applicable.'), windows: none('Not applicable.'), chrome: full() },
    verification: 'Extension e2e.',
  },
  {
    id: 'extension-side-panel',
    area: 'Chrome extension',
    feature: 'Side panel',
    plannedPhase: null,
    targets: {
      macos: none('Not applicable.'),
      windows: none('Not applicable.'),
      chrome: full(
        'Inspect a PDF, rotate or extract pages, turn pages into images and extract text; list the PDFs linked from the current tab to open or download.',
      ),
    },
    verification: 'Extension e2e, including axe checks.',
  },
  {
    id: 'extension-options',
    area: 'Chrome extension',
    feature: 'Options page with permission explanations',
    plannedPhase: null,
    targets: { macos: none('Not applicable.'), windows: none('Not applicable.'), chrome: full() },
    verification: 'Extension e2e.',
  },
  {
    id: 'download-linked-pdfs',
    area: 'Chrome extension',
    feature: 'Download PDFs linked from a page',
    plannedPhase: null,
    targets: {
      macos: none('Not applicable.'),
      windows: none('Not applicable.'),
      chrome: full(
        'The side panel lists the PDFs a tab links to (after a click on Folio’s toolbar button there). Downloads go through Chrome’s downloads, with the browser’s own sign-in for the site; Chrome asks for the downloads permission on first use.',
      ),
    },
    verification:
      'E2E (Chromium) with the page scan and the downloads API stubbed (they need the toolbar click and a permission prompt).',
  },
  // Privacy
  {
    id: 'local-first',
    area: 'Privacy',
    feature: 'Local-only processing (no uploads unless you ask Claude, no analytics on content)',
    plannedPhase: null,
    targets: all(
      full(
        'Documents are processed on this device. Nothing about them is sent anywhere unless you turn on Ask Claude and ask a question, which sends the text of the chosen pages to Anthropic with your own key. The extension downloads PDFs only from sites you allow, in its service worker; its pages cannot connect to other servers at all.',
      ),
    ),
    verification:
      'Extension: e2e asserts no site access at install, no network requests while opening a document and that pages’ CSP blocks requests to other servers; unit tests check the CSPs and that downloads carry no cookies or referrer unless allowed. Desktop: the CSP allows only the app itself, checked by tauri-driver e2e.',
  },
];

export const SUPPORT_LABELS: Record<SupportLevel, string> = {
  full: '✅ Full',
  limited: '🟡 Limited',
  'external-service': '☁️ External service',
  none: '⛔ Not supported',
};

export function capability(id: string): FeatureCapability {
  const found = CAPABILITY_MATRIX.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown capability ${id}`);
  return found;
}

/** Lists rows whose level disagrees with what an adapter reports at runtime. */
export function runtimeMismatches(features: RuntimeFeatures, target: ProductTarget): string[] {
  const problems: string[] = [];
  for (const entry of CAPABILITY_MATRIX) {
    if (!entry.runtimeFeature) continue;
    const keys =
      typeof entry.runtimeFeature === 'string' ? [entry.runtimeFeature] : entry.runtimeFeature;
    const supported = entry.targets[target].level !== 'none';
    const reported = keys.some((key) => features[key]);
    if (supported !== reported) {
      problems.push(
        `${entry.id}: matrix says ${entry.targets[target].level} for ${target}, adapter reports ${keys.join('|')}=${reported}`,
      );
    }
  }
  return problems;
}

const escapeCell = (text: string) => text.replace(/\|/g, '\\|');
const TARGET_NAMES: Record<ProductTarget, string> = {
  macos: 'macOS',
  windows: 'Windows',
  chrome: 'Chrome',
};
const TARGETS: ProductTarget[] = ['macos', 'windows', 'chrome'];

export function renderCapabilityMarkdown(): string {
  const lines: string[] = [
    '# Folio platform capabilities',
    '',
    '<!-- Generated from packages/platform-adapters/src/capabilities.ts by `pnpm capabilities:generate`. Do not edit by hand. -->',
    '',
    'Every feature is classified per target. A feature is only **Full** when it works end to end for',
    'users on that target — a button existing is not enough. “Phase” is the phase in',
    '[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) that completes the feature. Cells marked † have',
    'a note below the table.',
    '',
    '| Level | Meaning |',
    '| --- | --- |',
    `| ${SUPPORT_LABELS.full} | Works end to end. |`,
    `| ${SUPPORT_LABELS.limited} | Works, with the limitation noted. |`,
    `| ${SUPPORT_LABELS['external-service']} | Requires an optional external service. |`,
    `| ${SUPPORT_LABELS.none} | Not available on this target (yet). |`,
    '',
  ];
  const areas = [...new Set(CAPABILITY_MATRIX.map((entry) => entry.area))];
  for (const area of areas) {
    lines.push(
      `## ${area}`,
      '',
      '| Feature | macOS | Windows | Chrome | Phase | Verification |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    const notes: string[] = [];
    for (const entry of CAPABILITY_MATRIX.filter((row) => row.area === area)) {
      const cells = TARGETS.map((target) => {
        const support = entry.targets[target];
        if (!support.note) return SUPPORT_LABELS[support.level];
        notes.push(`- **${entry.feature} (${TARGET_NAMES[target]}):** ${support.note}`);
        return `${SUPPORT_LABELS[support.level]} †`;
      });
      lines.push(
        `| ${escapeCell(entry.feature)} | ${cells.join(' | ')} | ${entry.plannedPhase ?? '—'} | ${escapeCell(entry.verification)} |`,
      );
    }
    if (notes.length > 0) lines.push('', ...notes);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
