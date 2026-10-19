# Folio privacy policy

_Applies to the Folio Chrome extension and the Folio desktop apps for macOS and Windows._

Folio is a PDF editor that works on your device. It has no servers, no accounts and no
analytics. The developer receives no information about you or your documents.

## What stays on your device

- **Documents** you open are read, displayed and edited inside the extension or the app. Text
  recognition (OCR) also runs on your device.
- **Unsaved changes** are kept on your device so they can be restored after a crash, and deleted
  when you save, close or discard the document.
- **Settings**, the optional activity list (counts by default, file names only if you turn that
  on), remembered signatures (only if you choose "Remember on this device") and recently opened
  files are stored on your device.
- **Passwords** of protected PDFs are kept in memory only, while the document is open.

## When Folio connects to the internet

Folio connects only when you ask it to:

- **Opening a PDF from the web (extension):** Folio downloads the PDF from the site you chose,
  after you allow access to that site, without cookies unless you agree for that request.
- **Ask Claude (optional, off by default):** if you turn it on with your own Anthropic API key,
  then each time you ask a question Folio sends the text of the pages you chose and your question
  to Anthropic's API, which produces the answer. Anthropic's commercial terms and privacy policy
  apply to that data (https://www.anthropic.com/legal/privacy). Your API key is stored on your
  device (the macOS Keychain, the Windows Credential Manager, or the extension's local storage) and
  sent only to Anthropic. You can turn the feature off and forget the key at any time.
- **Checking for updates (desktop, optional):** when you choose Check for Updates or turn on
  automatic checks, the app downloads the release feed from GitHub. It sends nothing about you or
  your documents.

## Sharing

Folio does not sell, share or transfer your data. Data sent to Anthropic through Ask Claude goes
directly from your device to Anthropic under your own account.

## Contact

Open an issue in the project's repository.
