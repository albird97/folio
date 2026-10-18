import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';

/**
 * Phase 3 editing in the shared workspace: annotations, page management,
 * document properties and saving. Saved files are read back with pdf-lib.
 */

async function open(page: Page, name: string) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [name]);
  await pageRendered(page);
}

const tool = (page: Page, name: string) =>
  page.getByRole('toolbar', { name: 'Comment and drawing tools' }).getByRole('radio', { name });
const pages = (page: Page) => page.getByRole('listbox', { name: 'Pages' });
const commentsTab = (page: Page) => page.getByRole('tab', { name: /^Comments/ });
const annotationGroups = (page: Page, pageNumber = 1) =>
  page.locator(`[data-annotation-layer="${pageNumber}"] [data-annotation-id]`);

async function pageBox(page: Page, pageNumber = 1) {
  const box = await page.locator(`[data-page="${pageNumber}"]`).boundingBox();
  if (!box) throw new Error(`page ${pageNumber} is not visible`);
  return box;
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}

/** Runs `action` and returns the bytes of the file it downloads. */
async function download(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('download');
  await action();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

const saveAs = (page: Page) =>
  download(page, () => page.getByRole('button', { name: 'Download PDF' }).click());

async function read(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    doc,
    pages: doc.getPages().map((pdfPage) => {
      const annots = pdfPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      const subtypes: string[] = [];
      for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
        const annot = annots!.lookup(index, PDFDict);
        subtypes.push(annot.get(PDFName.of('Subtype'))!.toString().slice(1));
      }
      const { width, height } = pdfPage.getSize();
      return {
        size: [Math.round(width), Math.round(height)],
        rotation: pdfPage.getRotation().angle,
        subtypes: subtypes.sort(),
      };
    }),
  };
}

/** Drags across the first text run on page 1 containing `text`. */
async function selectText(page: Page, text: string) {
  const run = page.locator('[data-page="1"] .textLayer span').filter({ hasText: text }).first();
  const box = await run.boundingBox();
  if (!box) throw new Error('text run not found');
  await drag(
    page,
    [box.x + 2, box.y + box.height / 2],
    [box.x + box.width - 2, box.y + box.height / 2],
  );
}

test.describe('editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('highlights, underlines and strikes through selected text', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await tool(page, 'Highlight').click();
    await selectText(page, 'quick brown fox');
    await expect(commentsTab(page)).toHaveText(/Comments\s*1/);
    await tool(page, 'Underline').click();
    await selectText(page, 'Letter portrait');
    await expect(commentsTab(page)).toHaveText(/Comments\s*2/);
    // The text selection is used up by the markup.
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);

    const { bytes } = await saveAs(page);
    const saved = await read(bytes);
    expect(saved.pages[0]?.subtypes).toEqual(['Highlight', 'Underline']);

    // With Select, a click on marked text selects the mark; a drag selects text.
    await tool(page, 'Select').click();
    const run = page
      .locator('[data-page="1"] .textLayer span')
      .filter({ hasText: 'quick brown fox' });
    const box = (await run.first().boundingBox())!;
    await page.mouse.click(box.x + 20, box.y + box.height / 2);
    await expect(page.getByRole('region', { name: 'Selected comment' })).toContainText('Highlight');
    await selectText(page, 'quick brown fox');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('quick');

    // The comments list deletes with the keyboard.
    await commentsTab(page).click();
    const list = page.getByRole('list', { name: 'Comments' });
    await list.getByRole('button').first().focus();
    await page.keyboard.press('Delete');
    await expect(commentsTab(page)).toHaveText(/Comments\s*1/);
    await expect(list.getByRole('button')).toHaveCount(1);
  });

  test('draws, moves, resizes, undoes and deletes annotations', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const box = await pageBox(page);
    await tool(page, 'Rectangle').click();
    await drag(page, [box.x + 100, box.y + 400], [box.x + 260, box.y + 480]);
    await tool(page, 'Draw').click();
    await drag(page, [box.x + 320, box.y + 400], [box.x + 420, box.y + 470]);
    await tool(page, 'Arrow').click();
    await drag(page, [box.x + 100, box.y + 560], [box.x + 260, box.y + 520]);
    await tool(page, 'Note').click();
    await page.mouse.click(box.x + 500, box.y + 400);
    await page.getByRole('textbox', { name: 'Note' }).fill('Check the figures');
    await page.keyboard.press('Control+Enter');
    await tool(page, 'Add text').click();
    await page.mouse.click(box.x + 100, box.y + 620);
    await page.keyboard.type('Approved');
    await page.keyboard.press('Control+Enter');
    await expect(annotationGroups(page)).toHaveCount(5);

    // Select the rectangle by its outline and drag it.
    await tool(page, 'Select').click();
    // The drawn shape (the group also holds a wider hit area).
    const rectangle = annotationGroups(page).first().locator('rect').first();
    const before = (await rectangle.boundingBox())!;
    await drag(page, [box.x + 101, box.y + 440], [box.x + 161, box.y + 480]);
    await expect
      .poll(async () => (await rectangle.boundingBox())!.x - before.x)
      .toBeCloseTo(60, -1);
    await expect(page.getByRole('region', { name: 'Selected comment' })).toContainText('Rectangle');

    // Resize from the bottom-right handle.
    const handle = page.locator('[data-handle="se"]');
    const handleBox = (await handle.boundingBox())!;
    const grip: [number, number] = [
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2,
    ];
    await drag(page, grip, [grip[0] + 60, grip[1] + 40]);
    await expect
      .poll(async () => (await rectangle.boundingBox())!.width - before.width)
      .toBeCloseTo(60, -1);

    // Undo the resize and the move, then redo the move.
    await page.keyboard.press('Control+Z');
    await page.keyboard.press('Control+Z');
    await expect.poll(async () => (await rectangle.boundingBox())!.x).toBeCloseTo(before.x, 0);
    await page.keyboard.press('Control+Shift+Z');
    await expect
      .poll(async () => (await rectangle.boundingBox())!.x - before.x)
      .toBeCloseTo(60, -1);

    // Arrow keys nudge the selection; Delete removes it.
    const x = (await rectangle.boundingBox())!.x;
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(async () => (await rectangle.boundingBox())!.x - x).toBeGreaterThan(5);
    await page.keyboard.press('Delete');
    await expect(annotationGroups(page)).toHaveCount(4);

    const { bytes } = await saveAs(page);
    expect((await read(bytes)).pages[0]?.subtypes).toEqual(['FreeText', 'Ink', 'Line', 'Text']);
    await expectAccessible(page, 'editor with comments');
  });

  test('edits added text in place and leaves typing undo to text fields', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const box = await pageBox(page);
    await tool(page, 'Add text').click();
    await page.mouse.click(box.x + 100, box.y + 450);
    await page.keyboard.type('First draft');
    await page.keyboard.press('Control+Enter');
    await expect(annotationGroups(page)).toHaveCount(1);
    await expect(annotationGroups(page).first()).toContainText('First draft');

    await page.mouse.dblclick(box.x + 110, box.y + 460);
    const editor = page.getByRole('textbox', { name: 'Text box' });
    await expect(editor).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(', revised');
    await page.keyboard.press('Control+Enter');
    await expect(annotationGroups(page).first()).toContainText('First draft, revised');

    // Undo while typing in a field undoes the typing, not the document.
    const title = page.getByRole('textbox', { name: 'Title' });
    await title.click();
    await title.press('End');
    await title.pressSequentially('!');
    await title.press('Control+Z');
    await expect(annotationGroups(page)).toHaveCount(1);
    await expect(annotationGroups(page).first()).toContainText('First draft, revised');
  });

  test('rotates, duplicates, deletes and reorders pages', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const list = pages(page);
    await list.getByRole('option', { name: 'Page 1' }).click();
    await page.getByRole('button', { name: 'Rotate page clockwise' }).click();
    await page.getByRole('button', { name: 'Duplicate page' }).click();
    await expect(list.getByRole('option')).toHaveCount(4);
    // The copy is selected; Shift-click extends to page 3 and deletes both.
    await list.getByRole('option', { name: 'Page 3' }).click({ modifiers: ['Shift'] });
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Delete 2 pages' }).click();
    await expect(list.getByRole('option')).toHaveCount(2);

    // Drag the first page below the second.
    const first = (await list.getByRole('option', { name: 'Page 1' }).boundingBox())!;
    await drag(
      page,
      [first.x + first.width / 2, first.y + first.height / 2],
      [first.x + first.width / 2, first.y + first.height * 1.9],
    );
    const { bytes } = await saveAs(page);
    const saved = await read(bytes);
    // The copy and A4 page 2 were deleted; Letter landscape now comes before the turned page.
    expect(saved.pages.map((entry) => [entry.size, entry.rotation])).toEqual([
      [[792, 612], 0],
      [[612, 792], 90],
    ]);
    // One undo brings back the order.
    await page.getByRole('region', { name: 'Page view' }).focus();
    await page.keyboard.press('Control+Z');
    const undone = await read((await saveAs(page)).bytes);
    expect(undone.pages.map((entry) => [entry.size, entry.rotation])).toEqual([
      [[612, 792], 90],
      [[792, 612], 0],
    ]);
  });

  test('inserts pages from another PDF, extracts pages and splits', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Insert pages' }).click();
    await chooseFiles(
      page,
      () => page.getByRole('menuitem', { name: 'Pages from a PDF…' }).click(),
      ['outline-and-text.pdf'],
    );
    const list = pages(page);
    // Thumbnails are virtualized; the tab and each option know the total.
    await expect(page.getByRole('tab', { name: /^Pages/ })).toHaveText(/Pages\s*9/);
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-setsize', '9');
    // The inserted pages follow page 1 and are selected.
    await expect(page.getByText('6 selected')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('Page 2 of 9');

    await list.getByRole('option', { name: 'Page 2' }).click();
    await list.getByRole('option', { name: 'Page 3' }).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'More page commands' }).click();
    const extracted = await download(page, () =>
      page.getByRole('menuitem', { name: 'Extract 2 pages…' }).click(),
    );
    expect(extracted.name).toBe('basic-3-pages (pages 2–3).pdf');
    expect((await read(extracted.bytes)).pages).toHaveLength(2);

    await page.getByRole('button', { name: 'More page commands' }).click();
    await page.getByRole('menuitem', { name: 'Split document…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Split document' });
    await dialog.getByRole('radio', { name: /Every/ }).check();
    await dialog.getByRole('spinbutton', { name: 'Pages per part' }).fill('3');
    await expect(dialog.getByRole('status')).toHaveText('Creates 3 documents.');
    await expectAccessible(page, 'split dialog');
    await dialog.getByRole('button', { name: 'Split' }).click();
    const tabs = page.getByRole('navigation', { name: 'Open documents' });
    await expect(
      tabs.getByRole('button', { name: /^basic-3-pages \(part 3\)\.pdf/ }),
    ).toBeVisible();
    await pageRendered(page);
    await expect(page.getByRole('contentinfo')).toContainText('Page 1 of 3');
  });

  test('asks for the password of a protected PDF before inserting it', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Insert pages' }).click();
    await chooseFiles(
      page,
      () => page.getByRole('menuitem', { name: 'Pages from a PDF…' }).click(),
      ['encrypted-user-password.pdf'],
    );
    const dialog = page.getByRole('dialog', { name: 'Insert pages from a protected PDF' });
    await dialog.getByLabel('Password').fill('wrong');
    await dialog.getByRole('button', { name: 'Insert pages' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(/incorrect/);
    await dialog.getByLabel('Password').fill('folio-test');
    await dialog.getByRole('button', { name: 'Insert pages' }).click();
    await expect(page.getByRole('tab', { name: /^Pages/ })).toHaveText(/Pages\s*6/);
  });

  test('saves edited properties, and flattened comments when asked', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    const title = page.getByRole('textbox', { name: 'Title' });
    await title.fill('Quarterly report');
    await page.getByRole('textbox', { name: 'Keywords' }).fill('finance, q1');
    await expect(page.getByRole('toolbar', { name: 'Workspace' })).toContainText(
      'Quarterly report',
    );
    const box = await pageBox(page);
    await tool(page, 'Rectangle').click();
    await drag(page, [box.x + 100, box.y + 400], [box.x + 260, box.y + 480]);

    const editable = await read((await saveAs(page)).bytes);
    expect(editable.doc.getTitle()).toBe('Quarterly report');
    expect(editable.doc.getKeywords()).toBe('finance, q1');
    expect(editable.doc.getProducer()).toBe('Folio');
    expect(editable.pages[0]?.subtypes).toEqual(['Square']);

    await page.getByRole('button', { name: 'More ways to save' }).click();
    const flat = await download(page, () =>
      page.getByRole('menuitem', { name: 'Download with comments flattened' }).click(),
    );
    expect((await read(flat.bytes)).pages[0]?.subtypes).toEqual([]);
  });

  test('asks before closing a document with unsaved changes', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await pages(page).getByRole('option', { name: 'Page 2' }).click();
    await page.getByRole('button', { name: 'Rotate page clockwise' }).click();
    const tab = page.getByRole('navigation', { name: 'Open documents' });
    await expect(tab).toContainText('unsaved changes');
    await page.getByRole('button', { name: /^Close basic-3-pages\.pdf/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Save changes to basic-3-pages.pdf?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Folio Basic Fixture' })).toBeVisible();

    // Saving marks the document saved, so it then closes without asking.
    await saveAs(page);
    await expect(tab).not.toContainText('unsaved changes');
    await page.getByRole('button', { name: /^Close basic-3-pages\.pdf/ }).click();
    await expect(page.getByRole('button', { name: /Choose PDF/ })).toBeVisible();

    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Delete page' }).click();
    await page.getByRole('button', { name: /^Close basic-3-pages\.pdf/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Don’t save' }).click();
    await expect(page.getByRole('button', { name: /Choose PDF/ })).toBeVisible();
  });

  test('honours documents that do not allow changes', async ({ page }) => {
    await open(page, 'encrypted-owner-restricted.pdf');
    await expect(tool(page, 'Highlight')).toBeDisabled();
    await expect(tool(page, 'Select')).toBeEnabled();
    await expect(page.getByText('This document does not allow comments.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete page' })).toBeDisabled();
    // Properties are shown, not editable.
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveCount(0);
  });

  test('keeps text added to a turned page level', async ({ page }) => {
    await open(page, 'basic-3-pages.pdf');
    await page.getByRole('button', { name: 'Rotate page clockwise' }).click();
    await pageRendered(page);
    const box = await pageBox(page);
    await tool(page, 'Add text').click();
    await page.mouse.click(box.x + 100, box.y + 100);
    await page.keyboard.type('Level');
    await page.keyboard.press('Control+Enter');
    // On screen the text runs left to right: its box is wider than tall.
    const text = annotationGroups(page).first().locator('text').first();
    const textBox = (await text.boundingBox())!;
    expect(textBox.width).toBeGreaterThan(textBox.height * 2);
    const saved = await read((await saveAs(page)).bytes);
    expect(saved.pages[0]).toMatchObject({ rotation: 90, subtypes: ['FreeText'] });
  });
});
