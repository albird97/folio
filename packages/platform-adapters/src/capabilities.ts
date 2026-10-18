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

const EDITING_VERIFIED =
  'Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back.';

const SHORTCUTS =
  'Open, Save as, Save a copy, undo and redo, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous';
const NO_THEME_SHORTCUT = 'Switching the theme has no shortcut.';

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
      macos: unverified('macos', 'Dropped files are granted by the native layer.'),
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
      macos: unverified(
        'macos',
        'Handles Finder “Open With” events once the app bundle is installed; Folio is registered as an alternate PDF handler.',
      ),
      windows: unverified(
        'windows',
        'Opens a PDF passed on launch. Opening another file while Folio runs starts a second window until single-instance support lands.',
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
        'Whole-document search with highlights, a results list, match case and whole words; ignores accents and finds words drawn in separate pieces. Scanned pages without a text layer cannot be searched until OCR arrives (Phase 6).',
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
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  // Saving & export
  {
    id: 'save',
    area: 'Saving and export',
    feature: 'Save and Save As',
    plannedPhase: 4,
    targets: {
      macos: none(),
      windows: none(),
      chrome: none('Will download a copy; extensions cannot write back to the original file.'),
    },
    verification: '—',
    runtimeFeature: 'saveInPlace',
  },
  {
    id: 'save-as-edited',
    area: 'Saving and export',
    feature: 'Save changes as a new PDF (Save as)',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
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
    plannedPhase: 6,
    targets: {
      macos: none('Planned for the editor (Phase 6).'),
      windows: none('Planned for the editor (Phase 6).'),
      chrome: full(
        'Side panel: chosen pages as PNG or JPEG at 72, 150 or 300 dpi; several pages download as one ZIP file.',
      ),
    },
    verification:
      'E2E (Chromium) reads the downloaded ZIP and images back; the ZIP writer is unit-tested against Python’s zipfile.',
  },
  {
    id: 'extract-text',
    area: 'Saving and export',
    feature: 'Extract text',
    plannedPhase: 6,
    targets: {
      macos: none('Planned for the editor (Phase 6); page text can be selected and copied today.'),
      windows: none(
        'Planned for the editor (Phase 6); page text can be selected and copied today.',
      ),
      chrome: full(
        'Side panel: text of chosen pages, line by line, to copy or download as .txt. Scanned pages need OCR, which Folio does not have yet.',
      ),
    },
    verification: 'Unit tests on the text fixture; e2e (Chromium) copies and downloads it.',
  },
  {
    id: 'printing',
    area: 'Saving and export',
    feature: 'Print',
    plannedPhase: 4,
    targets: {
      macos: none(),
      windows: none(),
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
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'signatures',
    area: 'Advanced tools',
    feature: 'Place signatures',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'ocr',
    area: 'Advanced tools',
    feature: 'OCR',
    plannedPhase: 6,
    targets: all(none('Planned as a bundled, on-device engine; no cloud OCR by default.')),
    verification: '—',
  },
  {
    id: 'password-protect',
    area: 'Advanced tools',
    feature: 'Add password protection',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  {
    id: 'compression',
    area: 'Advanced tools',
    feature: 'Compress PDFs',
    plannedPhase: 6,
    targets: all(none()),
    verification: '—',
  },
  // App & platform
  {
    id: 'native-menus',
    area: 'App and platform',
    feature: 'Native menus',
    plannedPhase: 4,
    targets: {
      macos: unverified(
        'macos',
        'Folio (app), File, Edit, View and Window menus, with Save a Copy, Find and the zoom, rotation and Go to Page commands.',
      ),
      windows: unverified(
        'windows',
        'File, Edit, View and Help menus in the window menu bar, with the same commands.',
      ),
      chrome: none('Not applicable.'),
    },
    verification:
      'Rust unit tests for command forwarding on Linux, macOS and Windows CI runners. No test builds or uses the menus.',
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
      macos: unverified('macos', 'Document property values and selected page text.'),
      windows: unverified('windows', 'Document property values and selected page text.'),
      chrome: full('Document property values and selected page text.'),
    },
    verification: 'E2E (Chromium) reads the clipboard after copying.',
    runtimeFeature: 'clipboardWrite',
  },
  {
    id: 'recovery',
    area: 'App and platform',
    feature: 'Autosave and crash recovery',
    plannedPhase: 4,
    targets: {
      macos: none('The validated recovery snapshot format exists in the shared core.'),
      windows: none('The validated recovery snapshot format exists in the shared core.'),
      chrome: full(
        'Unsaved changes are kept in the extension’s storage on this device two seconds after each change and offered when the editor opens again. Saving, closing or discarding deletes them; documents open in another editor tab are not offered.',
      ),
    },
    verification:
      'Unit tests restore documents with their history, passwords asked again and damaged records refused; e2e (Chromium) restores after closing the tab and checks that saved work leaves nothing behind.',
    runtimeFeature: 'crashRecovery',
  },
  {
    id: 'auto-update',
    area: 'App and platform',
    feature: 'Automatic updates',
    plannedPhase: 7,
    targets: {
      macos: none('Requires an updater signing key and a release feed.'),
      windows: none('Requires an updater signing key and a release feed.'),
      chrome: none('Will be handled by the Chrome Web Store once published.'),
    },
    verification: '—',
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
      macos: none('The desktop side (native messaging host and approval prompt) is being merged.'),
      windows: none(
        'The desktop side (native messaging host and approval prompt) is being merged.',
      ),
      chrome: full(
        'Open in Folio for desktop, from the editor (with your changes) or the side panel. Chrome asks for the permission the first time; the desktop app asks before it opens anything. When the app is missing or not connected, Folio explains how to set it up.',
      ),
    },
    verification:
      'Unit tests of the protocol against a scripted host; e2e (Chromium, Linux) sends documents from the side panel and the editor to the real desktop host binary, with the permission granted at install in a test copy of the extension (Chrome’s prompt cannot be automated).',
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
    feature: 'Local-only processing (no uploads, no analytics on content)',
    plannedPhase: null,
    targets: all(
      full(
        'No document data is ever sent anywhere. The extension downloads PDFs only from sites you allow, in its service worker; its pages cannot connect to other servers at all.',
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
