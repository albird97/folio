import { PDFArray, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';

/**
 * Filling in forms in the shared workspace: every kind of field on the
 * page, undo and redo, saving the values (read back with pdf-lib) and
 * flattening the form; XFA forms are explained and left as drawn.
 */

async function open(page: Page, name: string) {
  await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [name]);
  await pageRendered(page);
}

/** Runs `action` and returns the bytes of the file it downloads. */
async function download(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('download');
  await action();
  return readFileSync((await (await pending).path())!);
}

/** The values of the fixture's fields in a saved file. */
async function formValues(bytes: Uint8Array) {
  const form = (await PDFDocument.load(bytes, { updateMetadata: false })).getForm();
  const text = (name: string) => form.getTextField(name).getText() ?? '';
  return {
    name: text('name'),
    notes: text('notes'),
    code: text('code'),
    pin: text('pin'),
    agree: form.getCheckBox('agree').isChecked(),
    size: form.getRadioGroup('size').getSelected() ?? null,
    country: form.getDropdown('country').getSelected(),
    colors: form.getOptionList('colors').getSelected(),
    id: text('id'),
  };
}

/** Whether a saved file still has a form, and the widgets left on each page. */
async function formParts(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    form: doc.catalog.get(PDFName.of('AcroForm')) !== undefined,
    widgets: doc.getPages().map((pdfPage) => {
      const annots = pdfPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      let count = 0;
      for (let index = 0; index < (annots?.size() ?? 0); index += 1) {
        const annot = annots!.lookup(index, PDFDict);
        if (annot.get(PDFName.of('Subtype')) === PDFName.of('Widget')) count += 1;
      }
      return count;
    }),
  };
}

/** Dark pixels inside a box of page 1 (points from the bottom-left of the Letter page). */
const darkPixels = (page: Page, rect: [number, number, number, number]) =>
  page
    .locator('[data-page="1"] [data-testid="page-canvas"]')
    .evaluate((canvas: HTMLCanvasElement, [x0, y0, x1, y1]) => {
      const sx = canvas.width / 612;
      const sy = canvas.height / 792;
      const data = canvas
        .getContext('2d')!
        .getImageData(
          Math.round(x0 * sx),
          Math.round((792 - y1) * sy),
          Math.round((x1 - x0) * sx),
          Math.round((y1 - y0) * sy),
        ).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! + data[i + 1]! + data[i + 2]! < 300) count += 1;
      }
      return count;
    }, rect);

test.describe('forms', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('fills in every kind of field, undoes and redoes, and saves the values', async ({
    page,
  }) => {
    await open(page, 'form-fields.pdf');
    await expect(page.getByRole('region', { name: 'Form' })).toContainText(
      'This document has fields you can fill in.',
    );
    await expect(page.getByRole('complementary', { name: 'Properties' })).toContainText(
      'Interactive form, 10 fields',
    );
    await expectAccessible(page, 'a page with form fields');

    // Inside the name field's border, where only its value is drawn.
    const nameValue: [number, number, number, number] = [76, 643, 328, 661];
    expect(await darkPixels(page, nameValue)).toBe(0);
    await page.getByRole('textbox', { name: 'Full name' }).click();
    await page.keyboard.type('Ada Lovelace');
    // Tab commits the typing and moves on, in the page's order.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('textbox', { name: 'notes' })).toBeFocused();
    await page.keyboard.type('Line one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line two');
    await page.keyboard.press('Tab');
    // Five comb cells take five characters.
    await page.keyboard.type('ABCDEFG');
    await expect(page.getByRole('textbox', { name: 'code' })).toHaveValue('ABCDE');
    await expect(page.getByLabel('pin', { exact: true })).toHaveAttribute('type', 'password');
    await page.getByLabel('pin', { exact: true }).fill('4321');
    await page.getByRole('checkbox', { name: 'agree' }).click();
    const size = page.getByRole('radiogroup', { name: 'size' });
    await size.getByRole('radio', { name: 'M', exact: true }).click();
    await page.keyboard.press('ArrowRight');
    await expect(size.getByRole('radio', { name: 'L', exact: true })).toBeFocused();
    await expect(size.getByRole('radio', { name: 'L', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The page shows the value as it will be saved, once the field lets go of it.
    await expect.poll(() => darkPixels(page, nameValue)).toBeGreaterThan(50);

    const country = page.getByRole('combobox', { name: 'country' });
    await country.scrollIntoViewIfNeeded();
    await country.selectOption('Japan');
    const colors = page.getByRole('listbox', { name: 'colors' });
    await colors.selectOption(['Green', 'Yellow']);
    await expect(page.getByRole('textbox', { name: 'id' })).toHaveAttribute('readonly', '');
    await expect(page.getByRole('textbox', { name: 'id' })).toHaveValue('A-17');

    // A list has no undo of its own: the document's undo takes back the last choice.
    await colors.focus();
    await page.keyboard.press('Control+Z');
    await expect(colors).toHaveValues([]);
    await page.keyboard.press('Control+Y');
    await expect(colors).toHaveValues(['Green', 'Yellow']);
    await page.getByRole('button', { name: 'Undo fill in colors' }).click();
    await page.getByRole('button', { name: 'Undo fill in country' }).click();
    await expect(country).toHaveValue('');
    await expect(colors).toHaveValues([]);
    await page.getByRole('button', { name: 'Redo fill in country' }).click();
    await page.getByRole('button', { name: 'Redo fill in colors' }).click();
    await expect(country).toHaveValue('Japan');
    await expect(colors).toHaveValues(['Green', 'Yellow']);

    const saved = await download(page, () =>
      page.getByRole('button', { name: 'Download PDF' }).click(),
    );
    expect(await formValues(saved)).toEqual({
      name: 'Ada Lovelace',
      notes: 'Line one\nLine two',
      code: 'ABCDE',
      // Password fields are never saved.
      pin: '',
      agree: true,
      size: 'L',
      country: ['Japan'],
      colors: ['Green', 'Yellow'],
      id: 'A-17',
    });
    expect(await formParts(saved)).toEqual({ form: true, widgets: [8, 4] });

    const flattened = await download(page, async () => {
      await page.getByRole('button', { name: 'More ways to save' }).click();
      await page.getByRole('menuitem', { name: 'Download with form flattened' }).click();
    });
    expect(await formParts(flattened)).toEqual({ form: false, widgets: [0, 0] });
  });

  test('highlights fields on request and signs signature fields with the signature tool', async ({
    page,
  }) => {
    await open(page, 'form-fields.pdf');
    const name = page.getByRole('textbox', { name: 'Full name' });
    const background = () => name.evaluate((input) => getComputedStyle(input).backgroundColor);
    expect(await background()).not.toBe('rgba(0, 0, 0, 0)');
    const highlight = page.getByRole('switch', { name: 'Highlight fields' });
    await highlight.click();
    await expect(highlight).toHaveAttribute('aria-checked', 'false');
    expect(await background()).toBe('rgba(0, 0, 0, 0)');

    // Other tools draw over the fields instead of filling them in.
    await page.keyboard.press('Escape');
    await page
      .getByRole('toolbar', { name: 'Comment and drawing tools' })
      .getByRole('radio', { name: 'Rectangle' })
      .click();
    expect(await name.evaluate((input) => getComputedStyle(input).pointerEvents)).toBe('none');
    await page
      .getByRole('toolbar', { name: 'Comment and drawing tools' })
      .getByRole('radio', { name: 'Select' })
      .click();

    const sign = page.getByRole('button', { name: 'Sign signature' });
    await sign.scrollIntoViewIfNeeded();
    // Pages, and the controls over them, look the same in the dark theme.
    const colors = () =>
      sign.evaluate((button) => {
        const style = getComputedStyle(button);
        return [style.color, style.borderColor, style.backgroundColor];
      });
    const light = await colors();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await colors()).toEqual(light);
    await expectAccessible(page, 'form fields (dark)');
    await sign.click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('saves what was just typed when a shortcut saves from the field', async ({ page }) => {
    await open(page, 'form-fields.pdf');
    const name = page.getByRole('textbox', { name: 'Full name' });
    await name.click();
    await page.keyboard.type('Grace Hopper');
    const saved = await download(page, () => page.keyboard.press('Control+Shift+S'));
    expect((await formValues(saved)).name).toBe('Grace Hopper');
    await expect(name).toBeFocused();
  });

  test('explains XFA forms and leaves them as drawn', async ({ page }) => {
    await open(page, 'xfa-form.pdf');
    await expect(page.getByRole('region', { name: 'Form' })).toHaveText(
      'This form uses XFA, which Folio cannot fill in. Its pages show the form as it was saved.',
    );
    await expect(page.locator('[data-form-layer]')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Properties' })).toContainText(
      'XFA form (not supported)',
    );
    await expectAccessible(page, 'an XFA form');
    // Flattening keeps what the page shows and drops the form, XFA included.
    const flattened = await download(page, async () => {
      await page.getByRole('button', { name: 'More ways to save' }).click();
      await page.getByRole('menuitem', { name: 'Download with form flattened' }).click();
    });
    expect(await formParts(flattened)).toEqual({ form: false, widgets: [0] });
  });
});
