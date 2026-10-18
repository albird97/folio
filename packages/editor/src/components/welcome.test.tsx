import { createMemoryPlatformAdapter, memoryFile, type RecentFile } from '@folio/platform-adapters';
import type { PdfEngine } from '@folio/pdf-core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context';
import { createUiStore } from '../store/ui';
import { createWorkspaceStore } from '../store/workspace';
import { Welcome } from './welcome';

/** Never finishes opening: the test only checks which file was asked for. */
const pendingEngine: PdfEngine = {
  open: () => new Promise(() => undefined),
  destroy: () => undefined,
};

function setup(initial: RecentFile[]) {
  let files = [...initial];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  const recentFiles = {
    list: vi.fn(async () => files),
    open: vi.fn(async (id: string) => [
      memoryFile(files.find((file) => file.id === id)!.name, new Uint8Array([1])),
    ]),
    remove: vi.fn(async (id: string) => {
      files = files.filter((file) => file.id !== id);
      changed();
    }),
    clear: vi.fn(async () => {
      files = [];
      changed();
    }),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const adapter = { ...createMemoryPlatformAdapter({ recentFiles: true }).adapter, recentFiles };
  const workspace = createWorkspaceStore(pendingEngine);
  render(
    <WorkspaceProvider
      adapter={adapter}
      engine={pendingEngine}
      profile="desktop"
      stores={{ workspace, ui: createUiStore(adapter.storage) }}
    >
      <Welcome onOpen={() => undefined} hovering={false} />
    </WorkspaceProvider>,
  );
  return { recentFiles, workspace };
}

const file = (id: string, name: string): RecentFile => ({
  id,
  name,
  openedAt: '2026-10-01T09:00:00.000Z',
});

describe('recent files on the start screen', () => {
  it('lists recent files by name and reopens one', async () => {
    const { recentFiles, workspace } = setup([file('a', 'Budget.pdf'), file('b', 'Notes.pdf')]);
    const list = await screen.findByRole('list');
    expect(list.textContent).toContain('Budget.pdf');
    expect(list.textContent).toContain('Notes.pdf');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Notes\.pdf/ }));
    });
    expect(recentFiles.open).toHaveBeenCalledWith('b');
    expect(workspace.getState().documents.map((doc) => doc.fileName)).toEqual(['Notes.pdf']);
  });

  it('removes one file or clears the list', async () => {
    const { recentFiles } = setup([file('a', 'Budget.pdf'), file('b', 'Notes.pdf')]);
    await screen.findByRole('list');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Budget.pdf from recent files' }));
    });
    expect(recentFiles.remove).toHaveBeenCalledWith('a');
    expect(screen.queryByText('Budget.pdf')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Recent files' })).toBeNull();
  });

  it('shows nothing where the platform keeps no recent files', () => {
    render(
      <WorkspaceProvider
        adapter={createMemoryPlatformAdapter().adapter}
        engine={pendingEngine}
        profile="browser"
      >
        <Welcome onOpen={() => undefined} hovering={false} />
      </WorkspaceProvider>,
    );
    expect(screen.queryByRole('heading', { name: 'Recent files' })).toBeNull();
  });
});
