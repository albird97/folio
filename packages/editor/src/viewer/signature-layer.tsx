import type { Point } from '@folio/document-model';
import { memo, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useUi, useWorkspace, useWorkspaceContext } from '../context';
import { clickPlacement, newSignature } from '../signature/placement';
import { pngDataUrl } from '../signature/remembered';
import type { SignatureImage } from '../signature/render';
import { displaySpaceSize } from './geometry';
import { pageViewSelector, type PageOverlayProps } from './page-overlays';

/** What the user is told when placing starts (screen readers hear it too). */
export const PLACING_HINT =
  'Click where the signature goes, or press Enter to put it in the middle of the page. Esc cancels.';

/** Where keys typed into these keep their own meaning. */
const KEEPS_KEYS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"], [role="listbox"]';
/** The pages, where keyboard focus belongs once a signature is placed. */
const PAGE_VIEW = pageViewSelector();

/** The page the keyboard places on: the current one (or the first, before there is one). */
const isCurrent = ({ doc, page }: PageOverlayProps) =>
  (doc.view?.currentPageId ?? doc.editor?.model.pages[0]?.id) === page.id;

/** The preview image of each signature, made once for all pages. */
const previews = new WeakMap<SignatureImage, string>();
function previewOf(signature: SignatureImage): string {
  let url = previews.get(signature);
  if (!url) {
    url = pngDataUrl(signature.bytes);
    previews.set(signature, url);
  }
  return url;
}

/**
 * Places the signature chosen in the signature dialog. While the Signature
 * tool holds one, a preview follows the pointer over each page and a click
 * puts the signature there; Enter puts it in the middle of the current page
 * and Escape gives up. Select then takes over, with the new signature
 * selected.
 */
export const SignatureLayer = memo(
  function SignatureLayer(props: PageOverlayProps) {
    const { workspace, ui } = useWorkspaceContext();
    const pending = useUi((state) => state.pendingSignature);
    const activeKey = useWorkspace((state) => state.activeKey);
    const placing = props.tool === 'signature' && pending !== null;
    const elsewhere = placing && pending.docKey !== props.doc.key;

    // A signature goes into the document it was chosen for (whose digital
    // signatures the dialog warned about): turning to another one gives up.
    // (The other document of a split view stays in sight meanwhile.)
    const abandoned = placing && pending.docKey !== activeKey;
    useEffect(() => {
      if (abandoned) ui.getState().setTool('select');
    }, [abandoned, ui]);

    // The hint about placing goes with it, however placing ends.
    useEffect(() => {
      if (placing) return;
      const state = workspace.getState();
      if (state.notice?.message.endsWith(PLACING_HINT)) state.dismissNotice();
    }, [placing, workspace]);

    if (!placing || elsewhere || !props.doc.permissions.annotate) return null;
    return <Placing {...props} signature={pending.image} current={isCurrent(props)} />;
  },
  // Pages re-render while the document scrolls; this only needs what it draws with.
  (before, after) =>
    before.tool === after.tool &&
    before.page === after.page &&
    before.box === after.box &&
    before.viewRotation === after.viewRotation &&
    before.position === after.position &&
    before.doc.key === after.doc.key &&
    before.doc.permissions.annotate === after.doc.permissions.annotate &&
    isCurrent(before) === isCurrent(after),
);

function Placing({
  doc,
  page,
  position,
  box,
  viewRotation,
  signature,
  current,
}: PageOverlayProps & { signature: SignatureImage; current: boolean }) {
  const { workspace, ui } = useWorkspaceContext();
  const layerRef = useRef<HTMLDivElement>(null);
  /** The pointer over the page, in display space. */
  const [pointer, setPointer] = useState<Point | null>(null);
  const preview = useMemo(() => previewOf(signature), [signature]);
  const display = displaySpaceSize(page, viewRotation);
  const aspect = signature.width / signature.height;

  const toDisplay = (event: { clientX: number; clientY: number }): Point => {
    const rect = layerRef.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * display.width,
      y: ((event.clientY - rect.top) / rect.height) * display.height,
    };
  };

  /** Adds the signature centred on `at` (display space). */
  const place = async (at: Point, reveal: boolean) => {
    const placement = clickPlacement(page, viewRotation, at, aspect);
    // Keyboard focus goes to the pages, where Delete and the arrow keys
    // work on the new signature once it is selected.
    layerRef.current?.closest<HTMLElement>(PAGE_VIEW)?.focus({ preventScroll: true });
    // The tool is used up at once, so a quick second click adds nothing.
    ui.getState().setTool('select');
    const state = workspace.getState();
    try {
      const asset = await state.registerImage(doc.key, signature.bytes, 'image/png');
      if (!asset) return;
      const annotation = newSignature({
        pageId: page.id,
        placement,
        assetId: asset.id,
        author: ui.getState().authorName,
      });
      if (!state.addAnnotations(doc.key, [annotation], { label: 'Add signature', assets: [asset] }))
        return;
    } catch {
      state.showNotice('The signature could not be added.');
      return;
    }
    if (reveal) {
      const { x, y, width, height } = placement.rect;
      state.navigate(doc.key, {
        pageIndex: position,
        pagePoint: { x: x + width / 2, y: y + height / 2 },
        align: 'center',
      });
    }
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(KEEPS_KEYS)) return;
    if (event.key === 'Escape') {
      // (With focus in the pages, the page view has given up placing already.)
      event.preventDefault();
      ui.getState().setTool('select');
    } else if (
      event.key === 'Enter' &&
      !event.defaultPrevented &&
      // Buttons and other controls keep Enter for themselves.
      (!target || target === document.body || target.closest(PAGE_VIEW) !== null)
    ) {
      event.preventDefault();
      void place({ x: display.width / 2, y: display.height / 2 }, true);
    }
  });

  // One listener, on the current page: the keys work wherever focus is
  // (after the dialog, focus may be on a toolbar button).
  useEffect(() => {
    if (!current) return;
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [current]);

  const shown = pointer ? clickPlacement(page, viewRotation, pointer, aspect).shown : null;
  const ppu = box.width / display.width;
  return (
    // Pointer input only: the keyboard places with Enter (above), and
    // screen readers hear about it when the tool starts.
    <div
      ref={layerRef}
      aria-hidden
      className="absolute cursor-crosshair touch-none select-none"
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
      data-signature-layer={position + 1}
      // No text selection, and no focus change before the signature is placed.
      onPointerDown={(event) => event.preventDefault()}
      onPointerMove={(event) => setPointer(toDisplay(event))}
      onPointerLeave={() => setPointer(null)}
      onClick={(event) => {
        // The page view's own clicks select text markup.
        event.stopPropagation();
        if (event.button === 0) void place(toDisplay(event), false);
      }}
    >
      {shown ? (
        <img
          src={preview}
          alt=""
          draggable={false}
          className="pointer-events-none absolute opacity-70 outline-1 outline-accent outline-dashed"
          style={{
            left: shown.x * ppu,
            top: shown.y * ppu,
            width: shown.width * ppu,
            height: shown.height * ppu,
          }}
        />
      ) : null}
    </div>
  );
}
