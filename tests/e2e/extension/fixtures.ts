import { BROWSER_ENV } from '../../../playwright.config';
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fixture } from '../helpers';

const EXTENSION = join(import.meta.dirname, '..', '..', '..', 'apps', 'chrome-extension', 'dist');

interface ExtensionFixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  extensionUrl: (path: string) => string;
  pdfServer: PdfServer;
}

/** A local web server with PDFs to open from the web, recording each request. */
export interface PdfServer {
  url(path: string): string;
  requests: Array<{ path: string; headers: IncomingHttpHeaders }>;
}

/**
 * Routes of the test server. Answers allow any origin (CORS), the way a
 * public file host does, so the extension can read them without the site
 * permission the tests cannot grant through Chrome's prompt.
 */
function pdfRoutes(path: string): {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  const pdf = (name: string) => readFileSync(fixture(name));
  switch (path) {
    case '/files/basic-3-pages.pdf':
      return {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: pdf('basic-3-pages.pdf'),
      };
    case '/download?id=7':
      return {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename*=UTF-8''R%C3%A9sum%C3%A9.pdf`,
        },
        body: pdf('outline-and-text.pdf'),
      };
    case '/private/report.pdf':
      // A sign-in page instead of the file, as sites without a session do.
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Buffer.from(`<!doctype html><title>Sign in</title>${' '.repeat(2000)}`),
      };
    case '/notes.txt':
      return {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('x'.repeat(4000)),
      };
    default:
      return {
        status: 404,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from('Not found'),
      };
  }
}

/** Loads the unpacked extension into a fresh Chromium profile for every test. */
export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
      viewport: { width: 1280, height: 800 },
      env: BROWSER_ENV,
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
  pdfServer: async ({}, use) => {
    const requests: PdfServer['requests'] = [];
    const server = createServer((request, response) => {
      const path = request.url ?? '/';
      requests.push({ path, headers: request.headers });
      const { status, headers, body } = pdfRoutes(path);
      // CORS as a site the user can sign in to answers it (with real site
      // access, Chrome lets the extension read any answer).
      const origin = request.headers.origin;
      response.writeHead(status, {
        ...headers,
        'access-control-allow-origin': origin ?? '*',
        'access-control-allow-credentials': 'true',
        'access-control-expose-headers': 'content-disposition',
        vary: 'origin',
        'content-length': body.length,
      });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await use({ url: (path) => `http://127.0.0.1:${port}${path}`, requests });
    await new Promise((resolve) => server.close(resolve));
  },
});

/**
 * Replaces Chrome's permission prompts, which tests cannot click: every
 * request is allowed (or refused), and the downloads API is recorded. The
 * real APIs stay in place for everything else.
 */
export function stubPermissions(options: { allow: boolean }) {
  return `(() => {
    if (!globalThis.chrome?.permissions) return;
    const allow = ${JSON.stringify(options.allow)};
    globalThis.chrome.permissions.request = async () => allow;
    globalThis.chrome.permissions.contains = async () => allow;
    globalThis.folioDownloads = [];
    globalThis.chrome.downloads = {
      download: async (options) => { globalThis.folioDownloads.push(options); return 1; },
    };
  })();`;
}

export { expect } from '@playwright/test';
