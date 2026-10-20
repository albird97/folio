import { decodePDFRawStream, PDFArray, PDFDocument, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseFiles, download, expectAccessible } from '../helpers';

/**
 * Split view: two documents side by side, pages copied from one to the
 * other by dragging thumbnails (or from the pages menu), undoable, and
 * saved in order. Saved files are read back with pdf-lib.
 */

const LEFT = 'basic-3-pages.pdf';
const RIGHT = 'outline-and-text.pdf';

async function openBoth(page: Page) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
    LEFT,
    RIGHT,
  ]);
  await expect(page.getByRole('button', { name: new RegExp(RIGHT) }).first()).toBeVisible();
}

const pane = (page: Page, side: 'Left' | 'Right') =>
  page.getByRole('region', { name: new RegExp(`^${side} pane`) });
const pagesOf = (page: Page, name: string) =>
  page.getByRole('listbox', { name: `Pages, ${name}`, exact: true });
const viewOf = (page: Page, name: string) =>
  page.getByRole('region', { name: `Page view, ${name}`, exact: true });
const rendered = (view: Locator, pageNumber = 1) =>
  expect(view.locator(`[data-page="${pageNumber}"] [data-testid="page-canvas"]`)).toHaveAttribute(
    'data-render-state',
    'done',
  );

/** The thumbnails are virtualized: each says how many pages there are. */
const expectPages = (list: Locator, count: number) =>
  expect(list.getByRole('option').first()).toHaveAttribute('aria-setsize', String(count));

async function splitOn(page: Page) {
  await page.getByRole('button', { name: 'Show two documents side by side' }).click();
  await expect(pane(page, 'Left')).toHaveAccessibleName(`Left pane, ${LEFT}`);
  await expect(pane(page, 'Right')).toHaveAccessibleName(`Right pane, ${RIGHT}`);
  await rendered(viewOf(page, LEFT));
  await rendered(viewOf(page, RIGHT));
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('not visible');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

/**
 * Each saved page's content streams, decoded, with the hex strings that
 * standard-font text is written in turned back into text.
 */
async function pageContents(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const latin1 = new TextDecoder('latin1');
  return doc.getPages().map((pdfPage) => {
    const contents = pdfPage.node.lookup(PDFName.of('Contents'));
    const refs =
      contents instanceof PDFArray
        ? contents.asArray()
        : [pdfPage.node.get(PDFName.of('Contents'))];
    return refs
      .map((ref) => {
        const stream = doc.context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) throw new Error('Expected a content stream.');
        return latin1
          .decode(decodePDFRawStream(stream).decode())
          .replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
            hex.replace(/../g, (pair) => String.fromCharCode(Number.parseInt(pair, 16))),
          );
      })
      .join('\n');
  });
}

/** What each page of a saved file starts with: its heading. */
const headings = (contents: string[]) =>
  contents.map(
    (text) =>
      [
        'Folio fixture page 1',
        'Folio fixture page 2',
        'Folio fixture page 3',
        'Introduction',
        'Chapter 1: Foxes',
        'Section 1.1: Habitat',
        'Field notes',
        'Chapter 2: Plants',
        'Appendix',
      ].find((heading) => text.includes(heading)) ?? '?',
  );

test.describe('split view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('copies pages dragged from one document into the other', async ({ page }) => {
    await openBoth(page);
    await splitOn(page);
    const left = pagesOf(page, LEFT);
    const right = pagesOf(page, RIGHT);
    await expectPages(left, 3);
    await expectPages(right, 6);
    // The left pane has focus: its document is the one the toolbar shows.
    await expect(pane(page, 'Left')).toHaveAttribute('data-active', 'true');
    await expect(page.getByRole('toolbar', { name: 'Workspace' }).getByRole('heading')).toHaveText(
      'Folio Basic Fixture',
    );

    // Select pages 1 and 2 on the left and drag them between pages 1 and 2 on the right.
    await left.getByRole('option', { name: 'Page 1' }).click();
    await left.getByRole('option', { name: 'Page 2' }).click({ modifiers: ['ControlOrMeta'] });
    await expect(left.getByRole('option', { selected: true })).toHaveCount(2);
    const from = await center(left.getByRole('option', { name: 'Page 2' }));
    const { box: gap } = await center(right.getByRole('option', { name: 'Page 2' }));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(gap.x + gap.width / 2, gap.y + 4, { steps: 12 });
    // A preview says how many pages go, and a line shows where.
    await expect(page.getByText('2 pages', { exact: true })).toBeVisible();
    await expect(right.locator('[data-drop-indicator="1"]')).toHaveCount(1);
    await page.mouse.up();

    await expectPages(right, 8);
    await expectPages(left, 3);
    await expect(page.locator('[data-drop-indicator]')).toHaveCount(0);
    // The copies are selected in the right document, which is now the active one.
    await expect(right.getByRole('option', { selected: true })).toHaveCount(2);
    await expect(right.getByRole('option', { name: 'Page 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(pane(page, 'Right')).toHaveAttribute('data-active', 'true');
    await rendered(viewOf(page, RIGHT), 2);
    await expectAccessible(page, 'split view after a copy (light)');

    // One undo step takes the copies back; redo brings them again.
    await page.keyboard.press('Control+Z');
    await expectPages(right, 6);
    await expectPages(left, 3);
    await page.keyboard.press('Control+Shift+Z');
    await expectPages(right, 8);

    // Saved: the copies sit between the right document's first and second pages.
    const saved = await download(page, () =>
      page.getByRole('button', { name: 'Download PDF' }).click(),
    );
    expect(saved.name).toBe(RIGHT);
    expect(headings(await pageContents(saved.bytes))).toEqual([
      'Introduction',
      'Folio fixture page 1',
      'Folio fixture page 2',
      'Chapter 1: Foxes',
      'Section 1.1: Habitat',
      'Field notes',
      'Chapter 2: Plants',
      'Appendix',
    ]);

    // Escape gives up a drag; dropping on the page view puts pages after the current page.
    const shown = Number(await page.getByRole('textbox', { name: /^Page number/ }).inputValue());
    const third = await center(left.getByRole('option', { name: 'Page 3' }));
    await page.mouse.move(third.x, third.y);
    await page.mouse.down();
    const view = await center(viewOf(page, RIGHT));
    await page.mouse.move(view.x, view.y, { steps: 10 });
    await expect(viewOf(page, RIGHT)).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expectPages(right, 8);
    await expect(page.getByText('1 page', { exact: true })).toHaveCount(0);

    await page.mouse.move(third.x, third.y);
    await page.mouse.down();
    await page.mouse.move(view.x, view.y, { steps: 10 });
    await page.mouse.up();
    await expectPages(right, 9);
    await expect(right.getByRole('option', { selected: true })).toHaveAccessibleName(
      `Page ${shown + 1}`,
    );
  });

  test('switches documents in the panes and is accessible in both themes', async ({ page }) => {
    await openBoth(page);
    await splitOn(page);
    await expectAccessible(page, 'split view (light)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectAccessible(page, 'split view (dark)');
    await page.emulateMedia({ colorScheme: 'light' });

    // Clicking in a pane gives it focus; the tabs follow.
    await viewOf(page, RIGHT).click({ position: { x: 20, y: 20 } });
    await expect(pane(page, 'Right')).toHaveAttribute('data-active', 'true');
    await expect(page.getByRole('button', { name: new RegExp(`^${RIGHT}`) })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // A pane's menu shows another document there; picking the other pane's swaps them.
    await pane(page, 'Right')
      .getByRole('button', { name: /Choose a document/ })
      .click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitemradio', { name: LEFT }).click();
    await expect(pane(page, 'Right')).toHaveAccessibleName(`Right pane, ${LEFT}`);
    await expect(pane(page, 'Left')).toHaveAccessibleName(`Left pane, ${RIGHT}`);

    // Closing one document empties its pane, which offers to open another.
    await page.getByRole('button', { name: `Close ${RIGHT}` }).click();
    await expect(pane(page, 'Left')).toHaveAccessibleName('Left pane');
    await expect(pane(page, 'Left').getByRole('button', { name: 'Open a PDF…' })).toBeVisible();
    await expectAccessible(page, 'split view with an empty pane');
    // A file opened from the empty pane goes there.
    await chooseFiles(
      page,
      () => pane(page, 'Left').getByRole('button', { name: 'Open a PDF…' }).click(),
      ['rotated-pages.pdf'],
    );
    await expect(pane(page, 'Left')).toHaveAccessibleName('Left pane, rotated-pages.pdf');
    await expect(pane(page, 'Left')).toHaveAttribute('data-active', 'true');

    // Narrow windows stack the panes.
    await page.setViewportSize({ width: 1000, height: 800 });
    const top = (await pane(page, 'Left').boundingBox())!;
    const bottom = (await pane(page, 'Right').boundingBox())!;
    expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);

    // Turning it off brings back one document, the active one.
    await page.keyboard.press('Control+Alt+3');
    await expect(pane(page, 'Left')).toHaveCount(0);
    await expect(page.getByRole('listbox', { name: 'Pages', exact: true })).toBeVisible();
    await expect(page.getByRole('main')).toHaveAccessibleName('rotated-pages.pdf');
  });

  test('copies pages from the pages menu without split view', async ({ page }) => {
    await openBoth(page);
    const pages = page.getByRole('listbox', { name: 'Pages', exact: true });
    await expectPages(pages, 3);
    await pages.getByRole('option', { name: 'Page 3' }).click();
    await page.getByRole('button', { name: 'More page commands' }).click();
    await page.getByRole('menuitem', { name: `Copy page to ${RIGHT}…` }).click();
    const dialog = page.getByRole('dialog', { name: `Copy 1 page to ${RIGHT}` });
    await expect(dialog).toBeVisible();
    await expectAccessible(page, 'copy pages dialog');
    await expect(dialog.getByRole('radio', { name: 'At the end, after page 6' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Copied 1 page' })).toHaveText(
      `Copied 1 page to ${RIGHT}.`,
    );
    // This document is unchanged; the other one has the copy at its end.
    await expectPages(pages, 3);
    await page.getByRole('button', { name: new RegExp(`^${RIGHT}`) }).click();
    await expectPages(pages, 7);
    const saved = await download(page, () =>
      page.getByRole('button', { name: 'Download PDF' }).click(),
    );
    expect(headings(await pageContents(saved.bytes)).at(-1)).toBe('Folio fixture page 3');
  });
});
