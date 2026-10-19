# Chrome Web Store listing

Material for the Chrome Web Store Developer Dashboard. Submitting needs the owner's developer
account; nothing here is submitted automatically. Package the extension with
`pnpm --filter @folio/chrome-extension package` (it leaves out the development `key`).

After the store assigns an ID, replace the development ID in `OFFICIAL_EXTENSION_IDS`
(`apps/desktop/src-tauri/src/native_messaging.rs`) and in the README's host manifest example, so
the desktop app answers the published extension.

## Store listing tab

**Name:** Folio — PDF tools

**Summary (132 characters max):**
Read, fill, sign and edit PDFs in Chrome. Documents are processed on your device and only leave it if you ask Claude.

**Category:** Workflow & Planning (alternative: Tools)

**Language:** English

**Description:**

> Folio is a PDF editor that works on your device. Open a PDF from your computer, the current tab
> or a web address, and:
>
> - Read it quickly, even with thousands of pages: thumbnails, bookmarks, zoom and search with
>   highlights.
> - Highlight, underline and strike through text; add notes, drawings, shapes, text boxes and
>   images.
> - Fill in PDF forms and add your signature (drawn, typed or from a picture).
> - Add page numbers and watermarks; rotate, reorder, insert, delete, extract and split pages.
> - Make scanned pages searchable with on-device text recognition (English, Indonesian and
>   Chinese).
> - Export pages as images or text, reduce the file size, and save copies with or without a
>   password.
> - Print, and download the edited PDF. Unsaved changes are kept if the browser closes.
> - Optional: ask Claude to summarize a document or answer questions about it, with your own
>   Anthropic API key. Off unless you turn it on.
>
> Privacy: Folio has no servers and no analytics. PDFs are opened and edited inside your browser.
> Folio downloads a PDF only from a site you allow, when you ask it to. If you turn on Ask Claude,
> the text of the pages you choose and your questions are sent to Anthropic when you ask; nothing
> else ever leaves your device.
>
> Folio also has desktop apps for macOS and Windows; the extension can hand a document to them.

**Graphic assets:** the 128×128 icon is `apps/chrome-extension/public/icons/icon-128.png`;
1280×800 screenshots are in `screenshots/` (regenerate them with
`node docs/web-store/screenshots.mjs` after `pnpm build:extension`). A 440×280 promo tile is
optional and not made yet.

## Privacy practices tab

**Single purpose:** View and edit PDF documents in the browser.

**Permission justifications:**

| Permission                   | Justification                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                    | Saves the user's settings, an optional short activity list, the Ask Claude API key if the user enters one, and unsaved changes for crash recovery, in this browser profile only.                                                                   |
| `sidePanel`                  | Shows Folio's PDF tools in Chrome's side panel next to the page the user is reading.                                                                                                                                                               |
| `activeTab`                  | When the user clicks Folio's toolbar button, lets Folio read that tab's address to open the PDF it shows, list the PDFs it links to, or print it as PDF. Nothing runs on other tabs or without the click.                                          |
| `scripting`                  | Used only on the tab the user clicked Folio on: to find PDF links on it and to open its print dialog for "Save page as PDF".                                                                                                                       |
| `downloads` (optional)       | Saves a PDF linked from a page to the Downloads folder when the user chooses Download. Requested on first use.                                                                                                                                     |
| `nativeMessaging` (optional) | Hands a document to the Folio desktop app when the user chooses "Open in Folio for desktop"; the app asks before opening it. Requested on first use.                                                                                               |
| Host permissions (optional)  | `https://*/*` and `http://*/*` are optional and requested one site at a time when the user opens a PDF from that site, to download it. `https://api.anthropic.com/*` is requested only when the user turns on Ask Claude, to send their questions. |
| Remote code                  | No. All code, fonts, the PDF engine and the OCR engine and its language data are bundled in the package.                                                                                                                                           |

**Data usage disclosures:**

- Personally identifiable information, health, financial, authentication, personal
  communications, location, web history, user activity: **not collected**.
- Website content: **only with Ask Claude**, which the user turns on. When the user asks a
  question, the text of the chosen pages of the open PDF and the question are sent to Anthropic's
  API with the user's own API key, to produce the answer. This is not sent to the developer.
- Authentication information: the user's Anthropic API key, entered by the user for Ask Claude,
  is stored in the extension's local storage and sent only to `api.anthropic.com`.

Certify: the data is not sold to third parties; not used or transferred for purposes unrelated to
the item's single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** host [`privacy-policy.md`](privacy-policy.md) at a public URL (for example
GitHub Pages or the published repository) and enter that URL.
