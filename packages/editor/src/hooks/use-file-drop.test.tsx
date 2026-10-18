import type { PdfEngine } from '@folio/pdf-core';
import { createMemoryPlatformAdapter } from '@folio/platform-adapters';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkspaceProvider } from '../context';
import { useFileDrop } from './use-file-drop';

const engine = { open: () => new Promise(() => undefined), destroy: () => undefined } as PdfEngine;
const files = { dataTransfer: { types: ['Files'], files: [] } };

function Target({ withSpinner }: { withSpinner: boolean }) {
  const { hovering, handlers } = useFileDrop();
  return (
    <div data-testid="root" data-hovering={hovering} {...handlers}>
      {withSpinner ? <span data-testid="spinner" /> : null}
      <span data-testid="page" />
    </div>
  );
}

describe('file drop hover', () => {
  it('ends when the drag leaves, even if the element it entered was removed', () => {
    const { adapter } = createMemoryPlatformAdapter();
    const view = (withSpinner: boolean) => (
      <WorkspaceProvider adapter={adapter} engine={engine} profile="browser">
        <Target withSpinner={withSpinner} />
      </WorkspaceProvider>
    );
    const { rerender } = render(view(true));
    const hovering = () => screen.getByTestId('root').dataset.hovering;

    fireEvent.dragEnter(screen.getByTestId('spinner'), files);
    expect(hovering()).toBe('true');
    // The spinner goes away mid-drag; its dragleave fires on a detached node.
    rerender(view(false));
    fireEvent.dragEnter(screen.getByTestId('page'), files);
    expect(hovering()).toBe('true');
    fireEvent.dragLeave(screen.getByTestId('page'), files);
    expect(hovering()).toBe('false');
  });

  it('stays on while the drag moves between elements', () => {
    const { adapter } = createMemoryPlatformAdapter();
    render(
      <WorkspaceProvider adapter={adapter} engine={engine} profile="browser">
        <Target withSpinner />
      </WorkspaceProvider>,
    );
    const hovering = () => screen.getByTestId('root').dataset.hovering;
    fireEvent.dragEnter(screen.getByTestId('root'), files);
    fireEvent.dragEnter(screen.getByTestId('page'), files);
    fireEvent.dragLeave(screen.getByTestId('root'), files);
    expect(hovering()).toBe('true');
    fireEvent.dragLeave(screen.getByTestId('page'), files);
    expect(hovering()).toBe('false');
  });
});
