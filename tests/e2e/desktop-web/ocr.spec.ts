import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, dropFiles, expectAccessible, pageRendered } from '../helpers';

/**
 * Recognize text (OCR) with the real Tesseract engine, bundled with the app:
 * scanned pages become searchable, selectable and copyable, and saved files
 * carry the text.
 */

const findBar = (page: Page) => page.getByRole('search', { name: 'Find in document' });

async function search(page: Page, query: string, expected: string | RegExp) {
  if (!(await findBar(page).isVisible())) await page.keyboard.press('Control+F');
  await findBar(page).getByRole('searchbox').fill(query);
  await expect(findBar(page).getByRole('status')).toHaveText(expected);
}

async function openRecognizeText(page: Page) {
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: 'Recognize text (OCR)…' }).click();
  return page.getByRole('dialog', { name: 'Recognize text' });
}

/** Drags across the text layer from the start of one word to the end of another. */
async function selectWords(page: Page, pageNumber: number, first: string, last: string) {
  const words = page.locator(`[data-page="${pageNumber}"] .textLayer span`);
  const from = (await words.filter({ hasText: new RegExp(`^${first}$`) }).boundingBox())!;
  const to = (await words.filter({ hasText: new RegExp(`^${last}$`) }).boundingBox())!;
  await page.mouse.move(from.x + 1, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe('recognize text', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('makes scanned pages searchable, copyable and saved with their text', async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'scanned-pages.pdf',
    ]);
    await pageRendered(page);
    // Pictures of text only: nothing to find yet.
    await search(page, 'lighthouse', 'No results');

    const dialog = await openRecognizeText(page);
    await expect(dialog.getByRole('radio', { name: /Pages without text/ })).toBeChecked();
    await expect(dialog.getByText('Reads 2 pages.')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'English' })).toBeChecked();
    await expect(
      dialog.getByRole('checkbox', { name: 'Include pages that already have text' }),
    ).toBeDisabled();
    await expectAccessible(page, 'recognize text dialog');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'recognize text dialog (dark)');
    await page.emulateMedia({ colorScheme: 'light' });

    await dialog.getByRole('button', { name: 'Recognize text' }).click();
    await expect(dialog.getByRole('progressbar', { name: 'Text recognition' })).toBeVisible();
    await expect(dialog.getByText(/^Found \d+ words on 2 pages\.$/)).toBeVisible({
      timeout: 90_000,
    });
    await expectAccessible(page, 'recognize text dialog, done');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();

    // The open search finds the word now, and highlights it on the page.
    await expect(findBar(page).getByRole('status')).toHaveText('1 result');
    await expect(page.locator('[data-page="1"] .folio-hit[data-active]')).toHaveCount(1);
    const hit = (await page.locator('[data-page="1"] .folio-hit').boundingBox())!;
    const word = (await page
      .locator('[data-page="1"] .textLayer span')
      .filter({ hasText: /^lighthouse$/ })
      .boundingBox())!;
    expect(Math.abs(hit.x - word.x)).toBeLessThan(2);
    expect(Math.abs(hit.width - word.width)).toBeLessThan(2);

    // Selected recognized text copies like any text.
    await page.keyboard.press('Escape');
    await selectWords(page, 1, 'lighthouse', 'keeper');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('lighthouse keeper');
    await page.keyboard.press('ControlOrMeta+C');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('lighthouse keeper');

    // The markup tools mark it like any text.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const tools = page.getByRole('toolbar', { name: 'Comment and drawing tools' });
    await tools.getByRole('radio', { name: 'Highlight' }).click();
    await selectWords(page, 1, 'lighthouse', 'lighthouse');
    await expect(page.getByRole('tab', { name: /^Comments/ })).toHaveText(/Comments\s*1/);
    await tools.getByRole('radio', { name: 'Select' }).click();

    // The page stored turned is searchable too.
    await search(page, 'mangga', '1 result');
    await expect(page.locator('[data-page="2"] .folio-hit[data-active]')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Saved, the text is part of the pages: invisible text in its own content stream.
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    const saved = readFileSync((await (await pending).path())!);
    const pdf = await PDFDocument.load(saved, { updateMetadata: false });
    const fonts = pdf.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    const font = fonts.lookup(fonts.keys()[0]!, PDFDict);
    expect(font.get(PDFName.of('BaseFont'))).toBe(PDFName.of('GlyphLessFont'));
    expect(font.lookup(PDFName.of('DescendantFonts'), PDFArray).size()).toBe(1);

    // Opened again, the text is the file's own: found without recognizing anything.
    await dropFiles(page, 'main', [{ name: 'recognized.pdf', bytes: saved }]);
    await expect(
      page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', {
        name: /^recognized\.pdf/,
      }),
    ).toHaveAttribute('aria-current', 'page');
    await pageRendered(page);
    await search(page, 'lighthouse keeper', '1 result');
    await search(page, 'pohon mangga', '1 result');
    await page.keyboard.press('Escape');

    // Undo takes the recognized text away from the scanned document again.
    await page
      .getByRole('navigation', { name: 'Open documents' })
      .getByRole('button', { name: /^scanned-pages\.pdf/ })
      .click();
    await pageRendered(page);
    await page.getByRole('button', { name: 'Undo highlight' }).click();
    await page.getByRole('button', { name: 'Undo recognize text' }).click();
    await search(page, 'lighthouse', 'No results');
    await expect(
      page.locator('[data-page="1"] .textLayer span').filter({ hasText: /^lighthouse$/ }),
    ).toHaveCount(0);
  });

  test('cancels while reading, and needs a language', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'scanned-pages.pdf',
    ]);
    await pageRendered(page);
    let dialog = await openRecognizeText(page);
    await dialog.getByRole('checkbox', { name: 'English' }).uncheck();
    await expect(dialog.getByRole('alert')).toHaveText('Choose at least one language.');
    await expect(dialog.getByRole('button', { name: 'Recognize text' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'Indonesian' }).check();
    await dialog.getByRole('radio', { name: /^Current page/ }).check();
    await expect(dialog.getByText('Reads 1 page.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Recognize text' }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    // Nothing changed, and the choice of language is remembered.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    dialog = await openRecognizeText(page);
    await expect(dialog.getByRole('checkbox', { name: 'Indonesian' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'English' })).not.toBeChecked();
  });
});
