import { PDFDocument } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, pageRendered, recoveryRecords } from '../helpers';

/**
 * Printing and crash recovery in the shared workspace (web adapter: Chromium's
 * print dialog and IndexedDB). The native print dialog cannot be automated, so
 * `window.print` is replaced and the print layout is printed to a PDF.
 */

async function open(page: Page, name: string) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [name]);
  await pageRendered(page);
}

const tool = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: 'Comment and drawing tools' }).getByRole('radio', { name });
const commentsTab = (page: Page) => page.getByRole('tab', { name: /^Comments/ });

/**
 * Adds a note at a fraction of page 1 (US Letter). Returns a point inside its
 * yellow icon, between the icon's lines, as fractions of the page.
 */
async function addNote(page: Page, fx: number, fy: number) {
  const box = (await page.locator('[data-page="1"]').boundingBox())!;
  await tool(page, 'Note').click();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.getByRole('textbox', { name: 'Note' }).fill('Printed note');
  await page.keyboard.press('Control+Enter');
  // The 20 pt icon hangs down and right from the click.
  return { x: fx + 10 / 612, y: fy + 8 / 792 };
}

/** Replaces the browser's print dialog; counts calls. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    const record = window as unknown as { printCalls: number };
    record.printCalls = 0;
    window.print = () => {
      record.printCalls += 1;
    };
  });
}

const printCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { printCalls: number }).printCalls);

/** The colour of a printed page image at a point given as fractions of the page. */
function printedPixel(page: Page, index: number, at: { x: number; y: number }) {
  return page.evaluate(
    async ({ index, at }) => {
      const image = document.querySelectorAll<HTMLImageElement>('#folio-print img')[index]!;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(
        Math.round(at.x * canvas.width),
        Math.round(at.y * canvas.height),
        1,
        1,
      ).data;
      return [data[0]!, data[1]!, data[2]!];
    },
    { index, at },
  );
}

async function print(page: Page, options: { pages?: string; comments?: boolean } = {}) {
  await page.getByRole('button', { name: 'Print…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Print' });
  if (options.pages)
    await dialog.getByRole('textbox', { name: 'Pages to print' }).fill(options.pages);
  if (options.comments === false) {
    await dialog.getByRole('checkbox', { name: 'Print comments and drawings' }).uncheck();
  }
  const calls = await printCalls(page);
  await dialog.getByRole('button', { name: 'Print…' }).click();
  await expect.poll(() => printCalls(page)).toBe(calls + 1);
}

/** Ends a print job as the browser does when its print dialog closes. */
async function finishPrinting(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#folio-print')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-folio-printing');
}

test.describe('printing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('prints chosen pages with or without comments', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const note = await addNote(page, 0.8, 0.6);
    await stubPrint(page);

    await print(page, { pages: '1, 3' });
    const images = page.locator('#folio-print img');
    await expect(images).toHaveCount(2);
    await expect(page.locator('html')).toHaveAttribute('data-folio-printing', '');
    // The note is drawn into the printed page (the note colour is yellow).
    const [r, g, b] = await printedPixel(page, 0, note);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(120);
    // On paper there are only the prepared pages, one per sheet.
    const paper = await PDFDocument.load(await page.pdf({ printBackground: true }));
    expect(paper.getPageCount()).toBe(2);
    await finishPrinting(page);

    await print(page, { comments: false });
    await expect(images).toHaveCount(3);
    const [r2, g2, b2] = await printedPixel(page, 0, note);
    expect(Math.min(r2, g2, b2)).toBeGreaterThan(230);
    await finishPrinting(page);

    // Printing from the browser's own menu prints the app, not a blank page.
    const app = await PDFDocument.load(await page.pdf());
    expect(app.getPageCount()).toBeGreaterThan(0);
    // Printing never changes the document.
    await expect(page.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAccessibleName(
      /unsaved/i,
    );
  });

  test('refuses page ranges outside the document', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Print…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Print' });
    await dialog.getByRole('textbox', { name: 'Pages to print' }).fill('2-5');
    await expect(dialog.getByRole('alert')).toHaveText('Enter pages like 1-3, 5 (from 1 to 3).');
    await expect(dialog.getByRole('button', { name: 'Print…' })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Pages to print' }).fill('2-3');
    await expect(dialog.getByRole('button', { name: 'Print…' })).toBeEnabled();
  });
});

test.describe('crash recovery', () => {
  test('offers unsaved changes again after the window closed', async ({ page, context }) => {
    await page.goto('/');
    await open(page, 'basic-3-pages.pdf');
    await addNote(page, 0.5, 0.5);
    await expect(commentsTab(page)).toHaveText(/Comments\s*1/);
    // Autosave writes the change shortly after it was made.
    await expect.poll(() => recoveryRecords(page)).toBe(1);

    // A second window does not offer work that is still open in the first.
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
    await second.waitForTimeout(1000);
    await expect(second.getByRole('dialog')).toHaveCount(0);
    await second.close();

    // Closing without saving (as a crash would) leaves the work to recover.
    await page.close();
    const next = await context.newPage();
    await next.goto('/');
    const dialog = next.getByRole('dialog', { name: 'Recover unsaved changes' });
    await expect(dialog.getByRole('list', { name: 'Recovered documents' })).toContainText(
      'basic-3-pages.pdf',
    );
    await dialog.getByRole('button', { name: 'Restore' }).click();
    await expect(dialog).toHaveCount(0);
    await pageRendered(next);
    await expect(commentsTab(next)).toHaveText(/Comments\s*1/);
    await expect(next.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAccessibleName(
      /unsaved/i,
    );
    // The history came back too.
    await next.getByRole('region', { name: 'Page view' }).focus();
    await next.keyboard.press('Control+Z');
    await expect(commentsTab(next)).toHaveText('Comments');
    await next.keyboard.press('Control+Shift+Z');
    await expect(commentsTab(next)).toHaveText(/Comments\s*1/);

    // Saving deletes the recovery data.
    const download = next.waitForEvent('download');
    await next.getByRole('button', { name: 'Download PDF' }).click();
    const saved = await PDFDocument.load(readFileSync((await (await download).path())!));
    expect(saved.getPageCount()).toBe(3);
    await expect.poll(() => recoveryRecords(next)).toBe(0);
  });

  test('discards recovered work on request', async ({ page, context }) => {
    await page.goto('/');
    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Rotate page clockwise' }).click();
    await expect.poll(() => recoveryRecords(page)).toBe(1);
    await page.close();

    const next = await context.newPage();
    await next.goto('/');
    const dialog = next.getByRole('dialog', { name: 'Recover unsaved changes' });
    await dialog.getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => recoveryRecords(next)).toBe(0);
    await expect(next.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
  });

  test('keeps nothing for documents without unsaved changes', async ({ page }) => {
    await page.goto('/');
    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Rotate page clockwise' }).click();
    await expect.poll(() => recoveryRecords(page)).toBe(1);
    // Undoing back to the opened state removes the record.
    await page.getByRole('region', { name: 'Page view' }).focus();
    await page.keyboard.press('Control+Z');
    await expect.poll(() => recoveryRecords(page)).toBe(0);
  });
});
