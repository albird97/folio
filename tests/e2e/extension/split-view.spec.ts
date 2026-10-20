import { PDFDocument } from '@cantoo/pdf-lib';
import type { Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, expectAccessible } from '../helpers';
import { expect, test } from './fixtures';

const pagesOf = (list: Locator, count: number) =>
  expect(list.getByRole('option').first()).toHaveAttribute('aria-setsize', String(count));

test('shows two documents side by side and copies dragged pages', async ({
  page,
  extensionUrl,
}) => {
  await page.goto(extensionUrl('editor.html'));
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
    'basic-3-pages.pdf',
    'outline-and-text.pdf',
  ]);
  await page.getByRole('button', { name: 'Show two documents side by side' }).click();
  const left = page.getByRole('listbox', { name: 'Pages, basic-3-pages.pdf' });
  const right = page.getByRole('listbox', { name: 'Pages, outline-and-text.pdf' });
  await pagesOf(left, 3);
  await pagesOf(right, 6);
  await expect(
    page
      .getByRole('region', { name: 'Page view, outline-and-text.pdf' })
      .locator('[data-page="1"] [data-testid="page-canvas"]'),
  ).toHaveAttribute('data-render-state', 'done');
  await expectAccessible(page, 'extension split view');

  // Page 3 of the left document goes before the right one's first page.
  const from = (await left.getByRole('option', { name: 'Page 3' }).boundingBox())!;
  const to = (await right.getByRole('option', { name: 'Page 1' }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 2, { steps: 12 });
  await expect(right.locator('[data-drop-indicator="0"]')).toHaveCount(1);
  await page.mouse.up();
  await pagesOf(right, 7);
  await pagesOf(left, 3);

  // The right document is the active one now: Download saves it.
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  const saved = await pending;
  expect(saved.suggestedFilename()).toBe('outline-and-text.pdf');
  const doc = await PDFDocument.load(readFileSync((await saved.path())!));
  expect(doc.getPageCount()).toBe(7);
  // The copy keeps its landscape size (page 3 of the fixture).
  const [width, height] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
  expect(width).toBeGreaterThan(height);
});
