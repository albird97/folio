import { incomingFromFile } from '@folio/platform-adapters';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useWorkspaceContext } from '../context';

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

/**
 * Drag-and-drop opening. Web targets receive DOM drop events; the desktop
 * webview reports hover through the adapter and delivers dropped files as
 * native grants instead.
 */
export function useFileDrop() {
  const { adapter, workspace } = useWorkspaceContext();
  const [webHover, setWebHover] = useState(false);
  const [nativeHover, setNativeHover] = useState(false);
  const depth = useRef(0);

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
        depth.current += 1;
        setWebHover(true);
      },
      onDragOver(event: DragEvent) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave(event: DragEvent) {
        if (!hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setWebHover(false);
      },
      onDrop(event: DragEvent) {
        if (!hasFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setWebHover(false);
        const files = Array.from(event.dataTransfer.files).map(incomingFromFile);
        void workspace.getState().openFiles(files);
      },
    },
  };
}
