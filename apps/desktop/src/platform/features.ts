import type { RuntimeFeatures } from '@folio/platform-adapters';

/** What the desktop build supports. Checked against the capability matrix in tests. */
export const TAURI_FEATURES: RuntimeFeatures = {
  nativeFileDialogs: true,
  webDragAndDrop: false,
  nativeDragAndDrop: true,
  fileAssociations: true,
  nativeMenus: true,
  saveInPlace: false,
  saveCopy: true,
  printing: false,
  crashRecovery: false,
  recentFiles: false,
  openFromUrl: false,
  clipboardWrite: true,
  browserTabIntegration: false,
  nativeMessaging: false,
};
