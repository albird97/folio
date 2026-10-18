import { useEffect } from 'react';
import { useWorkspaceContext } from '../context';

/**
 * Desktop: documents the Folio Chrome extension sends are only opened once
 * the user accepts them in a dialog; until then they wait in a queue.
 */
export function useTransfers(): void {
  const { adapter, ui } = useWorkspaceContext();
  useEffect(
    () => adapter.onTransferRequest?.((request) => ui.getState().queueTransfer(request)),
    [adapter, ui],
  );
}
