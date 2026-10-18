# Folio platform capabilities

<!-- Generated from packages/platform-adapters/src/capabilities.ts by `pnpm capabilities:generate`. Do not edit by hand. -->

Every feature is classified per target. A feature is only **Full** when it works end to end for
users on that target — a button existing is not enough. “Phase” is the phase in
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) that completes the feature. Cells marked † have
a note below the table.

| Level | Meaning |
| --- | --- |
| ✅ Full | Works end to end. |
| 🟡 Limited | Works, with the limitation noted. |
| ☁️ External service | Requires an optional external service. |
| ⛔ Not supported | Not available on this target (yet). |

## Opening documents

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Open a PDF with a file picker | 🟡 Limited † | 🟡 Limited † | ✅ Full † | 4 | Extension and desktop UI (web adapter): Playwright e2e. Native dialog: Rust unit tests for granting the chosen files; the dialog itself cannot be automated. |
| Open PDFs by drag and drop | 🟡 Limited † | 🟡 Limited † | ✅ Full † | 4 | Extension and desktop UI (web adapter): Playwright e2e. Native drops: Rust unit tests for grant filtering and the drag-hover signal. |
| Open from Finder / File Explorer (file association) | 🟡 Limited † | 🟡 Limited † | ⛔ Not supported † | 4 | Launch-argument opening: tauri-driver e2e against the real binary on Linux. Finder events and Explorer registration: compiled in CI only. |
| Open password-protected PDFs | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests with qpdf-encrypted fixtures; extension e2e. |
| Clear errors for damaged, empty or non-PDF files | ✅ Full | ✅ Full | ✅ Full | — | Unit tests with invalid fixtures; e2e for the error state. |
| Multiple documents in tabs | ✅ Full | ✅ Full | ✅ Full † | — | Desktop UI and extension e2e. |
| Document properties (metadata, page sizes, security) | ✅ Full | ✅ Full | ✅ Full | — | Unit tests (metadata normalization) and e2e. |
| Open the PDF in the current browser tab | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | — | E2E (Chromium): the popup, service worker download and editor hand-off run for real against a local server; the toolbar click (activeTab) and Chrome’s permission prompt are stubbed because they cannot be automated. Unit tests for the download rules. |
| Open a PDF from a web address | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | — | Unit tests for URLs, file names, sign-in detection, size limits and errors; e2e (Chromium) downloads from a local server through the service worker, with Chrome’s permission prompt stubbed. |

- **Open a PDF with a file picker (macOS):** Native dialog shown by the Rust layer; the webview only receives tokens and file names. Implemented and built in CI, but not yet verified on a real Mac.
- **Open a PDF with a file picker (Windows):** Native dialog shown by the Rust layer; the webview only receives tokens and file names. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Open a PDF with a file picker (Chrome):** Picker in the editor page and side panel. The popup hands off to the editor because Chrome closes popups when a file dialog opens.
- **Open PDFs by drag and drop (macOS):** Dropped files are granted by the native layer. Implemented and built in CI, but not yet verified on a real Mac.
- **Open PDFs by drag and drop (Windows):** Dropped files are granted by the native layer. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Open PDFs by drag and drop (Chrome):** Drop onto the editor page or the side panel.
- **Open from Finder / File Explorer (file association) (macOS):** Handles Finder “Open With” events once the app bundle is installed; Folio is registered as an alternate PDF handler. Implemented and built in CI, but not yet verified on a real Mac.
- **Open from Finder / File Explorer (file association) (Windows):** Opens a PDF passed on launch. Opening another file while Folio runs starts a second window until single-instance support lands. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Open from Finder / File Explorer (file association) (Chrome):** Extensions cannot register as the operating system’s PDF handler.
- **Open password-protected PDFs (macOS):** Standard security handler: AES-256 and legacy 128-bit RC4, both tested. The password is only kept in memory.
- **Open password-protected PDFs (Windows):** Standard security handler: AES-256 and legacy 128-bit RC4, both tested. The password is only kept in memory.
- **Open password-protected PDFs (Chrome):** Standard security handler: AES-256 and legacy 128-bit RC4, both tested. The password is only kept in memory.
- **Multiple documents in tabs (Chrome):** Tabs inside the editor page; each browser tab is its own workspace.
- **Open the PDF in the current browser tab (macOS):** Not applicable.
- **Open the PDF in the current browser tab (Windows):** Not applicable.
- **Open the PDF in the current browser tab (Chrome):** Click Folio’s toolbar button on a tab showing a PDF, then Open: a new editor tab asks Chrome for access to the site the first time and downloads the file. Chrome does not let extensions read PDFs opened from your computer (file://); choose those with Open a PDF.
- **Open a PDF from a web address (macOS):** Not applicable: the desktop app makes no network requests. Download the PDF in a browser, or send it from the Chrome extension.
- **Open a PDF from a web address (Windows):** Not applicable: the desktop app makes no network requests. Download the PDF in a browser, or send it from the Chrome extension.
- **Open a PDF from a web address (Chrome):** Chrome asks for access to each site on first use. No cookies are sent unless the site asks for a sign-in and you agree, for that one request; no referrer is sent. Up to 256 MB; web pages, missing files and other errors are explained.

## Viewing

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Render pages (continuous, virtualized scrolling) | ✅ Full † | ✅ Full † | ✅ Full † | — | E2E in Chromium (extension, desktop UI) including a 1,500-page budget for time to first page, mounted pages and memory; WebKitGTK through the real desktop binary (tauri-driver). |
| Page thumbnails and page navigation | ✅ Full † | ✅ Full † | ✅ Full † | — | E2E (Chromium) including keyboard navigation. |
| Bookmarks (document outline) | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests for destination resolution; DOM tests for the tree; e2e (Chromium). |
| Text search | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests for matching; e2e accuracy checks on fixtures (Chromium); highlighting in WebKitGTK (tauri-driver). |
| Zoom, fit width/page and view rotation | 🟡 Limited † | 🟡 Limited † | ✅ Full † | 4 | E2E in Chromium for the toolbar, keyboard, Ctrl+wheel and synthetic pinch events, including the anchor point. WebKit gesture events and the desktop menus have not been exercised. |
| Text selection and copying | ✅ Full † | ✅ Full † | ✅ Full † | — | E2E (Chromium) selects with the mouse and reads the clipboard; text layer placement in WebKitGTK (tauri-driver). |

- **Render pages (continuous, virtualized scrolling) (macOS):** Only pages near the window are kept; renders are queued by distance and cached within a memory budget. Documents with thousands of pages open at the first page while the remaining page sizes are read in the background.
- **Render pages (continuous, virtualized scrolling) (Windows):** Only pages near the window are kept; renders are queued by distance and cached within a memory budget. Documents with thousands of pages open at the first page while the remaining page sizes are read in the background.
- **Render pages (continuous, virtualized scrolling) (Chrome):** Only pages near the window are kept; renders are queued by distance and cached within a memory budget. Documents with thousands of pages open at the first page while the remaining page sizes are read in the background.
- **Page thumbnails and page navigation (macOS):** Virtualized thumbnails, page number field, previous/next page and keyboard navigation (arrow keys, Page Up/Down, Home/End).
- **Page thumbnails and page navigation (Windows):** Virtualized thumbnails, page number field, previous/next page and keyboard navigation (arrow keys, Page Up/Down, Home/End).
- **Page thumbnails and page navigation (Chrome):** Virtualized thumbnails, page number field, previous/next page and keyboard navigation (arrow keys, Page Up/Down, Home/End).
- **Bookmarks (document outline) (macOS):** Explicit and named destinations, as an accessible tree. Bookmarks that link to websites are listed but not opened.
- **Bookmarks (document outline) (Windows):** Explicit and named destinations, as an accessible tree. Bookmarks that link to websites are listed but not opened.
- **Bookmarks (document outline) (Chrome):** Explicit and named destinations, as an accessible tree. Bookmarks that link to websites are listed but not opened.
- **Text search (macOS):** Whole-document search with highlights, a results list, match case and whole words; ignores accents and finds words drawn in separate pieces. Scanned pages without a text layer cannot be searched until OCR arrives (Phase 6).
- **Text search (Windows):** Whole-document search with highlights, a results list, match case and whole words; ignores accents and finds words drawn in separate pieces. Scanned pages without a text layer cannot be searched until OCR arrives (Phase 6).
- **Text search (Chrome):** Whole-document search with highlights, a results list, match case and whole words; ignores accents and finds words drawn in separate pieces. Scanned pages without a text layer cannot be searched until OCR arrives (Phase 6).
- **Zoom, fit width/page and view rotation (macOS):** Toolbar, menu and keyboard zoom and rotation; trackpad pinch through WebKit gesture events. Implemented and built in CI, but not yet verified on a real Mac.
- **Zoom, fit width/page and view rotation (Windows):** Toolbar, menu and keyboard zoom and rotation; Ctrl+wheel and touchpad pinch. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Zoom, fit width/page and view rotation (Chrome):** Toolbar, menu and keyboard zoom, Ctrl+wheel and trackpad pinch (kept to the document, not the browser page), view rotation. Rotation is for viewing only.
- **Text selection and copying (macOS):** Selectable text layer over each page.
- **Text selection and copying (Windows):** Selectable text layer over each page.
- **Text selection and copying (Chrome):** Selectable text layer over each page.

## Editing

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Highlight, underline, strikethrough and comments | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back. |
| Freehand drawing and shapes | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back. |
| Add text (new content on top of the page) | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back. |
| Add images | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back. |
| Undo and redo | ✅ Full † | ✅ Full † | ✅ Full † | — | Model and store unit tests; e2e (Chromium) with the keyboard. |
| Insert, delete, duplicate, extract and reorder pages | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back. |
| Merge and split | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests of the model, store and export (results re-opened with PDF.js and checked with qpdf); e2e in Chromium for the desktop UI and the extension, reading saved files back. |
| Edit metadata | ✅ Full † | ✅ Full † | ✅ Full † | — | Export tests read the saved metadata back with PDF.js; e2e (Chromium). |
| Respect the document’s permission settings | ✅ Full † | ✅ Full † | ✅ Full † | — | Store unit tests; export tests re-open protected results; e2e (Chromium). |
| Page numbers and watermarks | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 6 | — |

- **Highlight, underline, strikethrough and comments (macOS):** Marks the selected text (across pages too) and places notes; a Comments list finds, reviews and deletes them. Saved as standard PDF annotations with appearance streams, so other viewers show them.
- **Highlight, underline, strikethrough and comments (Windows):** Marks the selected text (across pages too) and places notes; a Comments list finds, reviews and deletes them. Saved as standard PDF annotations with appearance streams, so other viewers show them.
- **Highlight, underline, strikethrough and comments (Chrome):** Marks the selected text (across pages too) and places notes; a Comments list finds, reviews and deletes them. Saved as standard PDF annotations with appearance streams, so other viewers show them.
- **Freehand drawing and shapes (macOS):** Pen, rectangle, ellipse, line and arrow, with colour, fill, opacity and line width; select, move, resize, nudge and delete.
- **Freehand drawing and shapes (Windows):** Pen, rectangle, ellipse, line and arrow, with colour, fill, opacity and line width; select, move, resize, nudge and delete.
- **Freehand drawing and shapes (Chrome):** Pen, rectangle, ellipse, line and arrow, with colour, fill, opacity and line width; select, move, resize, nudge and delete.
- **Add text (new content on top of the page) (macOS):** Text boxes in the standard PDF fonts (Helvetica, Times, Courier), laid out identically on screen and in the file; characters those fonts lack are saved as “?” and the user is told. This adds new text; it does not edit the PDF’s existing text.
- **Add text (new content on top of the page) (Windows):** Text boxes in the standard PDF fonts (Helvetica, Times, Courier), laid out identically on screen and in the file; characters those fonts lack are saved as “?” and the user is told. This adds new text; it does not edit the PDF’s existing text.
- **Add text (new content on top of the page) (Chrome):** Text boxes in the standard PDF fonts (Helvetica, Times, Courier), laid out identically on screen and in the file; characters those fonts lack are saved as “?” and the user is told. This adds new text; it does not edit the PDF’s existing text.
- **Add images (macOS):** PNG, JPEG, WebP, GIF or BMP pictures, re-encoded as PNG or JPEG with their orientation applied and their metadata (such as location) removed.
- **Add images (Windows):** PNG, JPEG, WebP, GIF or BMP pictures, re-encoded as PNG or JPEG with their orientation applied and their metadata (such as location) removed.
- **Add images (Chrome):** PNG, JPEG, WebP, GIF or BMP pictures, re-encoded as PNG or JPEG with their orientation applied and their metadata (such as location) removed.
- **Undo and redo (macOS):** Every change to annotations, pages and properties, from the toolbar, menus or keyboard; typing in a text field keeps its own undo.
- **Undo and redo (Windows):** Every change to annotations, pages and properties, from the toolbar, menus or keyboard; typing in a text field keeps its own undo.
- **Undo and redo (Chrome):** Every change to annotations, pages and properties, from the toolbar, menus or keyboard; typing in a text field keeps its own undo.
- **Insert, delete, duplicate, extract and reorder pages (macOS):** Multi-select in the pages panel, drag to reorder, rotate, duplicate, delete, insert blank pages or pages of other PDFs (protected ones ask for their password), extract pages to a new file. Removed pages leave no content, form values or bookmarks targets behind in saved files.
- **Insert, delete, duplicate, extract and reorder pages (Windows):** Multi-select in the pages panel, drag to reorder, rotate, duplicate, delete, insert blank pages or pages of other PDFs (protected ones ask for their password), extract pages to a new file. Removed pages leave no content, form values or bookmarks targets behind in saved files.
- **Insert, delete, duplicate, extract and reorder pages (Chrome):** Multi-select in the pages panel, drag to reorder, rotate, duplicate, delete, insert blank pages or pages of other PDFs (protected ones ask for their password), extract pages to a new file. Removed pages leave no content, form values or bookmarks targets behind in saved files.
- **Merge and split (macOS):** Merge by inserting the pages of other PDFs; split every N pages or before selected pages into new documents.
- **Merge and split (Windows):** Merge by inserting the pages of other PDFs; split every N pages or before selected pages into new documents.
- **Merge and split (Chrome):** Merge by inserting the pages of other PDFs; split every N pages or before selected pages into new documents.
- **Edit metadata (macOS):** Title, author, subject and keywords, written to both the Info dictionary and XMP.
- **Edit metadata (Windows):** Title, author, subject and keywords, written to both the Info dictionary and XMP.
- **Edit metadata (Chrome):** Title, author, subject and keywords, written to both the Info dictionary and XMP.
- **Respect the document’s permission settings (macOS):** Commenting, page changes, editing properties and copying pages out follow the PDF’s permission flags, with an explanation; saved copies keep the original’s password and permissions.
- **Respect the document’s permission settings (Windows):** Commenting, page changes, editing properties and copying pages out follow the PDF’s permission flags, with an explanation; saved copies keep the original’s password and permissions.
- **Respect the document’s permission settings (Chrome):** Commenting, page changes, editing properties and copying pages out follow the PDF’s permission flags, with an explanation; saved copies keep the original’s password and permissions.

## Saving and export

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Save and Save As | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported † | 4 | — |
| Save changes as a new PDF (Save as) | 🟡 Limited † | 🟡 Limited † | ✅ Full † | 4 | Export tests re-open every result with PDF.js and check it with qpdf; e2e (Chromium) reads downloaded files back with pdf-lib. The native save dialog cannot be automated. |
| Save a copy of the original PDF | 🟡 Limited † | 🟡 Limited † | ✅ Full † | 4 | Extension and desktop UI: e2e compares the SHA-256 of the saved file with the original. Desktop: Rust unit tests for validation, file names and atomic writes; tauri-driver checks that non-PDF data is refused. The native dialog cannot be automated. |
| Export pages as images | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | 6 | E2E (Chromium) reads the downloaded ZIP and images back; the ZIP writer is unit-tested against Python’s zipfile. |
| Extract text | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | 6 | Unit tests on the text fixture; e2e (Chromium) copies and downloads it. |
| Print | ⛔ Not supported | ⛔ Not supported | ✅ Full † | 4 | E2E (Chromium) prints through the print layout to a PDF and counts its pages; unit tests for page ranges and print resolution. |
| Save the current webpage as PDF | ⛔ Not supported † | ⛔ Not supported † | 🟡 Limited † | — | E2E (Chromium) checks that the popup asks Chrome to print the tab (activeTab stubbed); the print dialog cannot be automated. |

- **Save and Save As (Chrome):** Will download a copy; extensions cannot write back to the original file.
- **Save changes as a new PDF (Save as) (macOS):** Writes the edited document through the native save dialog; comments can be kept editable or flattened into the pages. Implemented and built in CI, but not yet verified on a real Mac.
- **Save changes as a new PDF (Save as) (Windows):** Writes the edited document through the native save dialog; comments can be kept editable or flattened into the pages. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Save changes as a new PDF (Save as) (Chrome):** Downloads the edited document; comments can be kept editable or flattened into the pages.
- **Save a copy of the original PDF (macOS):** Native save dialog shown by the Rust layer, which only writes PDF data, through a temporary file. The webview never sees the path. Implemented and built in CI, but not yet verified on a real Mac.
- **Save a copy of the original PDF (Windows):** Native save dialog shown by the Rust layer, which only writes PDF data, through a temporary file. The webview never sees the path. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Save a copy of the original PDF (Chrome):** Downloaded through Chrome’s downloads; needs no extra permission.
- **Export pages as images (macOS):** Planned for the editor (Phase 6).
- **Export pages as images (Windows):** Planned for the editor (Phase 6).
- **Export pages as images (Chrome):** Side panel: chosen pages as PNG or JPEG at 72, 150 or 300 dpi; several pages download as one ZIP file.
- **Extract text (macOS):** Planned for the editor (Phase 6); page text can be selected and copied today.
- **Extract text (Windows):** Planned for the editor (Phase 6); page text can be selected and copied today.
- **Extract text (Chrome):** Side panel: text of chosen pages, line by line, to copy or download as .txt. Scanned pages need OCR, which Folio does not have yet.
- **Print (Chrome):** All, current or chosen pages, with or without comments, through Chrome’s print dialog. Folio draws the pages at print resolution on this device first.
- **Save the current webpage as PDF (macOS):** Not applicable.
- **Save the current webpage as PDF (Windows):** Not applicable.
- **Save the current webpage as PDF (Chrome):** Opens Chrome’s print dialog for the tab, where “Save as PDF” is a destination; Chrome writes the file, and Folio does not open it afterwards. Chrome’s own pages and the Web Store cannot be printed this way: extensions cannot run scripts there.

## Advanced tools

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Fill forms | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 6 | — |
| Place signatures | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 6 | — |
| OCR | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 6 | — |
| Add password protection | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 6 | — |
| Compress PDFs | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 6 | — |

- **OCR (macOS):** Planned as a bundled, on-device engine; no cloud OCR by default.
- **OCR (Windows):** Planned as a bundled, on-device engine; no cloud OCR by default.
- **OCR (Chrome):** Planned as a bundled, on-device engine; no cloud OCR by default.

## App and platform

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Native menus | 🟡 Limited † | 🟡 Limited † | ⛔ Not supported † | 4 | Rust unit tests for command forwarding on Linux, macOS and Windows CI runners. No test builds or uses the menus. |
| Keyboard shortcuts | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 4 | Key matching: unit tests. Browser key set: extension e2e. Desktop key set: desktop UI e2e in Chromium. Menu accelerators: Rust unit tests only. |
| Light, dark and system themes | ✅ Full | ✅ Full | ✅ Full | — | E2E (including axe checks in both themes). |
| Clipboard | 🟡 Limited † | 🟡 Limited † | ✅ Full † | 4 | E2E (Chromium) reads the clipboard after copying. |
| Autosave and crash recovery | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | 4 | Unit tests restore documents with their history, passwords asked again and damaged records refused; e2e (Chromium) restores after closing the tab and checks that saved work leaves nothing behind. |
| Automatic updates | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 7 | — |
| Installers | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 4 | CI release builds on macOS and Windows runners (see README). |
| Send documents between the extension and the desktop app | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | 5 | Unit tests of the protocol against a scripted host; e2e (Chromium, Linux) sends documents from the side panel and the editor to the real desktop host binary, with the permission granted at install in a test copy of the extension (Chrome’s prompt cannot be automated). |

- **Native menus (macOS):** Folio (app), File, Edit, View and Window menus, with Save a Copy, Find and the zoom, rotation and Go to Page commands. Implemented and built in CI, but not yet verified on a real Mac.
- **Native menus (Windows):** File, Edit, View and Help menus in the window menu bar, with the same commands. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Native menus (Chrome):** Not applicable.
- **Keyboard shortcuts (macOS):** Open, Save as, Save a copy, undo and redo, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous, rotate (⌘R/⌘L) and Close Window. Switching the theme has no shortcut. Implemented and built in CI, but not yet verified on a real Mac.
- **Keyboard shortcuts (Windows):** Open, Save as, Save a copy, undo and redo, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous, rotate (Ctrl+R/Ctrl+L). Switching the theme has no shortcut. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Keyboard shortcuts (Chrome):** Open, Save as, Save a copy, undo and redo, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous. Closing and switching documents use Alt keys because Chrome reserves Ctrl/⌘+W and Ctrl+Tab; rotation has no shortcut because Chrome keeps Ctrl+R and Ctrl+L. Switching the theme has no shortcut.
- **Clipboard (macOS):** Document property values and selected page text. Implemented and built in CI, but not yet verified on a real Mac.
- **Clipboard (Windows):** Document property values and selected page text. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Clipboard (Chrome):** Document property values and selected page text.
- **Autosave and crash recovery (macOS):** The validated recovery snapshot format exists in the shared core.
- **Autosave and crash recovery (Windows):** The validated recovery snapshot format exists in the shared core.
- **Autosave and crash recovery (Chrome):** Unsaved changes are kept in the extension’s storage on this device two seconds after each change and offered when the editor opens again. Saving, closing or discarding deletes them; documents open in another editor tab are not offered.
- **Automatic updates (macOS):** Requires an updater signing key and a release feed.
- **Automatic updates (Windows):** Requires an updater signing key and a release feed.
- **Automatic updates (Chrome):** Will be handled by the Chrome Web Store once published.
- **Installers (macOS):** Unsigned .app/.dmg; Developer ID signing and notarization need Apple credentials.
- **Installers (Windows):** Unsigned NSIS .exe and .msi; Authenticode signing needs a certificate.
- **Installers (Chrome):** Unpacked build and a Web Store zip; not yet published.
- **Send documents between the extension and the desktop app (macOS):** The desktop side (native messaging host and approval prompt) is being merged.
- **Send documents between the extension and the desktop app (Windows):** The desktop side (native messaging host and approval prompt) is being merged.
- **Send documents between the extension and the desktop app (Chrome):** Open in Folio for desktop, from the editor (with your changes) or the side panel. Chrome asks for the permission the first time; the desktop app asks before it opens anything. When the app is missing or not connected, Folio explains how to set it up.

## Chrome extension

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Toolbar popup with quick actions and recent activity | ⛔ Not supported † | ⛔ Not supported † | ✅ Full | — | Extension e2e. |
| Side panel | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | — | Extension e2e, including axe checks. |
| Options page with permission explanations | ⛔ Not supported † | ⛔ Not supported † | ✅ Full | — | Extension e2e. |
| Download PDFs linked from a page | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | — | E2E (Chromium) with the page scan and the downloads API stubbed (they need the toolbar click and a permission prompt). |

- **Toolbar popup with quick actions and recent activity (macOS):** Not applicable.
- **Toolbar popup with quick actions and recent activity (Windows):** Not applicable.
- **Side panel (macOS):** Not applicable.
- **Side panel (Windows):** Not applicable.
- **Side panel (Chrome):** Inspect a PDF, rotate or extract pages, turn pages into images and extract text; list the PDFs linked from the current tab to open or download.
- **Options page with permission explanations (macOS):** Not applicable.
- **Options page with permission explanations (Windows):** Not applicable.
- **Download PDFs linked from a page (macOS):** Not applicable.
- **Download PDFs linked from a page (Windows):** Not applicable.
- **Download PDFs linked from a page (Chrome):** The side panel lists the PDFs a tab links to (after a click on Folio’s toolbar button there). Downloads go through Chrome’s downloads, with the browser’s own sign-in for the site; Chrome asks for the downloads permission on first use.

## Privacy

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Local-only processing (no uploads, no analytics on content) | ✅ Full † | ✅ Full † | ✅ Full † | — | Extension: e2e asserts no site access at install, no network requests while opening a document and that pages’ CSP blocks requests to other servers; unit tests check the CSPs and that downloads carry no cookies or referrer unless allowed. Desktop: the CSP allows only the app itself, checked by tauri-driver e2e. |

- **Local-only processing (no uploads, no analytics on content) (macOS):** No document data is ever sent anywhere. The extension downloads PDFs only from sites you allow, in its service worker; its pages cannot connect to other servers at all.
- **Local-only processing (no uploads, no analytics on content) (Windows):** No document data is ever sent anywhere. The extension downloads PDFs only from sites you allow, in its service worker; its pages cannot connect to other servers at all.
- **Local-only processing (no uploads, no analytics on content) (Chrome):** No document data is ever sent anywhere. The extension downloads PDFs only from sites you allow, in its service worker; its pages cannot connect to other servers at all.
