import {
  createWebPlatformAdapter,
  WEB_FEATURES,
  type PlatformAdapter,
  type RuntimeFeatures,
} from '@folio/platform-adapters';
import { createChromeStorage } from '../shared/chrome-storage';

/** What the extension supports today. Checked against the capability matrix in tests. */
export const CHROME_FEATURES: RuntimeFeatures = {
  ...WEB_FEATURES,
  webDragAndDrop: true,
  clipboardWrite: true,
};

export function createChromePlatformAdapter(): PlatformAdapter & {
  deliverFiles: ReturnType<typeof createWebPlatformAdapter>['deliverFiles'];
} {
  return createWebPlatformAdapter({
    platform: 'chrome-extension',
    features: CHROME_FEATURES,
    storage: createChromeStorage(),
  });
}
