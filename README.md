# Folio

[![CI](https://github.com/albird97/folio/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/albird97/folio/actions/workflows/ci.yml)
[![Desktop installers](https://github.com/albird97/folio/actions/workflows/desktop.yml/badge.svg?branch=main)](https://github.com/albird97/folio/actions/workflows/desktop.yml)

Folio is a local-first PDF suite for **macOS**, **Windows** and **Google Chrome**. It is one
product: the document model, PDF engine, design system and workspace UI are shared, and each
target adds a thin platform adapter.

> **Status: Phase 5 (Chrome integration) complete.** Folio opens, reads, edits, saves and prints
> PDFs on all three targets, and the Chrome extension and the desktop app work together:
>
> - **Opening:** file picker, drag and drop, recent files, launch arguments and Finder events on
>   desktop (one running app), and in Chrome: a web address, the PDF in the current tab, the PDFs
>   a page links to, and a side-panel hand-off. Password-protected files can be unlocked.
> - **Viewing:** a continuous, virtualized page viewer that stays fast with thousands of pages:
>   thumbnails, bookmarks, page navigation, zoom (fit width, fit page, presets, Ctrl+wheel and
>   pinch), view rotation, text selection and copying, and whole-document search with highlights.
>   Filled-in form fields show their values.
> - **Editing:** highlight, underline and strike through text, notes, freehand drawing, shapes,
>   added text and images, with a Comments list and an inspector; copy, cut and paste of comments
>   and pasting images. Pages can be reordered, rotated, duplicated, deleted, inserted, extracted
>   and split. Document properties are editable. Everything is undoable.
> - **Saving:** **Save** writes changes back to the opened file on desktop (atomically, and never
>   over a file another program changed without asking); **Save as** writes a new file (a save
>   dialog on desktop, a download in Chrome) with comments editable or flattened. Folio never
>   overwrites the files you open on its own.
> - **Printing** of all, current or chosen pages, with or without comments.
> - **Crash recovery:** unsaved changes are kept on the device and offered again after a crash.
> - **Chrome tools:** the side panel rotates and extracts pages, turns pages into images and
>   extracts text; the popup saves the current page as PDF through Chrome's print dialog; any
>   document can be handed to the desktop app (native messaging), which asks before opening it.
> - On macOS and Windows, the native integrations (dialogs, Save, printing, menus, recent files,
>   recovery, single instance, native messaging) are built in CI and tested on Linux, but **not
>   yet verified on a real Mac or Windows PC**.
>
> See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the roadmap and
> [PLATFORM_CAPABILITIES.md](PLATFORM_CAPABILITIES.md) for the support matrix.

Documents are processed on your device and never uploaded. The desktop app makes no network
requests at all; the extension downloads a PDF only from a site you allow, when you ask it to.

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

| Task                                                 | Command                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Desktop app, development (native window, hot reload) | `pnpm dev:desktop`                                                                              |
| Desktop UI in a normal browser (web adapter)         | `pnpm dev:desktop:web` → http://localhost:1420                                                  |
| Build macOS app + DMG (universal, on macOS)          | `pnpm build:desktop:macos`                                                                      |
| Build Windows MSI + NSIS installer (on Windows)      | `pnpm build:desktop:windows`                                                                    |
| Build Linux .deb (on Linux)                          | `pnpm build:desktop:linux`                                                                      |
| Build for the current platform, all bundle types     | `pnpm build:desktop`                                                                            |
| Extension, development (rebuilds on change)          | `pnpm dev:extension`                                                                            |
| Extension, production build                          | `pnpm build:extension` → `apps/chrome-extension/dist`                                           |
| Extension, Web Store zip                             | `pnpm --filter @folio/chrome-extension package`                                                 |
| Unit tests (all packages and apps)                   | `pnpm test`                                                                                     |
| E2E: extension + desktop UI (build both first)       | `pnpm build:extension && pnpm build:desktop:web && pnpm test:e2e`                               |
| E2E: real desktop binary (verified on Linux)         | `pnpm build:desktop:linux && xvfb-run -a pnpm test:e2e:desktop`                                 |
| E2E: extension → desktop host (native messaging)     | `cargo build -p folio-desktop && pnpm exec playwright test tests/e2e/extension/desktop.spec.ts` |
| Rust tests / lint                                    | `pnpm test:rust` / `pnpm lint:rust`                                                             |
| Type checking, lint, formatting                      | `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                              |
| Everything quick (format, lint, types, unit)         | `pnpm check`                                                                                    |
| Regenerate PLATFORM_CAPABILITIES.md                  | `pnpm capabilities:generate`                                                                    |
| Regenerate PDF fixtures (needs qpdf)                 | `pnpm fixtures:generate`                                                                        |

Release builds bundle the web UI and need neither Node.js nor Rust on the user's machine.
Installers appear under `target/release/bundle/` (or `target/universal-apple-darwin/release/bundle/` on macOS).

## Running the desktop app

1. `pnpm dev:desktop` starts Vite on port 1420 and opens Folio in a native window.
2. Open PDFs with **File → Open…** (⌘O / Ctrl+O), **File → Open Recent**, the recent files on
   the start screen, by dropping them onto the window, or by passing them on the command line
   (`target/release/folio-desktop file.pdf`). Opening a file while Folio runs hands it to the
   running window. Nothing is dropped silently: files that are not PDFs are reported, and a file
   that was moved or deleted before Folio could open it gets an error tab.
3. Scroll through the pages, or use the sidebar (thumbnails, bookmarks and search results), the
   page number field and the zoom menu in the toolbar.
4. **Save** (⌘S / Ctrl+S) writes your changes back to the file; **Print** (⌘P / Ctrl+P) asks
   which pages and whether to include comments, then opens the system print dialog. Closing the
   window with unsaved changes asks first. The window's size and position are remembered.

**Shortcuts:**

| Action                   | macOS               | Windows / Linux                       |
| ------------------------ | ------------------- | ------------------------------------- |
| Open                     | ⌘O                  | Ctrl+O                                |
| Save                     | ⌘S                  | Ctrl+S                                |
| Save as                  | ⇧⌘S                 | Ctrl+Shift+S                          |
| Save a copy of original  | ⌥⌘S                 | Ctrl+Alt+S                            |
| Print                    | ⌘P                  | Ctrl+P                                |
| Copy / cut / paste       | ⌘C / ⌘X / ⌘V        | Ctrl+C / Ctrl+X / Ctrl+V              |
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

Single keys pick a drawing tool while the pages have focus: V Select, H Highlight, U Underline,
K Strikethrough, N Note, P Draw, R Rectangle, O Ellipse, L Line, A Arrow, T Add text, I Add image.

In the page view, arrow keys, Page Up/Down and Space scroll, ← and → turn pages when the page
fits the window's width, and Home/End go to the first and last page. Ctrl+wheel and trackpad or
touch pinches zoom around the pointer. Fit width and Fit page are in
the zoom menu and the **View** menu. Rotation only changes the view; the file is not modified.

The macOS menus are Folio, File, Edit, View, Pages and Window. ⌘W closes the current document, so
**Window → Close Window** uses ⇧⌘W. Windows and Linux have File, Edit, View, Pages and
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
- **Clipboard:** with the pages focused, ⌘C/⌘X/⌘V (Ctrl+C/X/V) copy, cut and paste the selected
  comments, also into another open document; an image on the clipboard is pasted as an added
  image. Selected page text is copied as usual.

Folio never overwrites the files you open on its own. **Save** (⌘S / Ctrl+S) writes your changes
back to the file you opened (or last saved as) when you choose it: through a temporary file and an
atomic replace, so an interrupted save never leaves a half-written file. If another program
changed the file since Folio read it, Folio asks whether to replace it or save elsewhere; files
that cannot be written (read-only, moved) fall back to **Save as**. If the operating system lets
Folio move the old version aside but not put the new one in place, Folio puts the old version
back; should even that fail, it keeps the old version next to the file and says where. **Save as** (⇧⌘S /
Ctrl+Shift+S) writes the edited document to a new file you choose, and later saves go there; its
menu also offers a copy with comments flattened into the pages, and **Save a copy of the
original**, which writes the opened file unchanged. The Rust layer accepts only PDF data. The
webview never sees paths: files are reachable only through tokens issued by the Rust layer. Closing
a document or the window with unsaved changes asks first.

### Crash recovery and Folio's data folder

Two seconds after each change, unsaved documents are written to Folio's data folder (the document
state, the original files and added images). If Folio closes without saving, it offers the
documents again when it starts: **Restore** or **Discard**. Saving, closing a document or
discarding it deletes its recovery data; nothing is kept for documents without unsaved changes.
Passwords are never stored, so protected documents ask for theirs again.

The data folder is `~/Library/Application Support/io.github.albird97.folio` on macOS,
`%LOCALAPPDATA%\io.github.albird97.folio` on Windows and `~/.local/share/io.github.albird97.folio`
on Linux. It holds recovery data, the recent files list, documents waiting to be accepted from
Chrome (deleted when declined or after 24 hours) and, on Windows, the Chrome registration. Folio
creates it so that only your user can open it, and never opens files inside it as documents
(documents from Chrome only open through their prompt). While Folio runs it holds a lock there,
so a second copy started by accident does not clean up anything the first one still uses.
`FOLIO_DATA_DIR` moves the folder, and in debug builds `FOLIO_NATIVE_HOST_NO_LAUNCH=1` keeps the
native messaging host from starting the app (both used by tests).

## Installing and testing the Chrome extension

1. `pnpm build:extension` (or `pnpm dev:extension` to rebuild on change).
2. Open `chrome://extensions`, enable **Developer mode** and choose **Load unpacked**.
3. Select `apps/chrome-extension/dist`. Chrome 116 or newer is required. The manifest carries a
   development key, so the extension always gets the ID `ghfckfnleaidabfhaplbnfknipajedan`
   (the one the desktop app accepts documents from).
4. Pin Folio and click its icon (or press Alt+Shift+F):
   - **Open a PDF** opens the editor tab: choose or drop files there, or use **Open from a web
     address…**.
   - **This tab**: **Open this PDF in Folio** (when the tab shows a PDF), **PDFs on this page**
     (opens the side panel with the PDFs the page links to, to open or download) and **Save page
     as PDF** (Chrome's print dialog; choose "Save as PDF").
   - **Open side panel**: inspect a PDF, hand it to the editor or the desktop app, and use its
     tools: rotate pages, extract pages, pages to PNG/JPEG (several as a ZIP) and extract text.
   - **Settings** (the gear): theme, activity privacy, permissions (with the sites Folio may read,
     each removable) and the desktop connection check.

In development, click the reload icon on `chrome://extensions` after each rebuild. Editor-page
shortcuts avoid keys Chrome reserves. Shortcuts without Ctrl/⌘ (Alt+W, Alt+PageDown/PageUp) are
ignored while you type in a field:

| Action                   | Shortcut                           |
| ------------------------ | ---------------------------------- |
| Open                     | Ctrl/⌘+O                           |
| Download PDF (edited)    | Ctrl/⌘+Shift+S                     |
| Download the original    | Ctrl/⌘+Alt+S                       |
| Print                    | Ctrl/⌘+P                           |
| Undo / redo              | Ctrl/⌘+Z / Ctrl/⌘+Shift+Z          |
| Close document           | Alt+W                              |
| Next / previous document | Alt+PageDown / Alt+PageUp          |
| Sidebar                  | Ctrl/⌘+Alt+1                       |
| Properties panel         | Ctrl/⌘+Alt+2                       |
| Zoom in / out, actual    | Ctrl/⌘+= / Ctrl/⌘+- / Ctrl/⌘+0     |
| Go to page               | Ctrl/⌘+Alt+G                       |
| Find, next, previous     | Ctrl/⌘+F, Ctrl/⌘+G or F3, Shift+F3 |

Folio's find bar replaces Chrome's in the editor (Chrome's would only see the pages on screen).
Rotation uses the toolbar buttons: Chrome keeps Ctrl+R and Ctrl+L. Downloads go through Chrome's
downloads and need no extra permission. Unsaved changes in the editor are kept in the extension's
storage and offered again when the editor opens, unless another editor tab still has them open.

**Permissions.** At install the extension asks only for `storage`, `sidePanel`, `activeTab` and
`scripting`, none of which shows a warning; `activeTab` and `scripting` only apply to a tab after
you click Folio's toolbar button on it. Everything else is asked for when first used:

- **Site access** (`https://*/*`, `http://*/*` as optional host permissions): Chrome asks for one
  site at a time when you open a PDF from it. Downloads run in the service worker, without
  cookies or a referrer; if a site answers with a sign-in page, Folio asks before trying again
  with your browser's sign-in for that one request. The extension's pages cannot connect to any
  server (their CSP allows only the extension itself).
- **`downloads`**: to save PDFs linked from a page with Chrome's downloads.
- **`nativeMessaging`**: to hand documents to the desktop app.

Chrome does not let extensions read PDFs opened from your computer (`file://` tabs) or run
scripts on its own pages and the Web Store; Folio says so where that matters.

## Connecting Chrome and the desktop app

The extension hands documents to the desktop app through Chrome native messaging. The host is the
Folio desktop binary itself, registered as `io.github.albird97.folio`.

1. Install Folio for desktop (move it to Applications on macOS first), open it, choose
   **File → Connect to Chrome…** and select **Connect**. The dialog defaults to **Cancel**, and
   only the app's own menu can connect: the app's web page cannot.
2. In Chrome, use **Open in Folio for desktop** in the editor's save menu or in the side panel.
   Chrome asks once for the `nativeMessaging` permission.
3. Folio for desktop asks before it opens the document. Declined documents are deleted.

If the app is missing or not connected, the extension explains how to connect it, and
**Settings → Folio for desktop → Check connection** tests the link. **Connect to Chrome…** refuses
to register a copy of Folio that others could replace: one running from the temporary folder, a
removable or RAM disk, a folder others can write to, or (on macOS) a translocated download. Move
Folio to Applications (macOS) or install it normally (Windows), then try again.

The host answers only the official extension ID, accepts only PDFs (up to 512 MB, at most three
waiting or arriving at a time, and only with enough free disk space, even when several Chrome
connections send at once), verifies their size and SHA-256 and spools them in the data folder
until you answer.

Where the registration lives (written by **Connect to Chrome…**, removed by its **Disconnect**):

| OS      | Native messaging host manifest                                                                                                                                                                      |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.github.albird97.folio.json` (and `…/Chromium/…`)                                                                               |
| Windows | `%LOCALAPPDATA%\io.github.albird97.folio\native-messaging\io.github.albird97.folio.json`, named by the default value of `HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio` |
| Linux   | `~/.config/google-chrome/NativeMessagingHosts/io.github.albird97.folio.json` (and `~/.config/chromium/…`)                                                                                           |

To register by hand (for example for a build you run from `target/`), create that file with:

```json
{
  "name": "io.github.albird97.folio",
  "description": "Folio desktop app: opens PDFs sent from the Folio Chrome extension.",
  "path": "/absolute/path/to/folio-desktop",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://ghfckfnleaidabfhaplbnfknipajedan/"]
}
```

On Windows, also set the registry key's default value to the manifest's path
(`reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\io.github.albird97.folio" /ve /t REG_SZ /d "<path to manifest>" /f`),
and use a `folio-desktop.exe` path with escaped backslashes in the JSON.

Before publishing the extension to the Chrome Web Store, replace the development ID in
`OFFICIAL_EXTENSION_IDS` (`apps/desktop/src-tauri/src/native_messaging.rs`) with the ID the store
assigns, and register that ID in the host manifest. The Web Store zip
(`pnpm --filter @folio/chrome-extension package`) already leaves out the manifest's development
`key`. Until then, any unpacked extension that copies the public key gets the development ID
(transfers are still confirmed in the app).

## Packaging releases

### CI

`.github/workflows/ci.yml` runs on every push:

- Formatting, lint, types, unit tests and Playwright.
- The extension zip.
- On Linux: Rust fmt, clippy and tests, the `.deb`, the native tauri-driver e2e test, and the
  native messaging e2e test (the extension in Chromium sending documents to the desktop binary).

`.github/workflows/desktop.yml` builds installers on real macOS and Windows runners:

- **macOS:** a universal (Apple Silicon + Intel) `.dmg`.
- **Windows:** `.msi` and NSIS `.exe`.

It runs on `main`, `v*` tags, pull requests and manual dispatch. On other branches, include
`[desktop]` in the commit message. Each push builds in its own run, so no push is skipped (a
push of several commits builds its latest commit); on pull requests a new commit cancels the older run. Besides the installers it runs
`cargo test`, which compiles the macOS and Windows code paths. No job opens a native dialog, drops
a file, prints, uses a menu or talks to Chrome on macOS or Windows, so those are not verified yet. macOS runners are billed at a higher rate on
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

- Documents are read and rendered locally (PDF.js runs in a worker inside the app). Nothing is
  uploaded, and there are no analytics or remote services.
- The desktop app's CSP allows no remote code or connections. The extension's pages allow none
  either; only its service worker may reach web servers, and only to download a PDF you asked to
  open from a site you allowed, with no cookies (unless you agree for one request) and no
  referrer.
- Unsaved changes are kept on the device for crash recovery (the desktop data folder, or the
  extension's IndexedDB) and deleted when the document is saved, closed or discarded.
- A PDF handed from the side panel or popup to the editor passes through the extension's
  IndexedDB as a single-use record: the editor deletes it when it reads it, a record older than
  10 minutes is ignored, and expired records are purged on every hand-off, when the browser
  starts and when the extension is installed or updated. Web addresses handed to the editor go
  through session storage, not the tab's URL.
- Documents sent to the desktop app wait in its data folder until you open or decline them;
  declined, abandoned and day-old ones are deleted.
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
