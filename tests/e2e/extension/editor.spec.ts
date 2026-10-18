import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { readFileSync } from 'node:fs';
import {
  chooseFiles,
  dropFiles,
  expectAccessible,
  fixture,
  FIXTURE_PASSWORD,
  pageRendered,
} from '../helpers';
import { expect, test } from './fixtures';

test.describe('extension editor', () => {
  test.beforeEach(async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('editor.html'));
  });

  test('starts accessible in light and dark themes', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
    await expectAccessible(page, 'editor welcome (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'editor welcome (dark)');
  });

  test('opens, renders and describes a PDF', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    await expect(page.getByRole('toolbar').getByRole('heading')).toHaveText('Folio Basic Fixture');
    const properties = page.getByRole('complementary', { name: 'Properties' });
    await expect(properties.getByRole('textbox', { name: 'Author' })).toHaveValue(
      'Folio Test Suite',
    );
    await expect(properties).toContainText('1.7');
    await expect(page.getByRole('listbox', { name: 'Pages' }).getByRole('option')).toHaveCount(3);
    await expectAccessible(page, 'editor with document');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectAccessible(page, 'editor with document (dark)');
  });

  test('navigates pages from the thumbnails with the keyboard', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    const pages = page.getByRole('listbox', { name: 'Pages' });
    const pageField = page.getByRole('textbox', { name: /^Page number/ });
    await pages.getByRole('option', { name: 'Page 3' }).click();
    await expect(pageField).toHaveValue('3');
    await expect(pages.getByRole('option', { name: 'Page 3' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('ArrowUp');
    await expect(pageField).toHaveValue('2');
    await expect(pages.getByRole('option', { name: 'Page 2' })).toBeFocused();
    await pageRendered(page, 2);
  });

  test('searches, selects text and downloads an exact copy', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'outline-and-text.pdf',
    ]);
    await pageRendered(page);
    // Chrome's own find bar would only search the visible text layer.
    await page.keyboard.press('ControlOrMeta+F');
    const find = page.getByRole('search', { name: 'Find in document' });
    await find.getByRole('searchbox').fill('fox');
    await expect(find.getByRole('status')).toHaveText('8 results');
    await expect(page.locator('[data-page="1"] .folio-hit[data-active]')).toHaveCount(1);
    await expect(page.locator('[data-page="1"] .textLayer span').first()).toBeAttached();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'More ways to save' }).click();
    await page.getByRole('menuitem', { name: 'Download the original' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('outline-and-text.pdf');
    expect(readFileSync((await file.path())!)).toEqual(
      readFileSync(fixture('outline-and-text.pdf')),
    );
  });

  test('highlights text, inserts a blank page and downloads the edited PDF', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'basic-3-pages.pdf',
    ]);
    await pageRendered(page);
    await page
      .getByRole('toolbar', { name: 'Comment and drawing tools' })
      .getByRole('radio', { name: 'Highlight' })
      .click();
    const run = page.locator('[data-page="1"] .textLayer span').filter({ hasText: 'quick' });
    const box = (await run.first().boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole('tab', { name: /^Comments/ })).toHaveText(/Comments\s*1/);
    await page.getByRole('button', { name: 'Insert pages' }).click();
    await page.getByRole('menuitem', { name: 'Blank page' }).click();
    await expect(page.getByRole('tab', { name: /^Pages/ })).toHaveText(/Pages\s*4/);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('basic-3-pages.pdf');
    const saved = await PDFDocument.load(readFileSync((await file.path())!));
    expect(saved.getPageCount()).toBe(4);
    const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    expect(annots?.lookup(0, PDFDict).get(PDFName.of('Subtype'))?.toString()).toBe('/Highlight');
  });

  test('unlocks password-protected PDFs', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'encrypted-user-password.pdf',
    ]);
    await expect(
      page.getByRole('heading', { name: 'This PDF is password protected' }),
    ).toBeVisible();
    const password = page.getByRole('textbox', { name: 'Password' });
    await expect(password).toBeFocused();
    await password.fill('wrong');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('That password is incorrect');
    await expectAccessible(page, 'password prompt with error');
    await password.fill(FIXTURE_PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await pageRendered(page);
    await expect(page.getByRole('complementary', { name: 'Properties' })).toContainText(
      'Password required to open',
    );
  });

  test('explains files that are not PDFs', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'not-a-pdf.pdf',
    ]);
    await expect(page.getByRole('heading', { name: 'This isn’t a PDF' })).toBeVisible();
    await page.getByRole('button', { name: 'Close tab' }).click();
    await expect(page.getByRole('heading', { name: 'Open a PDF to get started' })).toBeVisible();
  });

  test('opens dropped PDFs and skips other dropped files', async ({ page }) => {
    await dropFiles(page, 'main', [
      { name: 'basic-3-pages.pdf' },
      { name: 'rotated-pages.pdf' },
      { name: 'photo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' },
    ]);
    const tabs = page.getByRole('navigation', { name: 'Open documents' });
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toBeVisible();
    await expect(tabs.getByRole('button', { name: /^rotated-pages\.pdf/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Skipped 1 file' })).toBeVisible();
    await pageRendered(page);
  });

  test('supports keyboard shortcuts that do not clash with Chrome', async ({ page }) => {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+O');
    await (
      await chooser
    ).setFiles([
      `${import.meta.dirname}/../../fixtures/basic-3-pages.pdf`,
      `${import.meta.dirname}/../../fixtures/rotated-pages.pdf`,
    ]);
    const tabs = page.getByRole('navigation', { name: 'Open documents' });
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('Alt+PageDown');
    await expect(tabs.getByRole('button', { name: /^rotated-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.keyboard.press('ControlOrMeta+Alt+1');
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden();
    await page.keyboard.press('ControlOrMeta+Alt+2');
    await expect(page.getByRole('complementary', { name: 'Properties' })).toBeHidden();
    await page.keyboard.press('Alt+W');
    await expect(tabs.getByRole('button', { name: /^rotated-pages\.pdf/ })).toHaveCount(0);
    await expect(tabs.getByRole('button', { name: /^basic-3-pages\.pdf/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
