import { PDFDocument } from '@cantoo/pdf-lib';
import { chooseFiles, download, expectAccessible, pageRendered, unzip } from '../helpers';
import { expect, test } from './fixtures';

test.describe('extension: export tools', () => {
  test('exports images, text and a protected copy from the editor as downloads', async ({
    page,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('editor.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'outline-and-text.pdf',
    ]);
    await pageRendered(page);
    const tools = async (item: string, name: string) => {
      await page.getByRole('button', { name: 'Tools' }).click();
      await page.getByRole('menuitem', { name: item }).click();
      return page.getByRole('dialog', { name });
    };

    let dialog = await tools('Export pages as images…', 'Export pages as images');
    await dialog.getByRole('textbox', { name: 'Pages to export' }).fill('1, 6');
    await dialog.getByRole('radio', { name: '72 dpi' }).click();
    const zip = await download(page, () => dialog.getByRole('button', { name: 'Export…' }).click());
    expect(zip.name).toBe('outline-and-text (images).zip');
    expect(unzip(zip.bytes).map((entry) => entry.name)).toEqual([
      'outline-and-text-page-1.png',
      'outline-and-text-page-6.png',
    ]);

    dialog = await tools('Export text…', 'Export text');
    await dialog.getByRole('radio', { name: /^Current page/ }).check();
    await dialog.getByRole('button', { name: 'Show text' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Text of the pages' })).toHaveValue(
      /^Introduction\nThe Quick brown fox/,
    );
    await expectAccessible(page, 'extension export text dialog');
    const text = await download(page, () =>
      dialog.getByRole('button', { name: 'Save as .txt…' }).click(),
    );
    expect(text.name).toBe('outline-and-text (text).txt');
    expect(text.bytes.toString('utf8')).toMatch(/^Introduction\nThe Quick brown fox/);

    dialog = await tools('Password protection…', 'Password protection');
    await dialog.getByLabel('Password', { exact: true }).fill('extension secret');
    await dialog.getByLabel('Confirm password').fill('extension secret');
    const copy = await download(page, () =>
      dialog.getByRole('button', { name: 'Save protected copy…' }).click(),
    );
    expect(copy.name).toBe('outline-and-text (protected).pdf');
    await expect(PDFDocument.load(copy.bytes, { updateMetadata: false })).rejects.toThrow();
    const pdf = await PDFDocument.load(copy.bytes, {
      updateMetadata: false,
      password: 'extension secret',
    });
    expect(pdf.getPageCount()).toBe(6);
  });
});
