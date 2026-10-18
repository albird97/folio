import {
  annotationFrame,
  moveAnnotation,
  newAnnotationId,
  type Annotation,
  type AssetId,
  type AssetRef,
  type PageModel,
  type Rotation,
} from '@folio/document-model';
import { useEffect, type RefObject } from 'react';
import { annotationLabel, annotationText } from '../components/comments-panel';
import { useWorkspaceContext } from '../context';
import type { WorkspaceDocument } from '../store/workspace';
import {
  displayRotation,
  displaySpaceSize,
  invertMatrix,
  mapRect,
  pageSpaceSize,
  pageToDisplay,
} from '../viewer/geometry';
import { prepareImage } from '../viewer/images';

/** Copied annotations, kept in memory so they can be pasted into any open document. */
let copied: {
  annotations: Annotation[];
  assets: Array<{ ref: AssetRef; bytes: Uint8Array }>;
  /**
   * Put on the system clipboard with the text; a paste without it is not
   * ours. Null where the webview does not take custom clipboard types: the
   * text is compared instead.
   */
  token: string | null;
  text: string;
  pastes: number;
} | null = null;

/** Marks the system clipboard as holding Folio's last copied annotations. */
const CLIPBOARD_TYPE = 'application/x-folio-annotations';

/** How far each paste moves copies, in points, so they don't hide the originals. */
const PASTE_OFFSET = 12;

/**
 * Copy, cut and paste for annotations while the page view has focus, and
 * pasting images from the system clipboard as added images. Copying text
 * selected on a page is left to the browser.
 */
export function useAnnotationClipboard(
  scrollRef: RefObject<HTMLElement | null>,
  doc: WorkspaceDocument,
  pages: readonly PageModel[],
  viewRotation: Rotation,
): void {
  const { workspace, ui } = useWorkspaceContext();
  const key = doc.key;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const focused = () => element.contains(document.activeElement);
    const current = () => workspace.getState().documents.find((entry) => entry.key === key);

    /** Whether a copy or cut would take the selected annotations. */
    const copying = () => {
      const latest = current();
      if (!latest?.editor || !focused() || latest.selection.annotations.length === 0) return false;
      // Selected page text is copied as usual.
      return window.getSelection()?.isCollapsed !== false;
    };

    const copy = (event: ClipboardEvent, cut: boolean) => {
      const latest = current();
      const model = latest?.editor?.model;
      if (!latest || !model || !copying()) return;
      event.preventDefault();
      const annotations = latest.selection.annotations
        .map((id) => model.annotations[id])
        .filter((annotation): annotation is Annotation => annotation !== undefined);
      const assets: Array<{ ref: AssetRef; bytes: Uint8Array }> = [];
      for (const annotation of annotations) {
        if (!('assetId' in annotation)) continue;
        const ref = model.assets[annotation.assetId];
        const bytes = workspace.getAssetBytes(key, annotation.assetId);
        if (ref && bytes) assets.push({ ref, bytes });
      }
      const text = annotations
        .map((annotation) => annotationText(annotation) || annotationLabel(annotation))
        .join('\n');
      // Any random id will do; `randomUUID` needs a secure context.
      const token = newAnnotationId();
      event.clipboardData?.setData('text/plain', text);
      event.clipboardData?.setData(CLIPBOARD_TYPE, token);
      const marked = event.clipboardData?.types.includes(CLIPBOARD_TYPE) ?? false;
      copied = { annotations, assets, token: marked ? token : null, text, pastes: 0 };
      // Without permission to change comments, a cut copies and explains why.
      if (cut) {
        workspace.getState().deleteAnnotations(
          key,
          annotations.map((annotation) => annotation.id),
        );
      }
    };

    const pasteImage = async (file: File, page: PageModel) => {
      const state = workspace.getState();
      let prepared;
      try {
        prepared = await prepareImage(file);
      } catch {
        state.showNotice('That image could not be read.');
        return;
      }
      const asset = await state.registerImage(key, prepared.bytes, prepared.mimeType);
      if (!asset) return;
      // Centred on the page as shown, at 96 pixels per inch, at most half the page.
      const shown = displaySpaceSize(page, viewRotation);
      const aspect = prepared.width / prepared.height;
      let width = Math.min((prepared.width * 72) / 96, shown.width / 2);
      let height = width / aspect;
      if (height > shown.height / 2) {
        height = shown.height / 2;
        width = height * aspect;
      }
      const rect = mapRect(invertMatrix(pageToDisplay(page, viewRotation)), {
        x: (shown.width - width) / 2,
        y: (shown.height - height) / 2,
        width,
        height,
      });
      const now = new Date().toISOString();
      state.addAnnotations(
        key,
        [
          {
            id: newAnnotationId(),
            pageId: page.id,
            author: ui.getState().authorName,
            createdAt: now,
            modifiedAt: now,
            color: '#000000',
            opacity: 1,
            kind: 'added-image',
            rect,
            assetId: asset.id,
            rotation: displayRotation(page, viewRotation),
          },
        ],
        { label: 'Paste image', assets: [asset] },
      );
    };

    const pasteAnnotations = async (page: PageModel) => {
      if (!copied) return;
      const state = workspace.getState();
      copied.pastes += 1;
      const assets: AssetRef[] = [];
      const assetIds = new Map<AssetId, AssetId>();
      for (const { ref, bytes } of copied.assets) {
        const registered = await state.registerImage(key, bytes, ref.mimeType);
        if (!registered) return;
        assets.push(registered);
        assetIds.set(ref.id, registered.id);
      }
      const size = pageSpaceSize(page);
      const now = new Date().toISOString();
      const offset = PASTE_OFFSET * copied.pastes;
      const pasted = copied.annotations.map((annotation) => {
        let copy = {
          ...annotation,
          id: newAnnotationId(),
          pageId: page.id,
          createdAt: now,
          modifiedAt: now,
        };
        if ('assetId' in copy)
          copy = { ...copy, assetId: assetIds.get(copy.assetId) ?? copy.assetId };
        // Offset copies down and to the right, staying on the page.
        const frame = annotationFrame(copy);
        const dx = Math.min(offset, Math.max(0, size.width - frame.x - frame.width));
        const dy = -Math.min(offset, Math.max(0, frame.y));
        return moveAnnotation(copy as Annotation, dx, dy);
      });
      state.addAnnotations(key, pasted, {
        label: pasted.length === 1 ? 'Paste comment' : `Paste ${pasted.length} comments`,
        assets,
      });
    };

    const pasteTarget = () => {
      const latest = current();
      if (!latest?.editor || !focused() || !latest.permissions.annotate) return null;
      const { model } = latest.editor;
      return model.pages.find((entry) => entry.id === latest.view?.currentPageId) ?? pages[0];
    };

    const ours = (data: DataTransfer) => {
      if (!copied) return false;
      return copied.token
        ? data.getData(CLIPBOARD_TYPE) === copied.token
        : data.getData('text/plain') === copied.text;
    };

    const paste = (event: ClipboardEvent) => {
      const page = pasteTarget();
      const data = event.clipboardData;
      if (!page || !data) return;
      const image = Array.from(data.files).find((file) => file.type.startsWith('image/'));
      if (image) {
        event.preventDefault();
        void pasteImage(image, page);
      } else if (ours(data)) {
        event.preventDefault();
        void pasteAnnotations(page);
      }
    };

    // WebKit (the macOS webview) only enables Copy, Cut and Paste without a
    // text selection or an editable field when the page cancels these.
    const enableCopy = (event: Event) => {
      if (copying()) event.preventDefault();
    };
    const enablePaste = (event: Event) => {
      if (pasteTarget()) event.preventDefault();
    };

    const onCopy = (event: ClipboardEvent) => copy(event, false);
    const onCut = (event: ClipboardEvent) => copy(event, true);
    const listeners: Array<[string, (event: never) => void]> = [
      ['beforecopy', enableCopy],
      ['beforecut', enableCopy],
      ['beforepaste', enablePaste],
      ['copy', onCopy],
      ['cut', onCut],
      ['paste', paste],
    ];
    for (const [type, listener] of listeners) {
      document.addEventListener(type, listener as EventListener);
    }
    return () => {
      for (const [type, listener] of listeners) {
        document.removeEventListener(type, listener as EventListener);
      }
    };
  }, [scrollRef, workspace, ui, key, pages, viewRotation]);
}
