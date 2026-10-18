import { incomingFromFile } from '@folio/platform-adapters';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useWorkspaceContext } from '../context';

const hasFiles = (event: DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Drag-and-drop opening. Web targets receive DOM drop events; the desktop
 * webview reports hover through the adapter and delivers dropped files as
 * native grants instead.
 */
export function useFileDrop() {
  const { adapter, workspace } = useWorkspaceContext();
  const [webHover, setWebHover] = useState(false);
  const [nativeHover, setNativeHover] = useState(false);
  // Elements the drag is over. A counter would leak when the element under
  // the pointer is removed mid-drag (a loading tab becoming ready): its
  // dragleave then fires on a detached node and never reaches this root.
  const entered = useRef(new Set<Node>());
  const forgetDetached = () => {
    for (const node of entered.current) if (!node.isConnected) entered.current.delete(node);
  };

  useEffect(() => adapter.onNativeDragHover(setNativeHover), [adapter]);

  if (!adapter.features.webDragAndDrop) {
    return { hovering: nativeHover, handlers: {} };
  }

  return {
    hovering: webHover || nativeHover,
    handlers: {
      onDragEnter(event: DragEvent) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        forgetDetached();
        entered.current.add(event.target as Node);
        setWebHover(true);
      },
      onDragOver(event: DragEvent) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave(event: DragEvent) {
        if (!hasFiles(event)) return;
        entered.current.delete(event.target as Node);
        forgetDetached();
        if (entered.current.size === 0) setWebHover(false);
      },
      onDrop(event: DragEvent) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        entered.current.clear();
        setWebHover(false);
        const files = Array.from(event.dataTransfer.files).map(incomingFromFile);
        void workspace.getState().openFiles(files);
      },
    },
  };
}
