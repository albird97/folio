import { PdfError, type PdfEngine, type PdfPermissions } from '@folio/pdf-core';
import type { ExportResult } from '@folio/pdf-core/export';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import { createMemoryPlatformAdapter, memoryFile } from '@folio/platform-adapters';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../../context';
import { createUiStore, type DialogRequest } from '../../store/ui';
import { createWorkspaceStore, type ExportRequest } from '../../store/workspace';
import { Dialogs } from '../dialogs';

const RESTRICTED: PdfPermissions = {
  print: false,
  copy: false,
  modify: false,
  annotate: true,
  fillForms: true,
  assemble: false,
};

/** The dialog loads the exporter (pdf-lib) on first use, which takes a while in a busy test run. */
const LOADING_EXPORTER = { timeout: 10_000 };

const textRun = (str: string) => ({ str, hasEOL: true, transform: [], width: 0, height: 0 });

async function setup({
  pageCount = 3,
  permissions = null,
  encryption = permissions ? 'owner-restricted' : 'none',
  byteLength = 4,
  open,
}: {
  pageCount?: number;
  permissions?: PdfPermissions | null;
  encryption?: 'none' | 'owner-restricted' | 'password-protected';
  byteLength?: number;
  /** Opens bytes other than the document's (copies being checked). */
  open?: (bytes: Uint8Array, password?: string) => Promise<ReturnType<typeof fakeDocumentHandle>>;
} = {}) {
  const handle = fakeDocumentHandle({
    info: { pageCount, encryption, permissions },
    getPageText: async (index) => ({ items: [textRun(`Text of page ${index + 1}`)] }),
  });
  const original = new Uint8Array(byteLength).fill(32);
  original.set([37, 80, 68, 70]);
  const engine: PdfEngine = {
    // The document starts with "%PDF"; copies made in the tests do not.
    open: async (bytes, options) => (bytes[0] === 37 ? handle : open!(bytes, options?.password)),
    destroy: () => undefined,
  };
  const { adapter, saved, clipboard } = createMemoryPlatformAdapter();
  const workspace = createWorkspaceStore(engine);
  const ui = createUiStore(adapter.storage);
  await workspace.getState().openFiles([memoryFile('doc.pdf', original)]);
  const doc = () => workspace.getState().documents[0]!;
  const exports: ExportRequest[] = [];
  /** Exports return `result`, recording what was asked for. */
  const exportReturns = (result: ExportResult) =>
    workspace.setState({
      exportDocument: async (_key, request = {}) => {
        exports.push(request);
        return result;
      },
    });
  render(
    <WorkspaceProvider
      adapter={adapter}
      engine={engine}
      profile="desktop"
      stores={{ workspace, ui }}
    >
      <Dialogs />
    </WorkspaceProvider>,
  );
  const open_ = (kind: Extract<DialogRequest, { docKey: string }>['kind']) =>
    act(() => ui.getState().openDialog({ kind, docKey: doc().key } as DialogRequest));
  return { workspace, ui, doc, open: open_, saved, clipboard, exports, exportReturns };
}

const dialog = (name: string) => screen.getByRole('dialog', { name });

describe('page choices', () => {
  it('offers the pages selected in the pages panel, and checks typed ranges', async () => {
    const { workspace, doc, open } = await setup({ pageCount: 5 });
    const pages = doc().editor!.model.pages;
    act(() => workspace.getState().selectPages(doc().key, [pages[1]!.id, pages[3]!.id]));
    open('export-text');
    const text = dialog('Export text');
    expect(within(text).getByRole('radio', { name: 'Selected pages (2)' })).toHaveProperty(
      'checked',
      true,
    );
    // Typing pages chooses them.
    const range = within(text).getByRole('textbox', { name: 'Pages to export' });
    fireEvent.focus(range);
    fireEvent.change(range, { target: { value: '4-9' } });
    expect(within(text).getByRole('radio', { name: /^Pages/ })).toHaveProperty('checked', true);
    expect(within(text).getByRole('alert').textContent).toBe(
      'Enter pages like 1-3, 5 (from 1 to 5).',
    );
    expect(within(text).getByRole('button', { name: 'Show text' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('export text dialog', () => {
  it('shows the text of the chosen pages to copy or save as a text file', async () => {
    const { open, saved, clipboard, workspace } = await setup();
    open('export-text');
    const text = dialog('Export text');
    fireEvent.click(within(text).getByRole('radio', { name: 'Current page (1)' }));
    fireEvent.click(within(text).getByRole('button', { name: 'Show text' }));
    const area = await within(text).findByRole('textbox', { name: 'Text of the pages' });
    expect((area as HTMLTextAreaElement).value).toBe('Text of page 1');

    fireEvent.click(within(text).getByRole('button', { name: 'Other pages…' }));
    fireEvent.click(within(text).getByRole('radio', { name: 'All 3 pages' }));
    fireEvent.click(within(text).getByRole('button', { name: 'Show text' }));
    await waitFor(() =>
      expect(
        (within(text).getByRole('textbox', { name: 'Text of the pages' }) as HTMLTextAreaElement)
          .value,
      ).toBe('Text of page 1\n\nText of page 2\n\nText of page 3'),
    );
    fireEvent.click(within(text).getByRole('button', { name: 'Copy' }));
    await within(text).findByRole('button', { name: 'Copied' });
    expect(clipboard).toEqual(['Text of page 1\n\nText of page 2\n\nText of page 3']);
    fireEvent.click(within(text).getByRole('button', { name: 'Save as .txt…' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe('doc (text).txt');
    expect(saved[0]!.kind).toBe('text');
    expect(new TextDecoder().decode(saved[0]!.bytes)).toBe(
      'Text of page 1\n\nText of page 2\n\nText of page 3',
    );
    expect(workspace.getState().notice?.message).toBe('Saved doc (text).txt.');
  });

  it('is not available when the author does not allow copying', async () => {
    const { open } = await setup({ permissions: RESTRICTED });
    open('export-text');
    const text = dialog('Export text');
    expect(
      within(text).getByText('The author of this document does not allow copying its content.'),
    ).toBeTruthy();
    expect(within(text).getByRole('button', { name: 'Show text' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('export images dialog', () => {
  it('keeps to the pages it can hold in memory, and to the author’s permissions', async () => {
    const many = await setup({ pageCount: 301 });
    many.open('export-images');
    const images = dialog('Export pages as images');
    expect(within(images).getByRole('alert').textContent).toBe('Choose up to 300 pages at a time.');
    expect(within(images).getByRole('button', { name: 'Export…' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(images).getByRole('radio', { name: 'Current page (1)' }));
    expect(within(images).queryByRole('alert')).toBeNull();
    expect(within(images).getByText('Saved as one image.')).toBeTruthy();
    expect(within(images).getByRole('button', { name: 'Export…' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('is not available when the author does not allow copying', async () => {
    const { open } = await setup({ permissions: RESTRICTED });
    open('export-images');
    const images = dialog('Export pages as images');
    expect(
      within(images).getByText('The author of this document does not allow copying its content.'),
    ).toBeTruthy();
    expect(within(images).getByRole('button', { name: 'Export…' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('reduce file size dialog', () => {
  it('makes a smaller copy with the chosen preset and saves it', async () => {
    const { open, saved, exports, exportReturns, workspace } = await setup({ byteLength: 4096 });
    exportReturns({ bytes: new Uint8Array(1024).fill(1), warnings: [] });
    open('reduce-file-size');
    const reduce = dialog('Reduce file size');
    expect(within(reduce).getByRole('radio', { name: 'Balanced' })).toHaveProperty('checked', true);
    fireEvent.click(within(reduce).getByRole('radio', { name: 'Small' }));
    fireEvent.click(within(reduce).getByRole('button', { name: 'Reduce file size' }));
    expect(
      (
        await within(reduce).findByText('4.0 KB → 1.0 KB (−75%)', {}, LOADING_EXPORTER)
      ).getAttribute('role'),
    ).toBe('status');
    expect(exports[0]!.compression?.images).toEqual({ maxSize: 1400, quality: 0.65 });
    // The document is not saved over, and keeps its protection: only compression is asked for.
    expect(exports[0]!.protection).toBeUndefined();
    fireEvent.click(within(reduce).getByRole('button', { name: 'Save as…' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saved.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'doc (compressed).pdf', kind: 'pdf' },
    ]);
    expect(workspace.getState().notice?.message).toBe('Saved doc (compressed).pdf.');
  });

  it('compares with the document as it is now, not as it was opened', async () => {
    // A small scan that grew with a large added image.
    const { open, workspace, doc, exports } = await setup({ byteLength: 46 * 1024 });
    const firstPage = doc().editor!.model.pages[0]!.id;
    act(() => workspace.getState().rotatePages(doc().key, [firstPage], 90));
    workspace.setState({
      exportDocument: async (_key, request = {}) => {
        exports.push(request);
        return {
          bytes: new Uint8Array((request.compression ? 250 : 1536) * 1024),
          warnings: [],
        };
      },
    });
    open('reduce-file-size');
    const reduce = dialog('Reduce file size');
    fireEvent.click(within(reduce).getByRole('radio', { name: 'Small' }));
    fireEvent.click(within(reduce).getByRole('button', { name: 'Reduce file size' }));
    await within(reduce).findByText('1.5 MB → 250 KB (−84%)', {}, LOADING_EXPORTER);
    // First as saving would write it, then compressed.
    expect(exports.map((request) => request.compression?.images ?? null)).toEqual([
      null,
      { maxSize: 1400, quality: 0.65 },
    ]);
    expect(within(reduce).getByRole('button', { name: 'Save as…' })).toBeTruthy();
  });

  it('says when a changed document cannot get smaller', async () => {
    const { open, workspace, doc, exportReturns } = await setup({ byteLength: 46 * 1024 });
    const firstPage = doc().editor!.model.pages[0]!.id;
    act(() => workspace.getState().rotatePages(doc().key, [firstPage], 90));
    // Compressing gains nothing over saving as it is.
    exportReturns({ bytes: new Uint8Array(1536 * 1024), warnings: [] });
    open('reduce-file-size');
    const reduce = dialog('Reduce file size');
    fireEvent.click(within(reduce).getByRole('button', { name: 'Reduce file size' }));
    await within(reduce).findByText(
      'This document is already as small as Folio can make it.',
      {},
      LOADING_EXPORTER,
    );
    expect(within(reduce).queryByRole('button', { name: 'Save as…' })).toBeNull();
  });

  it('says when a document cannot get smaller, and keeps images the author protects', async () => {
    const { open, exports, exportReturns } = await setup({
      byteLength: 1024,
      permissions: RESTRICTED,
    });
    exportReturns({ bytes: new Uint8Array(2048), warnings: [] });
    open('reduce-file-size');
    const reduce = dialog('Reduce file size');
    expect(within(reduce).getByRole('radio', { name: 'High quality' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(reduce).getByRole('radio', { name: 'Balanced' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(reduce).getByRole('button', { name: 'Reduce file size' }));
    await within(reduce).findByText(
      'This document is already as small as Folio can make it.',
      {},
      LOADING_EXPORTER,
    );
    expect(exports[0]!.compression?.images).toBeNull();
    expect(within(reduce).queryByRole('button', { name: 'Save as…' })).toBeNull();
  });
});

describe('password protection dialog', () => {
  /** A copy that asks for `password` and then allows `permissions`. */
  const protectedCopy = (password: string, permissions: PdfPermissions, pageCount = 3) =>
    vi.fn(async (_bytes: Uint8Array, given?: string) => {
      if (given === undefined) throw new PdfError('password-required');
      if (given !== password) throw new PdfError('incorrect-password');
      return fakeDocumentHandle({
        info: { pageCount, encryption: 'password-protected', permissions },
      });
    });

  const fill = (scope: HTMLElement, label: string, value: string) =>
    fireEvent.change(within(scope).getByLabelText(label, { exact: true }), { target: { value } });

  it('saves a checked copy that needs a password and restricts printing', async () => {
    const opened = protectedCopy('lighthouse keeper', { ...RESTRICTED, print: true });
    const { open, saved, exports, exportReturns, workspace } = await setup({ open: opened });
    exportReturns({ bytes: new Uint8Array([9, 9, 9]), warnings: [] });
    open('protect');
    const protect = dialog('Password protection');
    expect(within(protect).getByText('This document is not protected.')).toBeTruthy();
    const save = within(protect).getByRole('button', { name: 'Save protected copy…' });
    expect(save).toHaveProperty('disabled', true);

    fill(protect, 'Password', 'lighthouse keeper');
    fill(protect, 'Confirm password', 'lighthouse');
    expect(within(protect).getByRole('alert').textContent).toBe('The passwords do not match.');
    expect(save).toHaveProperty('disabled', true);
    fill(protect, 'Confirm password', 'lighthouse keeper');
    expect(within(protect).getByText('Strong.')).toBeTruthy();
    fireEvent.click(
      within(protect).getByRole('checkbox', { name: 'Restrict printing, copying and changes' }),
    );
    fireEvent.click(within(protect).getByRole('checkbox', { name: 'Printing' }));
    fireEvent.click(within(protect).getByRole('checkbox', { name: 'Adding comments' }));
    fireEvent.click(within(protect).getByRole('checkbox', { name: 'Filling in forms' }));
    fill(protect, 'Permissions password (optional)', 'lighthouse keeper');
    expect(
      within(protect).getByText('Use a different password from the one to open the document.'),
    ).toBeTruthy();
    expect(save).toHaveProperty('disabled', true);
    fill(protect, 'Permissions password (optional)', 'harbour master');
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(exports).toEqual([
      {
        protection: {
          userPassword: 'lighthouse keeper',
          ownerPassword: 'harbour master',
          permissions: { ...RESTRICTED, print: true },
        },
      },
    ]);
    // Checked by opening it: without the password first, then with it.
    expect(opened.mock.calls.map(([, password]) => password)).toEqual([
      undefined,
      'lighthouse keeper',
    ]);
    expect(saved.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'doc (protected).pdf', kind: 'pdf' },
    ]);
    expect(workspace.getState().notice?.message).toBe('Saved doc (protected).pdf.');
  });

  it('does not save a copy that is not protected as chosen', async () => {
    // The copy turns out to allow everything.
    const opened = protectedCopy('lighthouse keeper', {
      ...RESTRICTED,
      copy: true,
      modify: true,
      print: true,
      assemble: true,
    });
    const { open, saved, exportReturns } = await setup({ open: opened });
    exportReturns({ bytes: new Uint8Array([9, 9, 9]), warnings: [] });
    open('protect');
    const protect = dialog('Password protection');
    fill(protect, 'Password', 'lighthouse keeper');
    fill(protect, 'Confirm password', 'lighthouse keeper');
    fireEvent.click(
      within(protect).getByRole('checkbox', { name: 'Restrict printing, copying and changes' }),
    );
    fireEvent.click(within(protect).getByRole('button', { name: 'Save protected copy…' }));
    expect(
      (
        await within(protect).findByText(
          'Folio could not confirm that the copy is protected as chosen, so it was not saved.',
        )
      ).closest('[role="alert"]'),
    ).toBeTruthy();
    expect(saved).toEqual([]);
  });

  it('keeps the author’s restrictions, which cannot be removed', async () => {
    const { open } = await setup({ permissions: RESTRICTED });
    open('protect');
    const protect = dialog('Password protection');
    expect(
      within(protect).getByRole('radio', { name: 'Remove password protection' }),
    ).toHaveProperty('disabled', true);
    expect(
      within(protect).getByText(
        'Only the author can remove its restrictions, with the permissions password.',
      ),
    ).toBeTruthy();
    const restrict = within(protect).getByRole('checkbox', {
      name: 'Restrict printing, copying and changes',
    });
    expect(restrict).toHaveProperty('checked', true);
    expect(restrict).toHaveProperty('disabled', true);
    // What the author allows starts allowed; what they restrict stays restricted.
    const printing = within(protect).getByRole('checkbox', { name: 'Printing' });
    expect(printing).toHaveProperty('checked', false);
    expect(printing).toHaveProperty('disabled', true);
    expect(within(protect).getByRole('checkbox', { name: 'Adding comments' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(protect).queryByLabelText('Permissions password (optional)')).toBeNull();
  });

  it('removes the password of a document opened with it', async () => {
    const allowed = {
      print: true,
      copy: true,
      modify: true,
      annotate: true,
      fillForms: true,
      assemble: true,
    };
    const opened = vi.fn(async () =>
      fakeDocumentHandle({ info: { pageCount: 3, encryption: 'none', permissions: null } }),
    );
    const { open, saved, exports, exportReturns } = await setup({
      encryption: 'password-protected',
      permissions: allowed,
      open: opened,
    });
    exportReturns({ bytes: new Uint8Array([9, 9, 9]), warnings: [] });
    open('protect');
    const protect = dialog('Password protection');
    expect(within(protect).getByText('This document needs a password to open.')).toBeTruthy();
    fireEvent.click(within(protect).getByRole('radio', { name: 'Remove password protection' }));
    fireEvent.click(within(protect).getByRole('button', { name: 'Save without protection…' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(exports).toEqual([{ protection: 'none' }]);
    expect(saved.map(({ name }) => name)).toEqual(['doc (unprotected).pdf']);
  });
});
