import { undoLabel, type DocumentStamps } from '@folio/document-model';
import type { PdfEngine, PdfPermissions } from '@folio/pdf-core';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import { createMemoryPlatformAdapter, memoryFile } from '@folio/platform-adapters';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceProvider } from '../../context';
import { createUiStore } from '../../store/ui';
import { createWorkspaceStore } from '../../store/workspace';
import { Dialogs } from '../dialogs';

async function setup(permissions: PdfPermissions | null = null) {
  const handle = fakeDocumentHandle({
    info: {
      pageCount: 12,
      ...(permissions ? { encryption: 'owner-restricted' as const, permissions } : {}),
    },
  });
  const engine: PdfEngine = { open: async () => handle, destroy: () => undefined };
  const { adapter } = createMemoryPlatformAdapter();
  const workspace = createWorkspaceStore(engine);
  const ui = createUiStore(adapter.storage);
  await workspace.getState().openFiles([memoryFile('doc.pdf', new Uint8Array([37, 80, 68, 70]))]);
  const doc = () => workspace.getState().documents[0]!;
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
  const open = (kind: 'page-numbers' | 'watermark') =>
    act(() => ui.getState().openDialog({ kind, docKey: doc().key }));
  const stamps = (): DocumentStamps => doc().editor!.model.stamps;
  const history = () => doc().editor!.history.past.length;
  return { workspace, ui, doc, open, stamps, history };
}

const dialog = (name: string) => screen.getByRole('dialog', { name });
const field = (scope: HTMLElement, name: string) => within(scope).getByLabelText(name);
const set = (element: HTMLElement, value: string) =>
  fireEvent.change(element, { target: { value } });
const choose = (scope: HTMLElement, group: string, option: string) =>
  fireEvent.click(
    within(within(scope).getByRole('radiogroup', { name: group })).getByRole('radio', {
      name: option,
    }),
  );

describe('page numbers dialog', () => {
  it('adds page numbers as set, then changes and removes them through the history', async () => {
    const { open, stamps, doc, history } = await setup();
    open('page-numbers');
    let numbers = dialog('Page numbers');
    expect((field(numbers, 'Format') as HTMLSelectElement).value).toBe('{page}');
    expect(within(numbers).queryByRole('button', { name: 'Remove page numbers' })).toBeNull();
    // Presets show what they look like in this document.
    expect(within(numbers).getByRole('option', { name: 'Page 1 of 12' })).toBeTruthy();

    set(field(numbers, 'Format'), 'Page {page} of {total}');
    choose(numbers, 'Vertical position', 'Top');
    choose(numbers, 'Horizontal position', 'Right');
    set(field(numbers, 'Font'), 'serif');
    set(field(numbers, 'Size'), '12');
    fireEvent.click(within(numbers).getByRole('radio', { name: '#1c7ed6' }));
    set(field(numbers, 'Margin'), '24');
    set(field(numbers, 'First number'), '3');
    set(field(numbers, 'First page'), '2');
    set(field(numbers, 'Last page'), '11');
    expect(within(numbers).getByText('Page 2 shows “Page 3 of 12”')).toBeTruthy();
    fireEvent.click(within(numbers).getByRole('button', { name: 'Apply' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stamps().pageNumbers).toEqual({
      format: 'Page {page} of {total}',
      position: 'top-right',
      fontFamily: 'serif',
      fontSize: 12,
      color: '#1c7ed6',
      margin: 24,
      startNumber: 3,
      pages: { from: 2, to: 11 },
    });
    expect(undoLabel(doc().editor!)).toBe('Add page numbers');

    // Opens with the current settings; applying them unchanged adds nothing to the history.
    open('page-numbers');
    numbers = dialog('Page numbers');
    expect((field(numbers, 'Size') as HTMLInputElement).value).toBe('12');
    expect((field(numbers, 'First page') as HTMLInputElement).value).toBe('2');
    const before = history();
    fireEvent.click(within(numbers).getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(history()).toBe(before);

    open('page-numbers');
    numbers = dialog('Page numbers');
    fireEvent.click(within(numbers).getByRole('radio', { name: 'All pages' }));
    fireEvent.click(within(numbers).getByRole('button', { name: 'Apply' }));
    expect(stamps().pageNumbers?.pages).toEqual({ from: 1, to: null });
    expect(undoLabel(doc().editor!)).toBe('Change page numbers');

    // Tabbing through the range's fields to Apply keeps all pages.
    open('page-numbers');
    numbers = dialog('Page numbers');
    const afterChange = history();
    fireEvent.focus(field(numbers, 'First page'));
    fireEvent.focus(field(numbers, 'Last page'));
    expect(
      (within(numbers).getByRole('radio', { name: 'All pages' }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(numbers).getByRole('button', { name: 'Apply' }));
    expect(stamps().pageNumbers?.pages).toEqual({ from: 1, to: null });
    expect(history()).toBe(afterChange);

    open('page-numbers');
    fireEvent.click(
      within(dialog('Page numbers')).getByRole('button', { name: 'Remove page numbers' }),
    );
    expect(stamps().pageNumbers).toBeNull();
    expect(undoLabel(doc().editor!)).toBe('Remove page numbers');
  });

  it('explains values it cannot use, and does not apply them', async () => {
    const { open, stamps } = await setup();
    open('page-numbers');
    const numbers = dialog('Page numbers');
    const apply = within(numbers).getByRole('button', { name: 'Apply' });

    set(field(numbers, 'Size'), '200');
    expect(within(numbers).getByText('Enter a size from 4 to 72 points.')).toBeTruthy();
    expect(field(numbers, 'Size').getAttribute('aria-invalid')).toBe('true');
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    set(field(numbers, 'Size'), '10');
    expect((apply as HTMLButtonElement).disabled).toBe(false);

    set(field(numbers, 'First number'), '1.5');
    expect(within(numbers).getByText('Enter a whole number from 0 to 99,999.')).toBeTruthy();
    set(field(numbers, 'First number'), '1');

    set(field(numbers, 'First page'), '9');
    set(field(numbers, 'Last page'), '3');
    expect(
      within(numbers).getByText('Enter pages from 1 to 12, the first no later than the last.'),
    ).toBeTruthy();
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    set(field(numbers, 'Last page'), '12');

    // A custom text starts from the format chosen so far.
    set(field(numbers, 'Format'), 'Page {page} of {total}');
    set(field(numbers, 'Format'), 'custom');
    expect((field(numbers, 'Text') as HTMLInputElement).value).toBe('Page {page} of {total}');
    set(field(numbers, 'Text'), '  ');
    expect(within(numbers).getByText(/Enter the text to show/)).toBeTruthy();
    set(field(numbers, 'Text'), '第 {page} 页');
    expect(within(numbers).getByText(/will show as “\?”/)).toBeTruthy();
    fireEvent.click(apply);
    expect(stamps().pageNumbers).toMatchObject({ format: '第 {page} 页', pages: { from: 9 } });
  });

  it('explains documents that do not allow changes, and changes nothing', async () => {
    const { open, stamps } = await setup({
      print: true,
      copy: true,
      modify: false,
      annotate: true,
      fillForms: true,
      assemble: true,
    });
    open('page-numbers');
    const numbers = dialog('Page numbers');
    expect(within(numbers).getByRole('status').textContent).toBe(
      'The author of this document does not allow changing it.',
    );
    // Every field is disabled by the form's fieldset.
    expect(field(numbers, 'Size').matches(':disabled')).toBe(true);
    expect(within(numbers).getByRole('radio', { name: 'Top' }).matches(':disabled')).toBe(true);
    const apply = within(numbers).getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(stamps().pageNumbers).toBeNull();
  });
});

describe('watermark dialog', () => {
  it('adds a watermark with its angle, opacity and layer', async () => {
    const { open, stamps, doc } = await setup();
    open('watermark');
    const watermark = dialog('Watermark');
    set(field(watermark, 'Text'), '机密');
    expect(within(watermark).getByText(/will show as “\?”/)).toBeTruthy();
    set(field(watermark, 'Text'), '');
    expect(within(watermark).getByText('Enter the watermark’s text.')).toBeTruthy();
    set(field(watermark, 'Text'), 'CONFIDENTIAL');
    choose(watermark, 'Vertical position', 'Top');
    set(field(watermark, 'Angle'), '120');
    expect(within(watermark).getByText('Enter an angle from −90° to 90°.')).toBeTruthy();
    set(field(watermark, 'Angle'), '-30');
    set(field(watermark, 'Opacity'), '40');
    choose(watermark, 'Layer', 'Under the content');
    expect(within(watermark).getByText(/such as scans, hide it/)).toBeTruthy();
    fireEvent.click(within(watermark).getByRole('button', { name: 'Apply' }));

    expect(stamps().watermark).toEqual({
      text: 'CONFIDENTIAL',
      position: 'top-center',
      fontFamily: 'sans',
      fontSize: 72,
      color: '#e03131',
      opacity: 0.4,
      angle: -30,
      layer: 'under',
      margin: 36,
      pages: { from: 1, to: null },
    });
    expect(undoLabel(doc().editor!)).toBe('Add watermark');
  });
});
