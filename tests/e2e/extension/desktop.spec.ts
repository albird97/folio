import { PDFDocument } from '@cantoo/pdf-lib';
import { test as base, chromium, expect, type BrowserContext } from '@playwright/test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_ENV } from '../../../playwright.config';
import { chooseFiles, fixture, pageRendered } from '../helpers';

/**
 * Sending documents to the desktop app through Chrome native messaging, with
 * the real host: the Folio desktop binary, registered in the test profile
 * the way Folio registers itself for Chrome. The host spools documents
 * without starting the app (FOLIO_NATIVE_HOST_NO_LAUNCH). The extension is a
 * copy whose manifest grants nativeMessaging at install, because Chrome's
 * prompt for the optional permission cannot be automated.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const EXTENSION = join(ROOT, 'apps', 'chrome-extension', 'dist');
const EXTENSION_ID = 'ghfckfnleaidabfhaplbnfknipajedan';
const HOST_NAME = 'io.github.albird97.folio';

/** The desktop binary built by `cargo build` (debug or release), or FOLIO_DESKTOP_BIN. */
function hostBinary(): string | null {
  // A binary that was asked for must exist (CI), rather than the tests quietly skipping.
  const wanted = process.env.FOLIO_DESKTOP_BIN;
  if (wanted && !existsSync(wanted)) throw new Error(`FOLIO_DESKTOP_BIN does not exist: ${wanted}`);
  const candidates = [
    process.env.FOLIO_DESKTOP_BIN,
    join(ROOT, 'target', 'debug', 'folio-desktop'),
    join(ROOT, 'target', 'release', 'folio-desktop'),
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path))) ?? null;
}

interface DesktopFixtures {
  host: { registered: boolean };
  dataDir: string;
  context: BrowserContext;
  extensionUrl: (path: string) => string;
}

const test = base.extend<DesktopFixtures>({
  host: [{ registered: true }, { option: true }],
  dataDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'folio-data-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },
  context: async ({ host, dataDir }, use) => {
    const binary = hostBinary();
    const work = mkdtempSync(join(tmpdir(), 'folio-chrome-'));
    const profile = join(work, 'profile');
    const extension = join(work, 'extension');
    cpSync(EXTENSION, extension, { recursive: true });
    const manifestPath = join(extension, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.permissions = [...manifest.permissions, 'nativeMessaging'];
    manifest.optional_permissions = manifest.optional_permissions.filter(
      (permission: string) => permission !== 'nativeMessaging',
    );
    writeFileSync(manifestPath, JSON.stringify(manifest));
    if (host.registered && binary) {
      // Chrome looks for user-level hosts in the profile's NativeMessagingHosts folder.
      mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
      writeFileSync(
        join(profile, 'NativeMessagingHosts', `${HOST_NAME}.json`),
        JSON.stringify({
          name: HOST_NAME,
          description: 'Folio',
          path: binary,
          type: 'stdio',
          allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
        }),
      );
    }
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      viewport: { width: 1280, height: 800 },
      env: { ...BROWSER_ENV, FOLIO_DATA_DIR: dataDir, FOLIO_NATIVE_HOST_NO_LAUNCH: '1' },
    });
    await use(context);
    await context.close();
    rmSync(work, { recursive: true, force: true });
  },
  extensionUrl: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    expect(new URL(worker.url()).host).toBe(EXTENSION_ID);
    await use((path) => `chrome-extension://${EXTENSION_ID}/${path}`);
  },
});

/** Documents the host received: their stored bytes and recorded names. */
function spooled(dataDir: string) {
  const incoming = join(dataDir, 'incoming');
  if (!existsSync(incoming)) return [];
  return readdirSync(incoming)
    .map((id) => join(incoming, id))
    .filter((dir) => existsSync(join(dir, 'meta.json')))
    .map((dir) => ({
      meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as {
        name: string;
        size: number;
      },
      bytes: readFileSync(join(dir, 'document.pdf')),
    }));
}

test.describe('sending documents to the desktop app', () => {
  test.skip(!hostBinary(), 'Build the desktop binary first (cargo build -p folio-desktop).');

  test('the side panel hands the inspected PDF to the desktop host', async ({
    context,
    extensionUrl,
    dataDir,
  }) => {
    const page = await context.newPage();
    await page.goto(extensionUrl('sidepanel.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: 'Choose PDF…' }).click(), [
      'basic-3-pages.pdf',
    ]);
    await page.getByRole('button', { name: 'Open in Folio for desktop' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Sent.' })).toBeVisible();
    const [received] = spooled(dataDir);
    expect(received?.meta.name).toBe('basic-3-pages.pdf');
    expect(received?.bytes.equals(readFileSync(fixture('basic-3-pages.pdf')))).toBe(true);
  });

  test('the editor sends the document with its changes', async ({
    context,
    extensionUrl,
    dataDir,
  }) => {
    const page = await context.newPage();
    await page.goto(extensionUrl('editor.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    await page.getByRole('button', { name: 'Rotate page clockwise' }).click();
    await page.getByRole('button', { name: 'More ways to save' }).click();
    await page.getByRole('menuitem', { name: 'Open in Folio for desktop…' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Sent basic-3-pages.pdf' }),
    ).toBeVisible();
    const [received] = spooled(dataDir);
    const sent = await PDFDocument.load(received!.bytes);
    expect(sent.getPage(0).getRotation().angle).toBe(90);
  });

  test.describe('without the desktop app', () => {
    test.use({ host: { registered: false } });

    test('explains how to connect it', async ({ context, extensionUrl }) => {
      const page = await context.newPage();
      await page.goto(extensionUrl('sidepanel.html'));
      await chooseFiles(page, () => page.getByRole('button', { name: 'Choose PDF…' }).click(), [
        'basic-3-pages.pdf',
      ]);
      await page.getByRole('button', { name: 'Open in Folio for desktop' }).click();
      await expect(page.getByRole('alert')).toContainText('Folio for desktop is not connected');

      const editor = await context.newPage();
      await editor.goto(extensionUrl('editor.html'));
      await chooseFiles(editor, () => editor.getByRole('button', { name: /Choose PDF/ }).click(), [
        'basic-3-pages.pdf',
      ]);
      await pageRendered(editor);
      await editor.getByRole('button', { name: 'More ways to save' }).click();
      await editor.getByRole('menuitem', { name: 'Open in Folio for desktop…' }).click();
      await expect(
        editor.getByRole('dialog', { name: 'Folio for desktop is not connected' }),
      ).toContainText('Connect to Chrome…');
    });
  });
});
