import type { RuntimeFeatures } from '@folio/platform-adapters';

/** What the desktop build supports. Checked against the capability matrix in tests. */
export const TAURI_FEATURES: RuntimeFeatures = {
  nativeFileDialogs: true,
  webDragAndDrop: false,
  nativeDragAndDrop: true,
  fileAssociations: true,
  nativeMenus: true,
  saveInPlace: true,
  saveCopy: true,
  printing: true,
  crashRecovery: true,
  recentFiles: true,
  openFromUrl: false,
  clipboardWrite: true,
  browserTabIntegration: false,
  nativeMessaging: true,
  aiAssistant: true,
};
