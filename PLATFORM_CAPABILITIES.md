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
| Open the PDF in the current browser tab | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported | 5 | — |
| Open a PDF from a URL | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |

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
| Highlight, underline, strikethrough and comments | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 3 | Model unit tests only. |
| Freehand drawing and shapes | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 3 | — |
| Add text (new content on top of the page) | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 3 | — |
| Add images | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 3 | — |
| Undo and redo | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 3 | Model unit tests. |
| Insert, delete, duplicate, extract and reorder pages | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 3 | Model unit tests. |
| Merge and split | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 3 | — |
| Edit metadata | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 3 | — |
| Page numbers and watermarks | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 6 | — |

- **Highlight, underline, strikethrough and comments (macOS):** Annotation types exist in the shared document model.
- **Highlight, underline, strikethrough and comments (Windows):** Annotation types exist in the shared document model.
- **Highlight, underline, strikethrough and comments (Chrome):** Annotation types exist in the shared document model.
- **Add text (new content on top of the page) (macOS):** Adds new text objects; editing the PDF’s existing text is a separate, later capability.
- **Add text (new content on top of the page) (Windows):** Adds new text objects; editing the PDF’s existing text is a separate, later capability.
- **Add text (new content on top of the page) (Chrome):** Adds new text objects; editing the PDF’s existing text is a separate, later capability.
- **Undo and redo (macOS):** Operation-based history is implemented and tested in the shared core; no editing UI uses it yet.
- **Undo and redo (Windows):** Operation-based history is implemented and tested in the shared core; no editing UI uses it yet.
- **Undo and redo (Chrome):** Operation-based history is implemented and tested in the shared core; no editing UI uses it yet.
- **Insert, delete, duplicate, extract and reorder pages (macOS):** Model operations exist; writing the result to a PDF does not.
- **Insert, delete, duplicate, extract and reorder pages (Windows):** Model operations exist; writing the result to a PDF does not.
- **Insert, delete, duplicate, extract and reorder pages (Chrome):** Model operations exist; writing the result to a PDF does not.

## Saving and export

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Save and Save As | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported † | 4 | — |
| Save a copy of the original PDF | 🟡 Limited † | 🟡 Limited † | ✅ Full † | 4 | Extension and desktop UI: e2e compares the SHA-256 of the saved file with the original. Desktop: Rust unit tests for validation, file names and atomic writes; tauri-driver checks that non-PDF data is refused. The native dialog cannot be automated. |
| Export pages as images | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |
| Extract text | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |
| Print | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 4 | — |
| Save the current webpage as PDF | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported | 5 | — |

- **Save and Save As (Chrome):** Will download a copy; extensions cannot write back to the original file.
- **Save a copy of the original PDF (macOS):** Native save dialog shown by the Rust layer, which only writes PDF data, through a temporary file. The webview never sees the path. Implemented and built in CI, but not yet verified on a real Mac.
- **Save a copy of the original PDF (Windows):** Native save dialog shown by the Rust layer, which only writes PDF data, through a temporary file. The webview never sees the path. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Save a copy of the original PDF (Chrome):** Downloaded through Chrome’s downloads; needs no extra permission.
- **Save the current webpage as PDF (macOS):** Not applicable.
- **Save the current webpage as PDF (Windows):** Not applicable.

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
| Autosave and crash recovery | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 4 | Serialization unit tests. |
| Automatic updates | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 7 | — |
| Installers | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 4 | CI release builds on macOS and Windows runners (see README). |
| Send documents between the extension and the desktop app | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |

- **Native menus (macOS):** Folio (app), File, Edit, View and Window menus, with Save a Copy, Find and the zoom, rotation and Go to Page commands. Implemented and built in CI, but not yet verified on a real Mac.
- **Native menus (Windows):** File, Edit, View and Help menus in the window menu bar, with the same commands. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Native menus (Chrome):** Not applicable.
- **Keyboard shortcuts (macOS):** Open, Save a copy, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous, rotate (⌘R/⌘L) and Close Window. Switching the theme has no shortcut. Implemented and built in CI, but not yet verified on a real Mac.
- **Keyboard shortcuts (Windows):** Open, Save a copy, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous, rotate (Ctrl+R/Ctrl+L). Switching the theme has no shortcut. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Keyboard shortcuts (Chrome):** Open, Save a copy, close and switch documents, sidebar and Properties panel, zoom in/out/actual size, go to page, find next/previous. Closing and switching documents use Alt keys because Chrome reserves Ctrl/⌘+W and Ctrl+Tab; rotation has no shortcut because Chrome keeps Ctrl+R and Ctrl+L. Switching the theme has no shortcut.
- **Clipboard (macOS):** Document property values and selected page text. Implemented and built in CI, but not yet verified on a real Mac.
- **Clipboard (Windows):** Document property values and selected page text. Implemented and built in CI, but not yet verified on a real Windows PC.
- **Clipboard (Chrome):** Document property values and selected page text.
- **Autosave and crash recovery (macOS):** The validated recovery snapshot format exists in the shared core.
- **Autosave and crash recovery (Windows):** The validated recovery snapshot format exists in the shared core.
- **Autosave and crash recovery (Chrome):** The validated recovery snapshot format exists in the shared core.
- **Automatic updates (macOS):** Requires an updater signing key and a release feed.
- **Automatic updates (Windows):** Requires an updater signing key and a release feed.
- **Automatic updates (Chrome):** Will be handled by the Chrome Web Store once published.
- **Installers (macOS):** Unsigned .app/.dmg; Developer ID signing and notarization need Apple credentials.
- **Installers (Windows):** Unsigned NSIS .exe and .msi; Authenticode signing needs a certificate.
- **Installers (Chrome):** Unpacked build and a Web Store zip; not yet published.

## Chrome extension

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Toolbar popup with quick actions and recent activity | ⛔ Not supported † | ⛔ Not supported † | ✅ Full | — | Extension e2e. |
| Side panel | ⛔ Not supported † | ⛔ Not supported † | 🟡 Limited † | 5 | Extension e2e. |
| Options page with permission explanations | ⛔ Not supported † | ⛔ Not supported † | ✅ Full | — | Extension e2e. |

- **Toolbar popup with quick actions and recent activity (macOS):** Not applicable.
- **Toolbar popup with quick actions and recent activity (Windows):** Not applicable.
- **Side panel (macOS):** Not applicable.
- **Side panel (Windows):** Not applicable.
- **Side panel (Chrome):** Inspect a local PDF and hand it to the editor. Page tools arrive with Phase 5.
- **Options page with permission explanations (macOS):** Not applicable.
- **Options page with permission explanations (Windows):** Not applicable.

## Privacy

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Local-only processing (no uploads, no analytics on content) | ✅ Full † | ✅ Full † | ✅ Full † | — | Extension: e2e asserts no host permissions, no network requests while opening a document and that the CSP blocks requests to other servers; a unit test checks the CSP. Desktop: the CSP allows only the app itself, checked by tauri-driver e2e. |

- **Local-only processing (no uploads, no analytics on content) (macOS):** No network requests are made with document data; the extension has no host permissions.
- **Local-only processing (no uploads, no analytics on content) (Windows):** No network requests are made with document data; the extension has no host permissions.
- **Local-only processing (no uploads, no analytics on content) (Chrome):** No network requests are made with document data; the extension has no host permissions.
