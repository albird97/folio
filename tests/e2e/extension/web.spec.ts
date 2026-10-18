import { pageRendered } from '../helpers';
import { expect, stubPermissions, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Opening PDFs from the web: the editor's dialog, the toolbar popup and the
 * side panel, with downloads made by the real service worker from a local
 * server. Chrome's permission prompts and the activeTab grant (a click on
 * the toolbar button) cannot be automated, so those calls are stubbed.
 */

async function openFromAddress(page: Page, url: string) {
  const dialog = page.getByRole('dialog', { name: 'Open from a web address' });
  if (!(await dialog.isVisible())) {
    await page.getByRole('button', { name: 'Open from a web address…' }).click();
  }
  await dialog.getByRole('textbox', { name: 'Address of the PDF' }).fill(url);
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  return dialog;
}

/** Pretends the toolbar button was clicked on a tab showing `url` (activeTab). */
function stubActiveTab(url: string, scan: unknown) {
  return `(() => {
    if (!globalThis.chrome?.tabs || location.pathname.endsWith('editor.html')) return;
    globalThis.folioScripts = [];
    chrome.tabs.query = async () => [{ id: 4242, url: ${JSON.stringify(url)} }];
    chrome.scripting.executeScript = async (options) => {
      const source = String(options.func);
      globalThis.folioScripts.push(source.includes('querySelectorAll') ? 'scan' : 'print');
      // Kept where the test can read it after the popup closes itself.
      await chrome.storage.session.set({ folioScripts: globalThis.folioScripts });
      if (source.includes('querySelectorAll')) {
        const scan = ${JSON.stringify(scan)};
        if (!scan) throw new Error('Cannot access contents of the page.');
        return [{ result: scan }];
      }
      return [{ result: undefined }];
    };
  })();`;
}

test.describe('opening PDFs from the web', () => {
  test('opens a web address once Chrome grants access to the site', async ({
    page,
    context,
    extensionUrl,
    pdfServer,
  }) => {
    await context.addInitScript(stubPermissions({ allow: true }));
    await page.goto(extensionUrl('editor.html'));
    await openFromAddress(page, pdfServer.url('/files/basic-3-pages.pdf#page=2'));
    await pageRendered(page);
    await expect(page.getByRole('toolbar').getByRole('heading')).toHaveText('Folio Basic Fixture');
    await expect(
      page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', {
        name: /^basic-3-pages\.pdf/,
      }),
    ).toBeVisible();
    // Downloaded without cookies or a referrer, and without the fragment.
    const [request] = pdfServer.requests;
    expect(request?.path).toBe('/files/basic-3-pages.pdf');
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers.referer).toBeUndefined();
  });

  test('names files as the server does and explains what fails', async ({
    page,
    context,
    extensionUrl,
    pdfServer,
  }) => {
    await context.addInitScript(stubPermissions({ allow: true }));
    await page.goto(extensionUrl('editor.html'));
    let dialog = await openFromAddress(page, pdfServer.url('/missing.pdf'));
    await expect(dialog.getByRole('alert')).toHaveText(
      'There is no file at that address on 127.0.0.1.',
    );
    dialog = await openFromAddress(page, pdfServer.url('/notes.txt'));
    await expect(dialog.getByRole('alert')).toHaveText('The file at that address is not a PDF.');
    dialog = await openFromAddress(page, 'file:///etc/hosts');
    await expect(dialog.getByRole('alert')).toHaveText(
      'Folio can only open web addresses that start with https:// or http://.',
    );
    dialog = await openFromAddress(page, pdfServer.url('/download?id=7'));
    await expect(dialog).toHaveCount(0);
    await pageRendered(page);
    await expect(
      page.getByRole('navigation', { name: 'Open documents' }).getByRole('button', {
        name: /^Résumé\.pdf/,
      }),
    ).toBeVisible();
  });

  test('asks before sending the browser’s sign-in for a site', async ({
    page,
    context,
    extensionUrl,
    pdfServer,
  }) => {
    await context.addInitScript(stubPermissions({ allow: true }));
    await page.goto(extensionUrl('editor.html'));
    const dialog = await openFromAddress(page, pdfServer.url('/private/report.pdf'));
    const consent = dialog.getByRole('alert');
    await expect(consent).toContainText('sent a web page, not a PDF');
    await expect(consent).toContainText('sends your cookies for 127.0.0.1 with this one request');
    expect(pdfServer.requests).toHaveLength(1);
    await consent.getByRole('button', { name: 'Try again with my sign-in' }).click();
    // Still a web page with the sign-in: now it is simply not a PDF.
    await expect(dialog.getByRole('alert')).toContainText('To keep a web page as a PDF');
    expect(pdfServer.requests).toHaveLength(2);
  });

  test('downloads nothing when access to the site is refused', async ({
    page,
    context,
    extensionUrl,
    pdfServer,
  }) => {
    await context.addInitScript(stubPermissions({ allow: false }));
    await page.goto(extensionUrl('editor.html'));
    const dialog = await openFromAddress(page, pdfServer.url('/files/basic-3-pages.pdf'));
    await expect(dialog.getByRole('status')).toHaveText(
      'Folio was not given access to 127.0.0.1, so nothing was downloaded.',
    );
    expect(pdfServer.requests).toHaveLength(0);
  });

  test('the toolbar popup opens the tab’s PDF in a new editor tab', async ({
    page,
    context,
    extensionUrl,
    pdfServer,
  }) => {
    const pdfUrl = pdfServer.url('/files/basic-3-pages.pdf');
    await context.addInitScript(stubPermissions({ allow: true }));
    // Chrome's PDF viewer does not let extensions read the page.
    await context.addInitScript(stubActiveTab(pdfUrl, null));
    await page.goto(extensionUrl('popup.html'));
    const tab = page.getByRole('region', { name: /^This tab/ });
    await expect(tab).toContainText('127.0.0.1');
    const editorPromise = context.waitForEvent('page');
    await tab.getByRole('button', { name: /Open this PDF in Folio/ }).click();
    const editor = await editorPromise;
    await pageRendered(editor);
    await expect(editor.getByRole('toolbar').getByRole('heading')).toHaveText(
      'Folio Basic Fixture',
    );
    // The address went through session storage, not the editor's URL, and is gone.
    expect(editor.url()).toMatch(/editor\.html$/);
    const left = await editor.evaluate(() => chrome.storage.session.get(null).then(Object.keys));
    expect(left.filter((key) => key.startsWith('open-url:'))).toEqual([]);
  });

  test('the popup prints web pages through Chrome’s print dialog', async ({
    page,
    context,
    extensionUrl,
    pdfServer,
    serviceWorker,
  }) => {
    await context.addInitScript(
      stubActiveTab(pdfServer.url('/article.html'), {
        contentType: 'text/html',
        links: [],
      }),
    );
    await page.goto(extensionUrl('popup.html'));
    const tab = page.getByRole('region', { name: /^This tab/ });
    await expect(tab.getByRole('button', { name: /Open this PDF/ })).toHaveCount(0);
    const closed = page.waitForEvent('close');
    await tab.getByRole('button', { name: /Save page as PDF/ }).click();
    // The print dialog opens in the tab and the popup closes itself.
    await closed;
    expect(
      await serviceWorker.evaluate(() =>
        chrome.storage.session.get('folioScripts').then((items) => items.folioScripts),
      ),
    ).toEqual(['scan', 'print']);
  });

  test('the side panel lists PDFs on the page to open or download', async ({
    page,
    context,
    extensionUrl,
    pdfServer,
  }) => {
    const pdfUrl = pdfServer.url('/files/basic-3-pages.pdf');
    await context.addInitScript(stubPermissions({ allow: true }));
    await context.addInitScript(
      stubActiveTab(pdfServer.url('/reports.html'), {
        contentType: 'text/html',
        links: [{ url: pdfUrl, text: 'Annual report' }],
      }),
    );
    await page.goto(extensionUrl('sidepanel.html'));
    const list = page.getByRole('list', { name: 'PDFs on this page' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('Annual report');
    await list.getByRole('button', { name: 'Download Annual report' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (globalThis as unknown as { folioDownloads: unknown[] }).folioDownloads,
        ),
      )
      .toEqual([{ url: pdfUrl, saveAs: true }]);

    const editorPromise = context.waitForEvent('page');
    await list.getByRole('button', { name: 'Open Annual report' }).click();
    const editor = await editorPromise;
    await pageRendered(editor);
    await expect(editor.getByRole('toolbar').getByRole('heading')).toHaveText(
      'Folio Basic Fixture',
    );
  });
});
