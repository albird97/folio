import { EMPTY_METADATA } from '@folio/document-model';
import type { PdfDocumentHandle, PdfEngine } from '@folio/pdf-core';
import { fakeDocumentHandle } from '@folio/pdf-core/testing';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SidePanel } from './side-panel';

const mocks = vi.hoisted(() => ({
  putHandoff: vi.fn<(name: string, bytes: Uint8Array) => Promise<string>>(),
  deleteHandoff: vi.fn<(id: string) => Promise<void>>(),
  openEditor: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../shared/handoff', () => ({
  putHandoff: mocks.putHandoff,
  deleteHandoff: mocks.deleteHandoff,
}));
vi.mock('../shared/surface', () => ({ openEditor: mocks.openEditor }));
vi.mock('../shared/messages', () => ({ sendMessage: mocks.sendMessage }));
// The current tab's tools talk to Chrome; extension e2e covers them.
vi.mock('./this-tab', () => ({ ThisTab: () => null }));

function fakeHandle(title: string): PdfDocumentHandle {
  return fakeDocumentHandle({
    info: { metadata: { ...EMPTY_METADATA, title } },
    renderPage: () => ({ promise: new Promise<boolean>(() => undefined), cancel: () => undefined }),
    destroy: vi.fn(async () => undefined),
  });
}

/** An engine whose open() calls finish only when the test says so, in any order. */
function controlledEngine() {
  const opens: { resolve: (handle: PdfDocumentHandle) => void; reject: (e: Error) => void }[] = [];
  const engine: PdfEngine = {
    open: vi.fn(
      () =>
        new Promise<PdfDocumentHandle>((resolve, reject) => {
          opens.push({ resolve, reject });
        }),
    ),
    destroy: () => undefined,
  };
  return { engine, opens };
}

function drop(file: File) {
  fireEvent.drop(screen.getByRole('main'), { dataTransfer: { files: [file], types: ['Files'] } });
}

const pdf = (name: string) => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

describe('side panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteHandoff.mockResolvedValue(undefined);
  });

  it('shows the file picked last when an earlier load finishes later', async () => {
    const { engine, opens } = controlledEngine();
    render(<SidePanel engine={engine} />);
    drop(pdf('big.pdf'));
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    drop(pdf('small.pdf'));
    await vi.waitFor(() => expect(opens).toHaveLength(2));

    const small = fakeHandle('Small');
    const big = fakeHandle('Big');
    await act(async () => opens[1]!.resolve(small));
    expect(await screen.findByRole('heading', { name: 'Small' })).toBeTruthy();
    await act(async () => opens[0]!.resolve(big));

    expect(screen.getByRole('heading', { name: 'Small' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Big' })).toBeNull();
    expect(big.destroy).toHaveBeenCalled();
    expect(small.destroy).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inspected', fileName: 'small.pdf' }),
    );
  });

  it('ignores a late failure of a file the user moved away from', async () => {
    const { engine, opens } = controlledEngine();
    render(<SidePanel engine={engine} />);
    drop(pdf('broken.pdf'));
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    drop(pdf('good.pdf'));
    await vi.waitFor(() => expect(opens).toHaveLength(2));
    await act(async () => opens[1]!.resolve(fakeHandle('Good')));
    await act(async () => opens[0]!.reject(new Error('damaged')));
    expect(screen.getByRole('heading', { name: 'Good' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not open a file the user moved away from while it was being read', async () => {
    const { engine, opens } = controlledEngine();
    render(<SidePanel engine={engine} />);
    drop(pdf('first.pdf'));
    drop(pdf('second.pdf'));
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    await act(async () => opens[0]!.resolve(fakeHandle('Second')));
    expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy();
    expect(screen.getByText('second.pdf')).toBeTruthy();
    expect(opens).toHaveLength(1);
  });

  it('deletes the hand-off and explains when the editor does not open', async () => {
    const { engine, opens } = controlledEngine();
    mocks.putHandoff.mockResolvedValue('a'.repeat(32));
    mocks.openEditor.mockResolvedValue({ ok: false, error: 'failed' });
    render(<SidePanel engine={engine} />);
    drop(pdf('report.pdf'));
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    await act(async () => opens[0]!.resolve(fakeHandle('Report')));
    vi.clearAllMocks();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open in editor' })));

    expect(mocks.deleteHandoff).toHaveBeenCalledWith('a'.repeat(32));
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t open the editor');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Open in editor' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('records the hand-off only once the editor opened', async () => {
    const { engine, opens } = controlledEngine();
    mocks.putHandoff.mockResolvedValue('b'.repeat(32));
    mocks.openEditor.mockResolvedValue({ ok: true });
    render(<SidePanel engine={engine} />);
    drop(pdf('report.pdf'));
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    await act(async () => opens[0]!.resolve(fakeHandle('Report')));
    vi.clearAllMocks();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Open in editor' })));

    expect(mocks.openEditor).toHaveBeenCalledWith('b'.repeat(32));
    expect(mocks.deleteHandoff).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'sent-to-editor', fileName: 'report.pdf' }),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
