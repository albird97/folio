import {
  newAnnotationId,
  undoLabel,
  type FormFieldDescriptor,
  type SourceId,
} from '@folio/document-model';
import type { FormWidget, PdfDocumentInfo, PdfEngine } from '@folio/pdf-core';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import { createMemoryPlatformAdapter, memoryFile } from '@folio/platform-adapters';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspace, useWorkspaceContext, WorkspaceProvider } from '../context';
import { PERMISSION_MESSAGES } from '../store/editing';
import { createUiStore, type Tool } from '../store/ui';
import { createWorkspaceStore } from '../store/workspace';
import { FormLayer } from './form-layer';

const FIELDS: FormFieldDescriptor[] = [
  { name: 'person.name', type: 'text', pageIndex: 0, value: '', readOnly: false },
  { name: 'notes', type: 'text', pageIndex: 0, value: '', readOnly: false },
  { name: 'pin', type: 'text', pageIndex: 0, value: '', readOnly: false },
  { name: 'agree', type: 'checkbox', pageIndex: 0, value: false, readOnly: false },
  { name: 'size', type: 'radio', pageIndex: 0, value: null, readOnly: false },
  { name: 'country', type: 'choice', pageIndex: 0, value: null, readOnly: false },
  { name: 'colors', type: 'choice', pageIndex: 0, value: ['Red'], readOnly: false },
  { name: 'id', type: 'text', pageIndex: 0, value: 'A-17', readOnly: true },
  { name: 'signature', type: 'signature', pageIndex: 0, value: null, readOnly: false },
  { name: 'submit', type: 'button', pageIndex: 0, value: null, readOnly: false },
  { name: 'secret', type: 'text', pageIndex: 0, value: 'kept', readOnly: false },
];

let next = 0;
const base = (fieldName: string, description = '') => ({
  id: `${(next += 1)}R`,
  fieldName,
  rect: { x: 72, y: 700 - next * 40, width: 200, height: 24 },
  rotation: 0 as const,
  hidden: false,
  description,
});
const text = (fieldName: string, extra: Partial<Extract<FormWidget, { type: 'text' }>> = {}) =>
  ({
    ...base(fieldName),
    type: 'text',
    multiLine: false,
    password: false,
    comb: false,
    maxLength: null,
    alignment: 'left',
    fontSize: 12,
    color: '#000000',
    ...extra,
  }) as FormWidget;
const choice = (fieldName: string, combo: boolean, multiSelect: boolean): FormWidget => ({
  ...base(fieldName),
  type: 'choice',
  combo,
  multiSelect,
  options: ['Red', 'Green', 'Blue'].map((value) => ({ value, label: `${value} colour` })),
  fontSize: 12,
  color: '#000000',
});

const WIDGETS: FormWidget[] = [
  text('person.name', { description: 'Full name', maxLength: 20 }),
  text('notes', { multiLine: true }),
  text('pin', { password: true }),
  { ...base('agree'), type: 'checkbox', exportValue: 'Yes' },
  ...['S', 'M', 'L'].map((exportValue): FormWidget => ({
    ...base('size'),
    type: 'radio',
    exportValue,
  })),
  choice('country', true, false),
  choice('colors', false, true),
  text('id'),
  { ...base('signature'), type: 'signature' },
  { ...base('submit'), type: 'button' },
  { ...text('secret'), hidden: true },
  text('not-a-field'),
];

async function setup({
  permissions = null,
  tool = 'select',
}: { permissions?: PdfDocumentInfo['permissions']; tool?: Tool } = {}) {
  const setFormValues = vi.fn(() => [0]);
  const handle = fakeDocumentHandle({
    info: {
      forms: 'acroform',
      ...(permissions ? { permissions, encryption: 'owner-restricted' as const } : {}),
    },
    getFormFields: async () => FIELDS,
    getFormWidgets: async () => WIDGETS,
    setFormValues,
  });
  const engine: PdfEngine = { open: async () => handle, destroy: () => undefined };
  const { adapter } = createMemoryPlatformAdapter();
  const workspace = createWorkspaceStore(engine);
  const ui = createUiStore(adapter.storage);
  await workspace.getState().openFiles([memoryFile('form.pdf', new Uint8Array([37, 80, 68, 70]))]);
  const key = workspace.getState().documents[0]!.key;
  const field = (name: string) =>
    Object.values(workspace.getState().documents[0]!.editor!.model.formFields).find(
      (entry) => entry.name === name,
    )!;

  function Layer() {
    const doc = useWorkspace((state) => state.documents[0]!);
    const { workspace: store } = useWorkspaceContext();
    const model = doc.editor!.model;
    const sourceId = Object.keys(model.sources)[0] as SourceId;
    return (
      <FormLayer
        doc={doc}
        page={model.pages[0]!}
        position={0}
        pageCount={1}
        box={BOX}
        scale={1}
        viewRotation={0}
        handle={store.getSourceHandle(doc.key, sourceId)}
        tool={tool}
      />
    );
  }
  // The same provider throughout: the page can leave the screen and come back.
  const tree = (shown: boolean) => (
    <WorkspaceProvider
      adapter={adapter}
      engine={engine}
      profile="desktop"
      stores={{ workspace, ui }}
    >
      {shown ? <Layer /> : null}
    </WorkspaceProvider>
  );
  const view = render(tree(true));
  await screen.findByRole('textbox', { name: 'Full name' });
  const show = (shown: boolean) => view.rerender(tree(shown));
  return { workspace, ui, key, field, setFormValues, view, show };
}

const BOX = { top: 0, left: 0, width: 612, height: 792 };

describe('form layer', () => {
  it('puts a named control over every widget that can be filled in, in page order', async () => {
    const { view } = await setup();
    const layer = view.container.querySelector('[data-form-layer="1"]')!;
    expect(
      Array.from(layer.querySelectorAll('input, textarea, select, button'), (element) => [
        element.getAttribute('role') ?? element.tagName.toLowerCase(),
        element.getAttribute('aria-label'),
      ]),
    ).toEqual([
      ['input', 'Full name'],
      ['textarea', 'notes'],
      ['input', 'pin'],
      ['checkbox', 'agree'],
      ['radio', 'S'],
      ['radio', 'M'],
      ['radio', 'L'],
      ['select', 'country'],
      ['select', 'colors'],
      ['input', 'id'],
      ['button', 'Sign signature'],
    ]);
    expect(screen.getByRole('radiogroup', { name: 'size' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Full name' }).getAttribute('maxlength')).toBe('20');
    expect(screen.getByLabelText('pin').getAttribute('type')).toBe('password');
    expect(screen.getByRole('textbox', { name: 'id' }).hasAttribute('readonly')).toBe(true);
    expect((screen.getByRole('listbox', { name: 'colors' }) as HTMLSelectElement).multiple).toBe(
      true,
    );
    // Boxes sit where the widgets are (page space, y up → screen, y down).
    const name = screen.getByRole('textbox', { name: 'Full name' });
    expect([name.style.left, name.style.top, name.style.width]).toEqual(['72px', '108px', '200px']);
  });

  it('fills in text as it is typed, one undo step per field; Escape restores it', async () => {
    const { workspace, key, field, setFormValues } = await setup();
    const name = screen.getByRole('textbox', { name: 'Full name' }) as HTMLInputElement;
    act(() => name.focus());
    fireEvent.change(name, { target: { value: 'Ada' } });
    // Nothing waits: a save started by a shortcut or a menu right now has it.
    expect(field('person.name').value).toBe('Ada');
    expect(setFormValues).toHaveBeenLastCalledWith([['person.name', 'Ada']]);
    fireEvent.change(name, { target: { value: 'Ada Lovelace' } });
    expect(name.value).toBe('Ada Lovelace');
    const editor = () => workspace.getState().documents[0]!.editor!;
    expect(editor().history.past).toHaveLength(1);
    expect(undoLabel(editor())).toBe('Fill in Full name');

    fireEvent.keyDown(name, { key: 'Escape' });
    expect(field('person.name').value).toBe('');
    expect(name.value).toBe('');
    fireEvent.change(name, { target: { value: 'Grace' } });
    act(() => name.blur());
    expect(field('person.name').value).toBe('Grace');
    // All of it was typing into one field: one undo goes back to the file's value.
    act(() => workspace.getState().undo(key));
    expect(field('person.name').value).toBe('');
    expect(name.value).toBe('');
  });

  it('ticks check boxes, chooses radio buttons and options', async () => {
    const { field } = await setup();
    fireEvent.click(screen.getByRole('checkbox', { name: 'agree' }));
    expect(field('agree').value).toBe(true);
    expect(screen.getByRole('checkbox', { name: 'agree' }).getAttribute('aria-checked')).toBe(
      'true',
    );

    // One Tab stop for the group; arrow keys move and choose.
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.click(radios[1]!);
    expect(field('size').value).toBe('M');
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    fireEvent.keyDown(radios[1]!, { key: 'ArrowRight' });
    expect(field('size').value).toBe('L');
    expect(document.activeElement).toBe(radios[2]);
    fireEvent.keyDown(radios[2]!, { key: 'ArrowDown' });
    expect(field('size').value).toBe('S');

    fireEvent.change(screen.getByRole('combobox', { name: 'country' }), {
      target: { value: 'Blue' },
    });
    expect(field('country').value).toBe('Blue');
    const colors = screen.getByRole('listbox', { name: 'colors' }) as HTMLSelectElement;
    for (const option of Array.from(colors.options)) option.selected = option.value !== 'Red';
    fireEvent.change(colors);
    expect(field('colors').value).toEqual(['Green', 'Blue']);
  });

  it('keeps what is typed into password fields out of the document', async () => {
    const { workspace, field, show, setFormValues } = await setup();
    const pin = screen.getByLabelText('pin') as HTMLInputElement;
    fireEvent.change(pin, { target: { value: '1234' } });
    act(() => pin.blur());
    expect(field('pin').value).toBe('');
    expect(setFormValues).not.toHaveBeenCalled();
    expect(workspace.getState().documents[0]!.editor!.history.past).toHaveLength(0);
    // The page can scroll away and back while the document is open.
    show(false);
    expect(screen.queryByLabelText('pin')).toBeNull();
    show(true);
    expect(((await screen.findByLabelText('pin')) as HTMLInputElement).value).toBe('1234');
  });

  it('opens the signature tool for a signature field, until it is signed', async () => {
    const { ui, key, workspace } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Sign signature' }));
    const page = workspace.getState().documents[0]!.editor!.model.pages[0]!;
    const rect = WIDGETS[10]!.rect;
    expect(ui.getState().dialog).toEqual({
      kind: 'signature',
      docKey: key,
      field: { pageId: page.id, rect },
    });
    // A signature placed in the field shows instead of the button.
    const asset = await workspace
      .getState()
      .registerImage(key, new Uint8Array([137, 80, 78, 71]), 'image/png');
    act(() => {
      workspace.getState().addAnnotations(
        key,
        [
          {
            id: newAnnotationId(),
            pageId: page.id,
            author: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            modifiedAt: '2026-01-01T00:00:00.000Z',
            color: '#000000',
            opacity: 1,
            kind: 'signature',
            rect: { x: rect.x + 10, y: rect.y + 4, width: 120, height: 16 },
            assetId: asset!.id,
            rotation: 0,
          },
        ],
        { label: 'Add signature', assets: [asset!] },
      );
    });
    expect(screen.queryByRole('button', { name: 'Sign signature' })).toBeNull();
    act(() => workspace.getState().undo(key));
    expect(screen.getByRole('button', { name: 'Sign signature' })).toBeTruthy();
  });

  it('shows fields without changing them when the document does not allow filling them in', async () => {
    const { workspace, field } = await setup({
      permissions: {
        print: true,
        copy: true,
        modify: false,
        annotate: false,
        fillForms: false,
        assemble: false,
      },
    });
    expect(screen.getByRole('textbox', { name: 'Full name' }).hasAttribute('readonly')).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'agree' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: /^Sign/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Full name' }), {
      target: { value: 'Ada' },
    });
    act(() => screen.getByRole('textbox', { name: 'Full name' }).blur());
    expect(field('person.name').value).toBe('');
    expect(workspace.getState().notice).toBeNull();
    // The store refuses too, and says why.
    const id = field('person.name').id;
    expect(
      workspace.getState().fillFormField(workspace.getState().documents[0]!.key, id, 'x'),
    ).toBe(false);
    expect(workspace.getState().notice?.message).toBe(PERMISSION_MESSAGES.fillForms);
  });
});
