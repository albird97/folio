/**
 * Takes the README's feature screenshots from the desktop UI (web adapter):
 *   pnpm build:desktop:web && node docs/screenshots/take.mjs
 * They show test fixtures only, never real documents.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const fixture = (name) => join(root, 'tests', 'fixtures', name);
const out = (name) => join(import.meta.dirname, `${name}.png`);
const PORT = 4190;

const server = spawn(
  'pnpm',
  ['--filter', '@folio/desktop', 'exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  for (let tries = 0; ; tries += 1) {
    try {
      await page.goto(`http://localhost:${PORT}`);
      break;
    } catch {
      if (tries > 150) throw new Error('The preview server did not start.');
      await page.waitForTimeout(200);
    }
  }
  const shot = (name) => page.screenshot({ path: out(name) });
  const rendered = () =>
    page
      .locator('[data-page="1"] [data-testid="page-canvas"][data-render-state="done"]')
      .first()
      .waitFor();
  const open = async (...names) => {
    await page.goto(`http://localhost:${PORT}`);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Choose PDF/ }).click();
    await (await chooser).setFiles(names.map(fixture));
    await rendered();
  };
  const tool = async (label) => {
    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: label }).click();
  };
  const settle = () => page.waitForTimeout(900);

  // Forms.
  await open('form-fields.pdf');
  await page.getByRole('textbox', { name: 'Full name' }).fill('Ada Lovelace');
  await page.getByRole('textbox', { name: 'notes' }).fill('Works on the Analytical Engine.');
  await page.getByRole('checkbox', { name: 'agree' }).click();
  await page.getByRole('radio', { name: 'M', exact: true }).click();
  await page.locator('[data-page-view]').first().focus();
  await settle();
  await shot('forms');

  // Signatures.
  await open('basic-3-pages.pdf');
  await tool('Add a signature…');
  await page.getByRole('tab', { name: 'Type' }).click();
  await page.getByRole('textbox', { name: 'Your name' }).fill('Ada Lovelace');
  await settle();
  await shot('signature');
  await page.getByRole('button', { name: 'Place on page' }).click();
  await page
    .locator('[data-signature-layer="1"]')
    .first()
    .click({ position: { x: 420, y: 520 } });
  await settle();
  await shot('signature-placed');

  // Page numbers and a watermark.
  await tool('Page numbers…');
  await page.getByRole('button', { name: 'Apply' }).click();
  await tool('Watermark…');
  await page.getByRole('textbox', { name: /Text/ }).first().fill('DRAFT');
  await page.getByRole('button', { name: 'Apply' }).click();
  await settle();
  await shot('stamps');

  // OCR.
  await open('scanned-pages.pdf');
  await tool('Recognize text (OCR)…');
  await page.getByRole('button', { name: 'Recognize text' }).click();
  await page.getByRole('button', { name: 'Done' }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('ControlOrMeta+F');
  await page.getByRole('searchbox').first().fill('lighthouse');
  await page.keyboard.press('Enter');
  await settle();
  await shot('ocr');

  // Split view.
  await open('basic-3-pages.pdf', 'outline-and-text.pdf');
  await page.getByRole('button', { name: /two documents side by side/i }).click();
  // More room for the two documents.
  await page.getByRole('button', { name: 'Properties panel', exact: true }).click();
  await settle();
  await shot('split-view');

  await page.getByRole('button', { name: 'Properties panel', exact: true }).click();
  await page.getByRole('button', { name: /two documents side by side/i }).click();

  // The Tools menu.
  await page.getByRole('button', { name: 'Tools' }).click();
  await settle();
  await shot('tools');
  await page.keyboard.press('Escape');

  // Password protection.
  await tool('Password protection…');
  await settle();
  await shot('protect');
  await page.keyboard.press('Escape');

  // Ask Claude (setup; nothing is sent).
  await tool('Ask Claude about this document…');
  await settle();
  await shot('ask-claude');
  console.log('Screenshots written to docs/screenshots/');
} finally {
  await browser.close();
  server.kill();
}
