# Folio

[![CI](https://github.com/albird97/folio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/albird97/folio/actions/workflows/ci.yml)
[![Desktop installers](https://github.com/albird97/folio/actions/workflows/desktop.yml/badge.svg?branch=main)](https://github.com/albird97/folio/actions/workflows/desktop.yml)

Folio is a local-first PDF suite for **macOS**, **Windows** and **Google Chrome**. It is one
product: the document model, PDF engine, design system and workspace UI are shared, and each
target adds a thin platform adapter.

> **Status: Phase 3 (Core editing) complete.** Folio opens, reads and edits PDFs on all three
> targets:
>
> - Ways to open: file picker, drag and drop, launch arguments and Finder events on desktop, and a
>   side-panel hand-off in Chrome. Password-protected files can be unlocked.
> - A continuous, virtualized page viewer that stays fast with thousands of pages: thumbnails,
>   bookmarks, page navigation, zoom (fit width, fit page, presets, Ctrl+wheel and pinch), view
>   rotation, text selection and copying, and whole-document search with highlights and a
>   results list.
> - Editing: highlight, underline and strike through text, notes, freehand drawing, shapes,
>   added text and images, with a Comments list and an inspector. Pages can be reordered by
>   dragging, rotated, duplicated, deleted, inserted (blank or from other PDFs), extracted and
>   split. Document properties are editable. Everything is undoable.
> - **Save as** writes the edited document to a new file (a save dialog on desktop, a download in
>   Chrome), with comments kept editable or flattened into the pages. **Save a copy of the
>   original** writes the opened file unchanged. Folio never overwrites the files you open on its
>   own.
> - Multiple documents in tabs, document properties, light and dark themes, keyboard shortcuts.
> - On macOS and Windows, the native file and save dialogs, drag and drop, menus, shortcuts,
>   pinch zoom and file association are built in CI but not yet verified on a real Mac or
>   Windows PC.
>
> Saving in place, printing, crash recovery and the Chrome integrations follow in Phases 4 and 5.
> See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the roadmap and
> [PLATFORM_CAPABILITIES.md](PLATFORM_CAPABILITIES.md) for the support matrix.

Documents are processed on your device. Folio makes no network requests with document data, and
the extension has no access to the websites you visit.

## Repository layout

| Path                         | What it is                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `apps/desktop`               | Tauri 2 app: React UI (`src/`), Rust commands, menus and packaging (`src-tauri/`) |
| `apps/chrome-extension`      | Manifest V3 extension: popup, side panel, editor page, options, service worker    |
| `packages/document-model`    | Document types, IDs, operations, undo/redo history, recovery snapshots            |
| `packages/pdf-core`          | PDF.js engine wrapper: loading, rendering, text, outlines, bundled PDF.js assets  |
| `packages/platform-adapters` | Platform adapter contract, web/memory adapters, capability matrix                 |
| `packages/shared-ui`         | Design tokens, Tailwind theme, accessible primitives, brand mark                  |
| `packages/editor`            | The shared workspace: tabs, toolbar, viewer, sidebar, search, and its stores      |
| `tests/`                     | PDF fixtures, Playwright suites, the native desktop WebDriver test                |
| `brand/`                     | Original Folio artwork (SVG sources and the 1024px app icon)                      |

## Prerequisites

- **Node.js 22.13+** and **pnpm 10** (`corepack enable` picks up the pinned version).
- **Rust** (stable) for the desktop app.
- **Platform toolchains for Tauri:**
  - macOS: Xcode Command Line Tools.
  - Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10/11).
  - Linux: `libwebkit2gtk-4.1-dev`, `build-essential`, `libxdo-dev`, `libssl-dev`,
    `libayatana-appindicator3-dev` and `librsvg2-dev`.
- Optional: `qpdf` (to regenerate fixtures) and `tauri-driver` + `webkit2gtk-driver` (native e2e on Linux).

```sh
pnpm install
```

## Commands

| Task                                                 | Command                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| Desktop app, development (native window, hot reload) | `pnpm dev:desktop`                                                |
| Desktop UI in a normal browser (web adapter)         | `pnpm dev:desktop:web` → http://localhost:1420                    |
| Build macOS app + DMG (universal, on macOS)          | `pnpm build:desktop:macos`                                        |
| Build Windows MSI + NSIS installer (on Windows)      | `pnpm build:desktop:windows`                                      |
| Build Linux .deb (on Linux)                          | `pnpm build:desktop:linux`                                        |
| Build for the current platform, all bundle types     | `pnpm build:desktop`                                              |
| Extension, development (rebuilds on change)          | `pnpm dev:extension`                                              |
| Extension, production build                          | `pnpm build:extension` → `apps/chrome-extension/dist`             |
| Extension, Web Store zip                             | `pnpm --filter @folio/chrome-extension package`                   |
| Unit tests (all packages and apps)                   | `pnpm test`                                                       |
| E2E: extension + desktop UI (build both first)       | `pnpm build:extension && pnpm build:desktop:web && pnpm test:e2e` |
| E2E: real desktop binary (verified on Linux)         | `pnpm build:desktop:linux && xvfb-run -a pnpm test:e2e:desktop`   |
| Rust tests / lint                                    | `pnpm test:rust` / `pnpm lint:rust`                               |
| Type checking, lint, formatting                      | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                |
| Everything quick (format, lint, types, unit)         | `pnpm check`                                                      |
| Regenerate PLATFORM_CAPABILITIES.md                  | `pnpm capabilities:generate`                                      |
| Regenerate PDF fixtures (needs qpdf)                 | `pnpm fixtures:generate`                                          |

Release builds bundle the web UI and need neither Node.js nor Rust on the user's machine.
Installers appear under `target/release/bundle/` (or `target/universal-apple-darwin/release/bundle/` on macOS).

## Running the desktop app

1. `pnpm dev:desktop` starts Vite on port 1420 and opens Folio in a native window.
2. Open PDFs with **File → Open…** (⌘O / Ctrl+O), by dropping them onto the window, or by passing
   them on the command line (`target/release/folio-desktop file.pdf`). Nothing is dropped
   silently: files that are not PDFs are reported, and a file that was moved or deleted before
   Folio could open it gets an error tab.
3. Scroll through the pages, or use the sidebar (thumbnails, bookmarks and search results), the
   page number field and the zoom menu in the toolbar.

**Shortcuts:**

| Action                   | macOS               | Windows / Linux                       |
| ------------------------ | ------------------- | ------------------------------------- |
| Open                     | ⌘O                  | Ctrl+O                                |
| Save as                  | ⇧⌘S                 | Ctrl+Shift+S                          |
| Save a copy of original  | ⌥⌘S                 | Ctrl+Alt+S                            |
| Undo / redo              | ⌘Z / ⇧⌘Z            | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y       |
| Close document           | ⌘W                  | Ctrl+W                                |
| Close window             | ⇧⌘W                 | —                                     |
| Next / previous document | ⌃Tab / ⌃⇧Tab        | Ctrl+Tab / Ctrl+Shift+Tab             |
| Sidebar                  | ⌘⌥1                 | Ctrl+Alt+1                            |
| Properties panel         | ⌘⌥2                 | Ctrl+Alt+2                            |
| Zoom in / out            | ⌘= / ⌘-             | Ctrl+= / Ctrl+-                       |
| Actual size              | ⌘0                  | Ctrl+0                                |
| Rotate view right / left | ⌘R / ⌘L             | Ctrl+R / Ctrl+L                       |
| Go to page               | ⌘⌥G                 | Ctrl+Alt+G                            |
| Find                     | ⌘F                  | Ctrl+F                                |
| Find next / previous     | ⌘G / ⇧⌘G (F3 / ⇧F3) | Ctrl+G / Ctrl+Shift+G (F3 / Shift+F3) |

In the page view, arrow keys, Page Up/Down and Space scroll, ← and → turn pages when the page
fits the window's width, and Home/End go to the first and last page. Ctrl+wheel and trackpad or
touch pinches zoom around the pointer. Fit width and Fit page are in
the zoom menu and the **View** menu. Rotation only changes the view; the file is not modified.

The macOS menus are Folio, File, Edit, View and Window. ⌘W closes the current document, so
**Window → Close Window** uses ⇧⌘W. Windows and Linux have File, Edit, View and
Help (**Help → About Folio**). Switching the theme has no shortcut: use the toolbar button or
**View → Switch Theme**. Letter shortcuts follow your keyboard layout (AZERTY included), and
AltGr combinations never trigger shortcuts.

### Editing

- **Comments and drawing:** the tool bar above the pages has Select, Highlight, Underline,
  Strikethrough, Note, Draw, Rectangle, Ellipse, Line, Arrow, Add text and Add image. The markup
  tools mark the text you select. With Select, click an annotation to select it, drag it to
  move it, drag its handles to resize it, use the arrow keys to nudge it (Shift for 10 pt) and
  Delete to remove it; double-click a note or a text box to edit it. The Properties panel shows
  the selected annotation's colour, opacity, line width, font and text. The **Comments** tab in
  the sidebar lists every annotation.
- **Added text is new content** placed on top of the page in a standard PDF font (Helvetica,
  Times or Courier). Folio does not edit the PDF's existing text. Characters these fonts cannot
  show are saved as "?", and Folio says so.
- **Pages:** select pages in the Pages tab (Shift-click for a range, Ctrl/⌘-click to add), drag
  them to reorder, and use the buttons above the thumbnails to insert a blank page or pages of
  another PDF, rotate, duplicate, delete, extract or split. In browsers, PDFs dropped between
  thumbnails are inserted there.
- **Properties:** title, author, subject and keywords are editable in the Properties panel.
- Folio follows the document's permission settings (for example, a PDF that does not allow
  comments), and saved copies of password-protected PDFs keep the same password and permissions.

Folio never overwrites the files you open on its own. **Save as** (in the toolbar, ⇧⌘S /
Ctrl+Shift+S) writes the edited document to a new file you choose in the native save dialog (the
original is replaced only if you pick it there); its menu also offers a copy with comments
flattened into the pages, and **Save a copy of the original**, which writes the opened file
unchanged. The Rust layer
accepts only PDF data and writes it through a temporary file, so an interrupted save never leaves
a half-written file. The webview never sees paths: files are reachable only through tokens issued
by the Rust layer, and the save command returns only the chosen file's name. Closing a document
with unsaved changes asks first.

## Installing and testing the Chrome extension

1. `pnpm build:extension` (or `pnpm dev:extension` to rebuild on change).
2. Open `chrome://extensions`, enable **Developer mode** and choose **Load unpacked**.
3. Select `apps/chrome-extension/dist`. Chrome 116 or newer is required.
4. Pin Folio and click its icon (or press Alt+Shift+F):
   - **Open a PDF** opens the editor tab: choose or drop files there.
   - **Open side panel** inspects a PDF next to the current page; **Open in editor** hands it over.
   - **Settings** (the gear) holds the theme, activity privacy and permission explanations.

In development, click the reload icon on `chrome://extensions` after each rebuild. Editor-page
shortcuts avoid keys Chrome reserves. Shortcuts without Ctrl/⌘ (Alt+W, Alt+PageDown/PageUp) are
ignored while you type in a field:

| Action                   | Shortcut                           |
| ------------------------ | ---------------------------------- |
| Open                     | Ctrl/⌘+O                           |
| Download a copy          | Ctrl/⌘+Shift+S                     |
| Close document           | Alt+W                              |
| Next / previous document | Alt+PageDown / Alt+PageUp          |
| Sidebar                  | Ctrl/⌘+Alt+1                       |
| Properties panel         | Ctrl/⌘+Alt+2                       |
| Zoom in / out, actual    | Ctrl/⌘+= / Ctrl/⌘+- / Ctrl/⌘+0     |
| Go to page               | Ctrl/⌘+Alt+G                       |
| Find, next, previous     | Ctrl/⌘+F, Ctrl/⌘+G or F3, Shift+F3 |

Folio's find bar replaces Chrome's in the editor (Chrome's would only see the pages on screen).
Rotation uses the toolbar buttons: Chrome keeps Ctrl+R and Ctrl+L. **Download a copy** saves the
original file through Chrome's downloads, which needs no extra permission.

The extension requests only `storage` and `sidePanel`. Features that read PDFs from web pages
(Phase 5) will ask for access when first used.

## Packaging releases

### CI

`.github/workflows/ci.yml` runs on every push:

- Formatting, lint, types, unit tests and Playwright.
- The extension zip.
- On Linux: Rust fmt, clippy and tests, the `.deb`, and the native tauri-driver e2e test.

`.github/workflows/desktop.yml` builds installers on real macOS and Windows runners:

- **macOS:** a universal (Apple Silicon + Intel) `.dmg`.
- **Windows:** `.msi` and NSIS `.exe`.

It runs on `main`, `v*` tags, pull requests and manual dispatch. On other branches, include
`[desktop]` in the commit message. Each push builds in its own run, so no push is skipped (a
push of several commits builds its latest commit); on pull requests a new commit cancels the older run. Besides the installers it runs
`cargo test`, which compiles the macOS and Windows code paths. No job opens a native dialog, drops
a file or uses a menu, so those are not verified yet. macOS runners are billed at a higher rate on
private repositories.

### macOS (on a Mac)

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm build:desktop:macos
```

The DMG lands in `target/universal-apple-darwin/release/bundle/dmg/`. Without credentials the app
is **ad-hoc signed** (`signingIdentity: "-"`): it runs on the build machine, but Gatekeeper blocks
it elsewhere. Right-click → **Open**, or remove the quarantine attribute, to test it.

### Windows (on Windows)

```sh
pnpm build:desktop:windows
```

This produces `target/release/bundle/msi/*.msi` and `target/release/bundle/nsis/*-setup.exe`.
The NSIS installer installs per user. Unsigned installers trigger SmartScreen warnings.

## Code signing and notarization

Distribution builds need credentials that are **not** in this repository:

| Platform               | You need                                                                                          | How Tauri uses it                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| macOS signing          | Apple Developer Program membership; a **Developer ID Application** certificate exported as `.p12` | Set `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY`, or set `bundle.macOS.signingIdentity` |
| macOS notarization     | An App Store Connect API key (or Apple ID + app-specific password)                                | `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` (or `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)                            |
| Windows signing        | An Authenticode code-signing certificate (OV/EV, or Azure Trusted Signing)                        | `bundle.windows.certificateThumbprint` for a certificate in the store, or `bundle.windows.signCommand` for cloud/HSM signing            |
| Auto-updates (Phase 7) | A Tauri updater key pair                                                                          | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; public key in the updater config                                     |
| Chrome Web Store       | A Chrome Web Store developer account                                                              | Upload `folio-chrome-<version>.zip`                                                                                                     |

Add these as GitHub Actions secrets and expose them as environment variables in the desktop
workflow's build step to produce signed releases. Never commit them.

## Privacy

- Documents are read and rendered locally (PDF.js runs in a worker inside the app).
- No analytics and no remote services. The CSPs of the desktop app and of the extension's pages
  allow no remote code or connections: scripts, requests, images, styles and fonts can only come
  from Folio itself.
- A PDF handed from the side panel to the editor passes through the extension's IndexedDB as a
  single-use record: the editor deletes it when it reads it, a record older than 10 minutes is
  ignored, and expired records are purged on every hand-off written or read, when the browser
  starts and when the extension is installed or updated. If the editor cannot be opened, the side
  panel deletes the record and shows an error.
- The extension's activity list stores counts by default; file names only if you opt in.
- Passwords for encrypted PDFs are kept only in memory for the open document.

## Known limitations

See [IMPLEMENTATION_PLAN.md §7](IMPLEMENTATION_PLAN.md#7-known-limitations) and the
[capability matrix](PLATFORM_CAPABILITIES.md).

## Licenses of bundled components

Folio's own code and artwork are original. Bundled third-party components:

- PDF.js (Apache-2.0), including its OpenJPEG, JBIG2 and QCMS WASM decoders. Their license files
  ship in `pdfjs/wasm/`. PDF.js scripting is not used, so its QuickJS engine (`quickjs-eval.*`)
  is not shipped. The text layer styles in `packages/editor/src/viewer/viewer.css` are adapted
  from PDF.js' viewer stylesheet (Apache-2.0).
- React and Zustand (MIT), Radix UI (MIT), Lucide (ISC), Inter (OFL-1.1) and Tauri (MIT/Apache-2.0).
