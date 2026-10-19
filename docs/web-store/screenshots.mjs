/**
 * Takes the Chrome Web Store screenshots (1280×800) from the built extension:
 *   pnpm build:extension && node docs/web-store/screenshots.mjs
 * They show test fixtures only, never real documents.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const extension = join(root, 'apps', 'chrome-extension', 'dist');
const fixture = (name) => join(root, 'tests', 'fixtures', name);
const out = join(import.meta.dirname, 'screenshots');
mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 1280, height: 800 },
  colorScheme: 'light',
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const editor = `chrome-extension://${new URL(worker.url()).host}/editor.html`;
  const page = await context.newPage();

  const open = async (name) => {
    await page.goto(editor);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Choose PDF/ }).click();
    await (await chooser).setFiles(fixture(name));
    await page
      .locator('[data-page="1"] [data-testid="page-canvas"][data-render-state="done"]')
      .waitFor();
  };

  // 1. A form filled in on the page.
  await open('form-fields.pdf');
  await page.getByRole('textbox', { name: 'Full name' }).fill('Ada Lovelace');
  await page.getByRole('textbox', { name: 'notes' }).fill('Works on the Analytical Engine.');
  await page.getByRole('checkbox', { name: 'agree' }).click();
  await page.getByRole('radio', { name: 'M', exact: true }).click();
  // Leave the fields so the page draws their values.
  await page.getByRole('region', { name: 'Page view' }).focus();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, '1-forms.png') });

  // 2. Searching a document with bookmarks.
  await open('outline-and-text.pdf');
  await page.keyboard.press('ControlOrMeta+F');
  await page.keyboard.type('fox');
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, '2-search.png') });

  // 3. The Tools menu.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, '3-tools.png') });
  console.log(`Screenshots written to ${out}`);
} finally {
  await context.close();
}
