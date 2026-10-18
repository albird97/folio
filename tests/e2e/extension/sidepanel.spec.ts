import { chooseFiles, expectAccessible, pageRendered } from '../helpers';
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
});
