/** Every permission Folio requests at install, and why. A test keeps this in sync with manifest.json. */
export const PERMISSION_EXPLANATIONS: Record<string, string> = {
  storage: 'Saves your settings and, if enabled, a short activity list in this browser profile.',
  sidePanel: 'Shows Folio in Chrome’s side panel next to the page you are reading.',
  activeTab:
    'When you click Folio’s toolbar button, lets Folio see that tab’s address and, if you ask, list the PDFs it links to or open Chrome’s print dialog for it. Nothing happens on other tabs or without your click.',
  scripting:
    'Used only with the tab you clicked Folio on: to find PDF links on it and to open its print dialog for “Save page as PDF”.',
};

/** Permissions Folio asks for only when a feature first needs them. */
export const OPTIONAL_PERMISSION_EXPLANATIONS: Record<string, string> = {
  downloads: 'Saves a PDF from a web page to your Downloads folder when you choose Download.',
  nativeMessaging:
    'Hands a document to the Folio desktop app when you choose to open it there. The app asks you before it opens anything.',
};

/** Why Folio asks to read a site, shown next to the sites it may read. */
export const HOST_ACCESS_EXPLANATION =
  'Folio asks to read a site only when you open a PDF from it, and uses that access only to download PDFs you choose. You can remove access here at any time.';
