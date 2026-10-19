import { chooseFiles, pageRendered } from '../helpers';
import { expect, test } from './fixtures';

test.describe('extension: recognize text', () => {
  test('recognizes text in the editor under the extension’s security policy', async ({
    page,
    context,
    extensionUrl,
  }) => {
    test.setTimeout(120_000);
    // Violations from the first script on, as in the security tests.
    await context.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { folioViolations: seen });
      document.addEventListener('securitypolicyviolation', (event) =>
        seen.push(`${event.effectiveDirective} ${event.blockedURI}`),
      );
    });
    // Recognition must not reach the network: its worker, cores and data are bundled.
    const remote: string[] = [];
    context.on('request', (request) => {
      if (!request.url().startsWith('chrome-extension://')) remote.push(request.url());
    });
    await page.goto(extensionUrl('editor.html'));
    await chooseFiles(page, () => page.getByRole('button', { name: /Choose PDF/ }).click(), [
      'scanned-pages.pdf',
    ]);
    await pageRendered(page);

    await page.getByRole('button', { name: 'Tools' }).click();
    await page.getByRole('menuitem', { name: 'Recognize text (OCR)…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Recognize text' });
    await expect(dialog.getByText('Reads 2 pages.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Recognize text' }).click();
    // The worker started from the extension's own files, with its WebAssembly core.
    await expect(dialog.getByText(/^Found \d+ words on 2 pages\.$/)).toBeVisible({
      timeout: 90_000,
    });
    await dialog.getByRole('button', { name: 'Done' }).click();

    await page.keyboard.press('ControlOrMeta+F');
    const find = page.getByRole('search', { name: 'Find in document' });
    await find.getByRole('searchbox').fill('lighthouse keeper');
    await expect(find.getByRole('status')).toHaveText('1 result');
    // One box per text run: the two words and the space between them.
    await expect(page.locator('[data-page="1"] .folio-hit[data-active]')).toHaveCount(3);

    expect(
      await page.evaluate(
        () => (window as unknown as { folioViolations: string[] }).folioViolations,
      ),
    ).toEqual([]);
    expect(remote).toEqual([]);
  });
});
