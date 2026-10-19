import { PDFDocument } from '@cantoo/pdf-lib';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { chooseFiles, expectAccessible, pageRendered } from '../helpers';
import { expect, test } from './fixtures';

/** Runs `action` and returns the bytes of the file it downloads. */
async function download(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForEvent('download');
  await action();
  return readFileSync((await (await pending).path())!);
}

test.describe('extension editor: forms', () => {
  test.beforeEach(async ({ page, extensionUrl }) => {
    await page.goto(extensionUrl('editor.html'));
  });

  test('fills in a form and downloads it with the values', async ({ page }) => {
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'form-fields.pdf',
    ]);
    await pageRendered(page);
    await expect(page.getByRole('region', { name: 'Form' })).toContainText(
      'This document has fields you can fill in.',
    );
    await page.getByRole('textbox', { name: 'Full name' }).fill('Grace Hopper');
    await page.getByRole('checkbox', { name: 'agree' }).click();
    await page
      .getByRole('radiogroup', { name: 'size' })
      .getByRole('radio', { name: 'S', exact: true })
      .click();
    await expectAccessible(page, 'extension editor with a form');

    const bytes = await download(page, () =>
      page.getByRole('button', { name: 'Download PDF' }).click(),
    );
    const form = (await PDFDocument.load(bytes, { updateMetadata: false })).getForm();
    expect(form.getTextField('name').getText()).toBe('Grace Hopper');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
    expect(form.getRadioGroup('size').getSelected()).toBe('S');
  });
});
