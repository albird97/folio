# Folio

Folio is a local-first PDF suite for **macOS**, **Windows** and **Google Chrome**. It is one
product: the document model, PDF engine, design system and workspace UI are shared, and each
target adds a thin platform adapter.

> **Status: Phase 1 (Foundation) complete.** Folio opens PDFs on all three targets:
>
> - Ways to open: file picker, drag and drop, launch arguments and Finder events on desktop, and a
>   side-panel hand-off in Chrome.
> - Password-protected files can be unlocked.
> - Viewing: multiple documents in tabs, a pages list, a page preview and full document properties,
>   in light and dark themes with keyboard shortcuts.
>
> Viewing tools, editing, saving and the advanced tools follow in later phases. See
> [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the roadmap and
> [PLATFORM_CAPABILITIES.md](PLATFORM_CAPABILITIES.md) for the support matrix.

Documents are processed on your device. Folio makes no network requests with document data, and
the extension has no access to the websites you visit.

## Repository layout

| Path                         | What it is                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `apps/desktop`               | Tauri 2 app: React UI (`src/`), Rust commands, menus and packaging (`src-tauri/`) |
| `apps/chrome-extension`      | Manifest V3 extension: popup, side panel, editor page, options, service worker    |
| `packages/document-model`    | Document types, IDs, operations, undo/redo history, recovery snapshots            |
| `packages/pdf-core`          | PDF.js engine wrapper, error classification, bundled PDF.js assets                |
| `packages/platform-adapters` | Platform adapter contract, web/memory adapters, capability matrix                 |
| `packages/shared-ui`         | Design tokens, Tailwind theme, accessible primitives, brand mark                  |
| `packages/editor`            | The shared workspace (tabs, toolbar, panels, canvas) and its stores               |
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
   them on the command line (`target/release/folio-desktop file.pdf`).

**Shortcuts:**

| Action                   | macOS        | Windows / Linux           |
| ------------------------ | ------------ | ------------------------- |
| Open                     | ⌘O           | Ctrl+O                    |
| Close document           | ⌘W           | Ctrl+W                    |
| Next / previous document | ⌃Tab / ⌃⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Pages panel              | ⌘⌥1          | Ctrl+Alt+1                |
| Properties panel         | ⌘⌥2          | Ctrl+Alt+2                |

Folio never writes to the files you open in Phase 1. The webview cannot read arbitrary files:
only files you chose are reachable, through tokens issued by the Rust layer.

## Installing and testing the Chrome extension

1. `pnpm build:extension` (or `pnpm dev:extension` to rebuild on change).
2. Open `chrome://extensions`, enable **Developer mode** and choose **Load unpacked**.
3. Select `apps/chrome-extension/dist`. Chrome 116 or newer is required.
4. Pin Folio and click its icon (or press Alt+Shift+F):
   - **Open a PDF** opens the editor tab: choose or drop files there.
   - **Open side panel** inspects a PDF next to the current page; **Open in editor** hands it over.
   - **Settings** (the gear) holds the theme, activity privacy and permission explanations.

In development, click the reload icon on `chrome://extensions` after each rebuild. Editor-page
shortcuts avoid keys Chrome reserves:

| Action                   | Shortcut                  |
| ------------------------ | ------------------------- |
| Open                     | Ctrl/⌘+O                  |
| Close document           | Alt+W                     |
| Next / previous document | Alt+PageDown / Alt+PageUp |
| Pages panel              | Ctrl/⌘+Alt+1              |
| Properties panel         | Ctrl/⌘+Alt+2              |

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
`[desktop]` in the commit message. macOS runners are billed at a higher rate on private
repositories.

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
- No analytics and no remote services. The CSPs allow no remote code or connections.
- The extension's activity list stores counts by default; file names only if you opt in.
- Passwords for encrypted PDFs are kept only in memory for the open document.

## Known limitations

See [IMPLEMENTATION_PLAN.md §7](IMPLEMENTATION_PLAN.md#7-known-limitations) and the
[capability matrix](PLATFORM_CAPABILITIES.md).

## Licenses of bundled components

Folio's own code and artwork are original. Bundled third-party components:

- PDF.js (Apache-2.0), including its OpenJPEG, JBIG2 and QCMS WASM decoders. Their license files
  ship in `pdfjs/wasm/`.
- React and Zustand (MIT), Radix UI (MIT), Lucide (ISC), Inter (OFL-1.1) and Tauri (MIT/Apache-2.0).
