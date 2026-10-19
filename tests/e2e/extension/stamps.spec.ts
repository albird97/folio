import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';
import { expect, test } from './fixtures';

/**
 * Page numbers and a watermark in the extension's editor page (the same
 * workspace as the desktop app, under the extension's CSP), down to the
 * downloaded file.
 */

async function openTool(page: Page, name: string) {
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name }).click();
}

/** The text drawn in each content stream of the file's first page. */
async function firstPageStreams(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const node = doc.getPage(0).node;
  const contents = node.lookup(PDFName.of('Contents'));
  const refs =
    contents instanceof PDFArray ? contents.asArray() : [node.get(PDFName.of('Contents'))];
  const latin1 = new TextDecoder('latin1');
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) throw new Error('Expected a content stream.');
    return latin1
      .decode(decodePDFRawStream(stream).decode())
      .replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
        hex.replace(/../g, (pair) => String.fromCharCode(Number.parseInt(pair, 16))),
      );
  });
}

test('adds page numbers and a watermark and downloads them in the pages', async ({
  page,
  extensionUrl,
}) => {
  await page.goto(extensionUrl('editor.html'));
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
    'basic-3-pages.pdf',
  ]);
  await pageRendered(page);

  await openTool(page, 'Page numbers…');
  const numbers = page.getByRole('dialog', { name: 'Page numbers' });
  await numbers.getByLabel('Format').selectOption({ label: 'Page 1 of 3' });
  await expectAccessible(page, 'page numbers dialog');
  await numbers.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('[data-stamp-layer="1"] [data-stamp="pageNumbers"]')).toHaveText(
    'Page 1 of 3',
  );

  await openTool(page, 'Watermark…');
  const watermark = page.getByRole('dialog', { name: 'Watermark' });
  await watermark.getByRole('textbox', { name: 'Text' }).fill('DRAFT');
  await watermark.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('[data-stamp-layer="1"] [data-stamp="watermark"]')).toHaveText('DRAFT');

  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  const streams = await firstPageStreams(readFileSync((await (await pending).path())!));
  const added = streams.at(-1)!;
  // Over the content: the watermark, then the page number on top of it.
  expect(added.indexOf('DRAFT')).toBeGreaterThan(-1);
  expect(added.indexOf('Page 1 of 3')).toBeGreaterThan(added.indexOf('DRAFT'));
});
