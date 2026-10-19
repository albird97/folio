import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';

/**
 * Page numbers and watermarks: added through their dialogs, shown on the
 * pages at once, undoable, and drawn into the saved file's pages, which are
 * read back with pdf-lib.
 */

async function open(page: Page, name: string) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [name]);
  await pageRendered(page);
}

async function openTool(page: Page, name: string) {
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name }).click();
}

const pageField = (page: Page) => page.getByRole('textbox', { name: /^Page number/ });
const stamp = (page: Page, pageNumber: number, kind: 'pageNumbers' | 'watermark') =>
  page.locator(`[data-stamp-layer="${pageNumber}"] [data-stamp="${kind}"]`);

async function goToPage(page: Page, pageNumber: number) {
  await pageField(page).fill(String(pageNumber));
  await pageField(page).press('Enter');
  await pageRendered(page, pageNumber);
}

/** Runs `action` and returns the bytes of the file it downloads. */
async function download(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('download');
  await action();
  const file = await pending;
  return new Uint8Array(readFileSync((await file.path())!));
}

const saveAs = (page: Page) =>
  download(page, () => page.getByRole('button', { name: 'Download PDF' }).click());

/**
 * Each saved page's content streams, decoded, with the hex strings that
 * standard-font text is written in turned back into text.
 */
async function pageContents(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const latin1 = new TextDecoder('latin1');
  return doc.getPages().map((pdfPage) => {
    const contents = pdfPage.node.lookup(PDFName.of('Contents'));
    const refs =
      contents instanceof PDFArray
        ? contents.asArray()
        : [pdfPage.node.get(PDFName.of('Contents'))];
    return refs.map((ref) => {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) throw new Error('Expected a content stream.');
      return latin1
        .decode(decodePDFRawStream(stream).decode())
        .replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
          hex.replace(/../g, (pair) => String.fromCharCode(Number.parseInt(pair, 16))),
        );
    });
  });
}

test.describe('page numbers and watermarks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('adds page numbers to every page, saves them and undoes them', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await openTool(page, 'Page numbers…');
    const dialog = page.getByRole('dialog', { name: 'Page numbers' });
    await expectAccessible(page, 'page numbers dialog');
    await dialog.getByLabel('Format').selectOption({ label: 'Page 1 of 3' });
    await dialog
      .getByRole('radiogroup', { name: 'Horizontal position' })
      .getByRole('radio', { name: 'Right' })
      .click();
    // The preview shows the current page's number.
    await expect(dialog.getByText('Page 1 shows “Page 1 of 3”')).toBeVisible();
    // Invalid values are explained and cannot be applied.
    await dialog.getByRole('spinbutton', { name: 'Size' }).fill('200');
    await expect(dialog.getByText('Enter a size from 4 to 72 points.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();
    // Sizes between the spin buttons' steps are fine.
    await dialog.getByRole('spinbutton', { name: 'Size' }).fill('10.5');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();

    // Every page shows its number at once, as drawn text.
    for (const pageNumber of [1, 2, 3]) {
      await goToPage(page, pageNumber);
      await expect(stamp(page, pageNumber, 'pageNumbers')).toHaveText(`Page ${pageNumber} of 3`);
    }
    // The text sits at the bottom right of the page.
    const pageBox = (await page.locator('[data-page="3"]').boundingBox())!;
    const textBox = (await stamp(page, 3, 'pageNumbers').boundingBox())!;
    expect(textBox.x + textBox.width).toBeGreaterThan(pageBox.x + pageBox.width * 0.8);
    expect(textBox.y).toBeGreaterThan(pageBox.y + pageBox.height * 0.9);

    // The properties panel says so and opens the dialog with the current settings.
    const properties = page.getByRole('complementary', { name: 'Properties' });
    await expect(properties).toContainText('“Page 1 of 3”, bottom right');
    await properties.getByRole('button', { name: 'Edit page numbers' }).click();
    await expect(dialog.getByLabel('Format')).toHaveValue('Page {page} of {total}');
    await expect(dialog.getByRole('spinbutton', { name: 'Size' })).toHaveValue('10.5');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // The saved pages carry their numbers as page content.
    const saved = await pageContents(await saveAs(page));
    saved.forEach((streams, index) => {
      const added = streams.at(-1)!;
      expect(added).toContain(`Page ${index + 1} of 3`);
      expect(added).toContain('/Artifact <</Type /Pagination /Subtype /Footer');
    });

    // One undo takes them away again.
    await page.getByRole('region', { name: 'Page view' }).focus();
    await page.keyboard.press('Control+Z');
    await expect(page.locator('[data-stamp-layer]')).toHaveCount(0);
    await expect(properties).not.toContainText('Page numbers');
  });

  test('adds a watermark turned 45° under the content', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await openTool(page, 'Watermark…');
    const dialog = page.getByRole('dialog', { name: 'Watermark' });
    await dialog.getByRole('textbox', { name: 'Text' }).fill('CONFIDENTIAL');
    await expect(dialog.getByRole('spinbutton', { name: 'Angle' })).toHaveValue('45');
    await dialog
      .getByRole('radiogroup', { name: 'Layer' })
      .getByRole('radio', { name: 'Under the content' })
      .click();
    await expectAccessible(page, 'watermark dialog');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'watermark dialog (dark)');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toBeHidden();

    const watermark = stamp(page, 1, 'watermark');
    await expect(watermark).toHaveText('CONFIDENTIAL');
    // Under the content, it is multiplied into the page; turned 45°, its box is about square.
    await expect(watermark).toHaveCSS('mix-blend-mode', 'multiply');
    const box = (await watermark.boundingBox())!;
    expect(box.width / box.height).toBeGreaterThan(0.8);
    expect(box.width / box.height).toBeLessThan(1.25);

    // Saved before the page's own content.
    const [first] = await pageContents(await saveAs(page));
    expect(first![0]).toContain('CONFIDENTIAL');
    expect(first![0]).toContain('/Subtype /Watermark');
    const original = first!.findIndex((stream) => stream.includes('Folio fixture page 1'));
    expect(original).toBeGreaterThan(0);

    // Removing it is one more step in the history.
    await openTool(page, 'Watermark…');
    await dialog.getByRole('button', { name: 'Remove watermark' }).click();
    await expect(page.locator('[data-stamp-layer]')).toHaveCount(0);
    await page.getByRole('region', { name: 'Page view' }).focus();
    await page.keyboard.press('Control+Z');
    await expect(stamp(page, 1, 'watermark')).toHaveText('CONFIDENTIAL');
  });

  test('shows a watermark under the content blended into the page', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    // The fixture's light blue header box (x 36–576, y 672–756 of a 612 × 792 page).
    const pageBox = (await page.locator('[data-page="1"]').boundingBox())!;
    const scale = pageBox.width / 612;
    const header = {
      x: pageBox.x + 40 * scale,
      y: pageBox.y + 38 * scale,
      width: 530 * scale,
      height: 78 * scale,
    };
    /** Pixels of the header box that show pure white. */
    const whitePixels = async () => {
      const png = (await page.screenshot({ clip: header })).toString('base64');
      return page.evaluate(async (data) => {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let white = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index]! > 250 && pixels[index + 1]! > 250 && pixels[index + 2]! > 250) {
            white += 1;
          }
        }
        return white;
      }, png);
    };
    // Opaque white letters across the header: over the content they show; under
    // it they are multiplied into the page, which white leaves as it was.
    for (const layer of ['Under the content', 'Over the content']) {
      await openTool(page, 'Watermark…');
      const dialog = page.getByRole('dialog', { name: 'Watermark' });
      await dialog.getByRole('textbox', { name: 'Text' }).fill('MMMMMM');
      await dialog.getByRole('radio', { name: 'Top' }).click();
      await dialog.getByRole('radio', { name: 'Left' }).click();
      await dialog.getByRole('spinbutton', { name: 'Angle' }).fill('0');
      await dialog.getByLabel('Opacity').fill('100');
      await dialog.getByRole('radio', { name: '#ffffff' }).click();
      await dialog.getByRole('radio', { name: layer }).click();
      await dialog.getByRole('button', { name: 'Apply' }).click();
      await expect(stamp(page, 1, 'watermark')).toHaveText('MMMMMM');
      if (layer === 'Under the content') expect(await whitePixels()).toBe(0);
      else expect(await whitePixels()).toBeGreaterThan(1000);
    }
  });
});
