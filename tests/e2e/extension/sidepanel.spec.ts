import { PDFDocument } from '@cantoo/pdf-lib';
import { chooseFiles, download, expectAccessible, pageRendered, pngSize, unzip } from '../helpers';
import { expect, test } from './fixtures';

test.describe('extension side panel', () => {
  test('inspects a PDF and hands it to the editor through single-use storage', async ({
    page,
    context,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    await expectAccessible(page, 'side panel');
    await chooseFiles(page, () => page.getByRole('button', { name: 'Choose PDF…' }).click(), [
      'basic-3-pages.pdf',
    ]);
    const summary = page.getByRole('region', { name: 'Document summary' });
    await expect(summary).toContainText('Folio Basic Fixture');
    await expect(summary).toContainText('3 pages');
    await expect(summary).toContainText('Letter');
    await expect(page.getByTestId('sidepanel-thumbnail')).toHaveAttribute(
      'data-render-state',
      'done',
    );
    await expectAccessible(page, 'side panel with summary');

    // A hand-off nobody read (e.g. its tab was closed straight away) is purged
    // by the next one once it is older than ten minutes.
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('folio', 1);
          request.onupgradeneeded = () =>
            request.result.createObjectStore('handoffs', { keyPath: 'id' });
          request.onsuccess = () => {
            const transaction = request.result.transaction('handoffs', 'readwrite');
            transaction.objectStore('handoffs').put({
              id: 'f'.repeat(32),
              name: 'left-behind.pdf',
              bytes: new ArrayBuffer(8),
              createdAt: Date.now() - 11 * 60 * 1000,
            });
            transaction.oncomplete = () => {
              request.result.close();
              resolve();
            };
            transaction.onerror = () => reject(transaction.error);
          };
          request.onerror = () => reject(request.error);
        }),
    );

    const editorPromise = context.waitForEvent('page');
    await summary.getByRole('button', { name: 'Open in editor' }).click();
    const editor = await editorPromise;
    await pageRendered(editor);
    await expect(editor).toHaveURL(/editor\.html$/);
    await expect(editor.getByRole('toolbar').getByRole('heading')).toHaveText(
      'Folio Basic Fixture',
    );

    const remaining = await editor.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const request = indexedDB.open('folio');
          request.onsuccess = () => {
            const count = request.result.transaction('handoffs').objectStore('handoffs').count();
            count.onsuccess = () => resolve(count.result);
            count.onerror = () => reject(count.error);
          };
          request.onerror = () => reject(request.error);
        }),
    );
    expect(remaining).toBe(0);
    await editor.close();
  });

  test('sends password-protected PDFs to the editor to unlock', async ({
    page,
    context,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: 'Choose PDF…' }).click(), [
      'encrypted-user-password.pdf',
    ]);
    const locked = page.getByRole('region', { name: 'Password protected document' });
    await expect(locked).toBeVisible();
    const editorPromise = context.waitForEvent('page');
    await locked.getByRole('button', { name: 'Open in editor' }).click();
    const editor = await editorPromise;
    await expect(
      editor.getByRole('heading', { name: 'This PDF is password protected' }),
    ).toBeVisible();
    await editor.close();
  });

  test('reports unreadable files', async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: 'Choose PDF…' }).click(), [
      'header-only.pdf',
    ]);
    await expect(page.getByRole('alert')).toContainText('damaged');
  });

  test('rotates and extracts pages, makes images and extracts text', async ({
    page,
    context,
    extensionUrl,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(extensionUrl('sidepanel.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: 'Choose PDF…' }).click(), [
      'outline-and-text.pdf',
    ]);
    const tools = page.getByRole('region', { name: 'Tools' });
    const panel = (name: string) => tools.getByRole('group', { name });

    // Rotate pages 1 and 2 to the left; page 3 keeps its orientation.
    await tools.getByRole('button', { name: 'Rotate pages' }).click();
    await panel('Rotate pages').getByRole('textbox', { name: 'Pages' }).fill('1-2');
    await panel('Rotate pages').getByRole('radio', { name: 'Left' }).click();
    const rotated = await download(page, () =>
      panel('Rotate pages').getByRole('button', { name: 'Download' }).click(),
    );
    expect(rotated.name).toBe('outline-and-text (rotated).pdf');
    const turned = await PDFDocument.load(rotated.bytes);
    expect(turned.getPages().map((pdfPage) => pdfPage.getRotation().angle)).toEqual([
      270, 270, 0, 0, 0, 0,
    ]);

    await tools.getByRole('button', { name: 'Extract pages' }).click();
    const extractPanel = panel('Extract pages');
    await extractPanel.getByRole('textbox', { name: 'Pages' }).fill('9');
    await expect(extractPanel.getByText('Enter pages like 1-3, 5 (from 1 to 6).')).toBeVisible();
    await expect(extractPanel.getByRole('button', { name: 'Download' })).toBeDisabled();
    await extractPanel.getByRole('textbox', { name: 'Pages' }).fill('2, 4');
    const extracted = await download(page, () =>
      extractPanel.getByRole('button', { name: 'Download' }).click(),
    );
    expect(extracted.name).toBe('outline-and-text (pages 2,4).pdf');
    expect((await PDFDocument.load(extracted.bytes)).getPageCount()).toBe(2);

    // Several pages download as a ZIP of PNGs; one page as the image itself.
    await tools.getByRole('button', { name: 'Pages to images' }).click();
    const imagesPanel = panel('Pages to images');
    await imagesPanel.getByRole('textbox', { name: 'Pages' }).fill('1-3');
    await imagesPanel.getByRole('radio', { name: '72 dpi' }).click();
    const zip = await download(page, () =>
      imagesPanel.getByRole('button', { name: 'Download' }).click(),
    );
    expect(zip.name).toBe('outline-and-text (images).zip');
    const entries = unzip(zip.bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      'outline-and-text-page-1.png',
      'outline-and-text-page-2.png',
      'outline-and-text-page-3.png',
    ]);
    // Letter at 72 dpi.
    expect(pngSize(entries[0]!.bytes)).toEqual([612, 792]);
    await imagesPanel.getByRole('textbox', { name: 'Pages' }).fill('6');
    await imagesPanel.getByRole('radio', { name: 'JPEG' }).click();
    const jpeg = await download(page, () =>
      imagesPanel.getByRole('button', { name: 'Download' }).click(),
    );
    expect(jpeg.name).toBe('outline-and-text-page-6.jpg');
    expect([...jpeg.bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    await tools.getByRole('button', { name: 'Extract text' }).click();
    const textPanel = panel('Extract text');
    // The page range carries over between tools; empty means every page.
    await expect(textPanel.getByRole('textbox', { name: 'Pages' })).toHaveValue('6');
    await textPanel.getByRole('textbox', { name: 'Pages' }).fill('');
    await textPanel.getByRole('button', { name: 'Extract' }).click();
    const text = textPanel.getByRole('textbox', { name: 'Extracted text' });
    await expect(text).toHaveValue(/^Introduction\nThe Quick brown fox opens this guide\./);
    await expect(text).toHaveValue(/Appendix\nA cat and another cat are not a category\.$/);
    await textPanel.getByRole('button', { name: 'Copy' }).click();
    await expect(textPanel.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('photosynthesis');
    const txt = await download(page, () =>
      textPanel.getByRole('button', { name: 'Download .txt' }).click(),
    );
    expect(txt.name).toBe('outline-and-text (text).txt');
    expect(txt.bytes.toString('utf8')).toContain('Foxes visit the Café at dawn.');
    await expectAccessible(page, 'side panel tools');
  });

  test('leaves protected PDFs to the editor and honours copy restrictions', async ({
    page,
    extensionUrl,
  }) => {
    await page.goto(extensionUrl('sidepanel.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: 'Choose PDF…' }).click(), [
      'encrypted-owner-restricted.pdf',
    ]);
    const tools = page.getByRole('region', { name: 'Tools' });
    await tools.getByRole('button', { name: 'Rotate pages' }).click();
    await expect(tools.getByRole('group', { name: 'Rotate pages' })).toHaveText(
      'Protected PDFs can be changed in the editor, which keeps their protection.',
    );
    await expect(tools.getByRole('button', { name: 'Download' })).toHaveCount(0);
  });
});
