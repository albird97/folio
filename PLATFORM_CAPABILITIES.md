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
| Open a PDF with a file picker | ✅ Full † | ✅ Full † | ✅ Full † | — | Extension: Playwright e2e. Desktop UI: Playwright e2e (web adapter); native dialog: manual. |
| Open PDFs by drag and drop | ✅ Full † | ✅ Full † | ✅ Full † | — | Extension and desktop UI: Playwright e2e. Native drop path: Rust unit tests for grant filtering. |
| Open from Finder / File Explorer (file association) | 🟡 Limited † | 🟡 Limited † | ⛔ Not supported † | 4 | Unit/e2e tests on Linux (shared code + Rust); macOS and Windows behaviour not yet exercised by an automated test. |
| Open password-protected PDFs | ✅ Full † | ✅ Full † | ✅ Full † | — | Unit tests with qpdf-encrypted fixtures; extension e2e. |
| Clear errors for damaged, empty or non-PDF files | ✅ Full | ✅ Full | ✅ Full | — | Unit tests with invalid fixtures; e2e for the error state. |
| Multiple documents in tabs | ✅ Full | ✅ Full | ✅ Full † | — | Desktop UI and extension e2e. |
| Document properties (metadata, page sizes, security) | ✅ Full | ✅ Full | ✅ Full | — | Unit tests (metadata normalization) and e2e. |
| Open the PDF in the current browser tab | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported | 5 | — |
| Open a PDF from a URL | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |

- **Open a PDF with a file picker (macOS):** Native dialog shown by the Rust layer; the webview never receives a path.
- **Open a PDF with a file picker (Windows):** Native dialog shown by the Rust layer; the webview never receives a path.
- **Open a PDF with a file picker (Chrome):** Picker in the editor page and side panel. The popup hands off to the editor because Chrome closes popups when a file dialog opens.
- **Open PDFs by drag and drop (macOS):** Dropped files are granted by the native layer.
- **Open PDFs by drag and drop (Windows):** Dropped files are granted by the native layer.
- **Open PDFs by drag and drop (Chrome):** Drop onto the editor page or the side panel.
- **Open from Finder / File Explorer (file association) (macOS):** Handles Finder “Open With” events once the app bundle is installed; Folio is registered as an alternate PDF handler.
- **Open from Finder / File Explorer (file association) (Windows):** Opens a PDF passed on launch. Opening another file while Folio runs starts a second window until single-instance support lands.
- **Open from Finder / File Explorer (file association) (Chrome):** Extensions cannot register as the operating system’s PDF handler.
- **Open password-protected PDFs (macOS):** AES-256 and legacy RC4 encryption via PDF.js; the password is only kept in memory.
- **Open password-protected PDFs (Windows):** AES-256 and legacy RC4 encryption via PDF.js; the password is only kept in memory.
- **Open password-protected PDFs (Chrome):** AES-256 and legacy RC4 encryption via PDF.js; the password is only kept in memory.
- **Multiple documents in tabs (Chrome):** Tabs inside the editor page; each browser tab is its own workspace.
- **Open the PDF in the current browser tab (macOS):** Not applicable.
- **Open the PDF in the current browser tab (Windows):** Not applicable.

## Viewing

| Feature | macOS | Windows | Chrome | Phase | Verification |
| --- | --- | --- | --- | --- | --- |
| Render pages | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 2 | E2E renders the preview canvas in Chromium; desktop webviews not yet automated. |
| Page thumbnails and navigation | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 2 | E2E. |
| Text search | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 2 | — |
| Zoom, fit-to-page and view rotation | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 2 | — |
| Text selection and copying | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 2 | — |

- **Render pages (macOS):** First-page preview only. The continuous, virtualized viewer arrives in Phase 2.
- **Render pages (Windows):** First-page preview only. The continuous, virtualized viewer arrives in Phase 2.
- **Render pages (Chrome):** First-page preview only. The continuous, virtualized viewer arrives in Phase 2.
- **Page thumbnails and navigation (macOS):** The Pages panel lists every page with its size and rotation; no thumbnails yet.
- **Page thumbnails and navigation (Windows):** The Pages panel lists every page with its size and rotation; no thumbnails yet.
- **Page thumbnails and navigation (Chrome):** The Pages panel lists every page with its size and rotation; no thumbnails yet.

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
| Export PDF | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 2 | — |
| Export pages as images | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |
| Extract text | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |
| Print | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 4 | — |
| Save the current webpage as PDF | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported | 5 | — |

- **Save and Save As (Chrome):** Will download a copy; extensions cannot write back to the original file.
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
| Native menus | ✅ Full † | ✅ Full † | ⛔ Not supported † | — | Unit/e2e tests on Linux (shared code + Rust); macOS and Windows behaviour not yet exercised by an automated test. |
| Keyboard shortcuts | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 4 | E2E. |
| Light, dark and system themes | ✅ Full | ✅ Full | ✅ Full | — | E2E (including axe checks in both themes). |
| Clipboard | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 4 | E2E. |
| Autosave and crash recovery | ⛔ Not supported † | ⛔ Not supported † | ⛔ Not supported † | 4 | Serialization unit tests. |
| Automatic updates | ⛔ Not supported † | ⛔ Not supported † | ✅ Full † | 7 | — |
| Installers | 🟡 Limited † | 🟡 Limited † | 🟡 Limited † | 4 | CI release builds on macOS and Windows runners (see README). |
| Send documents between the extension and the desktop app | ⛔ Not supported | ⛔ Not supported | ⛔ Not supported | 5 | — |

- **Native menus (macOS):** App, File, Edit, View, Window and Help menus.
- **Native menus (Windows):** File, Edit, View and Help menus in the window menu bar.
- **Native menus (Chrome):** Not applicable.
- **Keyboard shortcuts (macOS):** Open, close tab, next/previous tab, toggle panels and theme.
- **Keyboard shortcuts (Windows):** Open, close tab, next/previous tab, toggle panels and theme.
- **Keyboard shortcuts (Chrome):** Open, close tab, next/previous tab, toggle panels and theme.
- **Clipboard (macOS):** Copying document property values. Page content copying arrives with text selection.
- **Clipboard (Windows):** Copying document property values. Page content copying arrives with text selection.
- **Clipboard (Chrome):** Copying document property values. Page content copying arrives with text selection.
- **Autosave and crash recovery (macOS):** The validated recovery snapshot format exists in the shared core.
- **Autosave and crash recovery (Windows):** The validated recovery snapshot format exists in the shared core.
- **Autosave and crash recovery (Chrome):** The validated recovery snapshot format exists in the shared core.
- **Automatic updates (macOS):** Requires an updater signing key and a release feed.
- **Automatic updates (Windows):** Requires an updater signing key and a release feed.
- **Automatic updates (Chrome):** Handled by the Chrome Web Store once published.
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
| Local-only processing (no uploads, no analytics on content) | ✅ Full † | ✅ Full † | ✅ Full † | — | Manifest permission test; CSP restricts connections to the app itself. |

- **Local-only processing (no uploads, no analytics on content) (macOS):** No network requests are made with document data; the extension has no host permissions.
- **Local-only processing (no uploads, no analytics on content) (Windows):** No network requests are made with document data; the extension has no host permissions.
- **Local-only processing (no uploads, no analytics on content) (Chrome):** No network requests are made with document data; the extension has no host permissions.
