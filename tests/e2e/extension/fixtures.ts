import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { join } from 'node:path';

const EXTENSION = join(import.meta.dirname, '..', '..', '..', 'apps', 'chrome-extension', 'dist');

interface ExtensionFixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  extensionUrl: (path: string) => string;
}

/** Loads the unpacked extension into a fresh Chromium profile for every test. */
export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
  extensionUrl: async ({ extensionId }, use) => {
    await use((path) => `chrome-extension://${extensionId}/${path}`);
  },
});

export { expect } from '@playwright/test';
