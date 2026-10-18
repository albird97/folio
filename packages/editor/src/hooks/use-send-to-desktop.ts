import { useCallback } from 'react';
import { useWorkspaceContext } from '../context';

/**
 * "Open in Folio for desktop" (Chrome extension): hands the document, with
 * its changes, to the desktop app, which asks the user before opening it.
 * Call the returned function straight from a click: Chrome may first ask
 * for permission to talk to the app.
 */
export function useSendToDesktop(): ((key: string) => void) | null {
  const { adapter, workspace, ui } = useWorkspaceContext();
  const send = useCallback(
    (key: string) => {
      const doc = workspace.getState().documents.find((entry) => entry.key === key);
      if (!adapter.sendToDesktop || !doc?.editor || doc.status !== 'ready') return;
      const notice = (message: string) => workspace.getState().showNotice(message);
      void adapter
        .sendToDesktop({
          name: doc.fileName,
          bytes: async () => (await workspace.getState().exportDocument(key)).bytes,
          onProgress: (sent, total) =>
            notice(`Sending to Folio for desktop… ${Math.round((sent / total) * 100)}%`),
        })
        .then(
          (result) => {
            switch (result.status) {
              case 'sent':
                notice(`Sent ${doc.fileName} to Folio for desktop. Open it from the app’s prompt.`);
                break;
              case 'permission-denied':
                notice('Folio was not allowed to talk to the desktop app, so nothing was sent.');
                break;
              case 'not-installed':
                workspace.getState().dismissNotice();
                ui.getState().openDialog({ kind: 'desktop-missing' });
                break;
              case 'failed':
                notice(result.message);
                break;
            }
          },
          () => notice('The document could not be sent to Folio for desktop.'),
        );
    },
    [adapter, workspace, ui],
  );
  return adapter.features.nativeMessaging && adapter.sendToDesktop ? send : null;
}
