import {
  moveAnnotation,
  newAnnotationId,
  normalizeRect,
  type Annotation,
  type AnnotationId,
  type DocumentViewState,
  type PageId,
  type PageModel,
  type SourceId,
  type TextMarkupAnnotation,
} from '@folio/document-model';
import { applyTransform, type PdfDocumentHandle } from '@folio/pdf-core';
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { useUi, useWorkspaceContext } from '../context';
import { useAnnotationClipboard } from '../hooks/use-annotation-clipboard';
import type { TextMatch } from '../search/match';
import { MARKUP_TOOLS } from '../store/ui';
import type { NavigationTarget, WorkspaceDocument } from '../store/workspace';
import { AnnotationLayer } from './annotation-layer';
import { FormLayer } from './form-layer';
import {
  applyMatrix,
  displaySize,
  displaySpaceSize,
  invertMatrix,
  invertTransform,
  pageSource,
  pageToDisplay,
  userRotation,
} from './geometry';
import {
  anchorAt,
  computeLayout,
  mostVisiblePage,
  pageTop,
  scrollForAnchor,
  VIEW_PADDING,
  visibleRange,
  type Anchor,
  type PageLayout,
} from './layout';
import { PageView, type PageHits } from './page-view';
import { PRIORITY, renderCacheKey } from './resources';
import type { PageOverlayProps } from './page-overlays';
import { StampLayer } from './stamp-layer';
import { selectedText } from './text-markup';
import { useDevicePixelRatio } from './use-device-pixel-ratio';
import { clampZoom, fitZoom, stepZoom } from './zoom';

interface Area {
  width: number;
  height: number;
}

interface RenderRange {
  /** Pages kept mounted (the window plus a margin). */
  first: number;
  last: number;
  /** Pages actually in the window. */
  visibleFirst: number;
  visibleLast: number;
}

interface PendingAnchor {
  anchor: Anchor;
  /** Where in the window the anchor must stay, in CSS pixels. */
  x: number;
  y: number;
}

/** Within a page, scroll positions reach the store at most this often. */
const POSITION_REPORT_MS = 150;
/** Pages above and below the window are rendered ahead of time, at least this far. */
const MIN_OVERSCAN = 400;
/** A ctrl+wheel delta at least this large comes from a mouse wheel notch rather than a pinch. */
const WHEEL_NOTCH = 50;

/** Matches grouped by page, with objects that keep their identity while results are unchanged. */
function groupMatches(matches: readonly TextMatch[]) {
  const pages = new Map<number, { first: number; matches: TextMatch[]; hits: PageHits }>();
  matches.forEach((match, index) => {
    let group = pages.get(match.pageIndex);
    if (!group) {
      const list: TextMatch[] = [];
      group = { first: index, matches: list, hits: { matches: list, active: -1 } };
      pages.set(match.pageIndex, group);
    }
    group.matches.push(match);
  });
  return pages;
}

export interface DocumentViewerProps {
  doc: WorkspaceDocument;
  pages: readonly PageModel[];
  view: DocumentViewState;
  /** The engine document showing pages of a source file. */
  sourceHandle(sourceId: SourceId): PdfDocumentHandle | null;
}

const NO_ANNOTATIONS: readonly Annotation[] = [];
const NO_IDS: readonly AnnotationId[] = [];

/** Annotations grouped by page, reusing `previous` arrays whose contents did not change. */
function groupByPage(
  annotations: Readonly<Record<string, Annotation>>,
  previous: ReadonlyMap<PageId, Annotation[]> | null,
): Map<PageId, Annotation[]> {
  const next = new Map<PageId, Annotation[]>();
  for (const annotation of Object.values(annotations)) {
    const list = next.get(annotation.pageId);
    if (list) list.push(annotation);
    else next.set(annotation.pageId, [annotation]);
  }
  for (const [pageId, list] of next) {
    const before = previous?.get(pageId);
    if (before && before.length === list.length && before.every((item, i) => item === list[i])) {
      next.set(pageId, before);
    }
  }
  return next;
}

/**
 * Annotations by page. A page's array keeps its identity while its
 * annotations are unchanged, so editing one page re-renders only that page.
 */
function useAnnotationsByPage(annotations: Readonly<Record<string, Annotation>>) {
  const [grouped, setGrouped] = useState(() => ({
    annotations,
    byPage: groupByPage(annotations, null),
  }));
  if (grouped.annotations !== annotations) {
    const next = { annotations, byPage: groupByPage(annotations, grouped.byPage) };
    setGrouped(next);
    return next.byPage;
  }
  return grouped.byPage;
}

/**
 * The continuous page view. Pages are laid out in one column and only those
 * near the window are mounted, so documents with thousands of pages scroll
 * smoothly; rendering is queued by distance from the window.
 */
export function DocumentViewer({ doc, pages, view, sourceHandle }: DocumentViewerProps) {
  const { workspace, ui } = useWorkspaceContext();
  const tool = useUi((state) => state.tool);
  const key = doc.key;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<Area | null>(null);
  const ratio = useDevicePixelRatio();

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = element;
      setArea((previous) =>
        previous?.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sizes = useMemo(
    () => pages.map((page) => displaySize(page, view.rotation)),
    [pages, view.rotation],
  );
  const currentIndex = Math.max(
    0,
    pages.findIndex((page) => page.id === view.currentPageId),
  );

  // Fit modes size pages by the page that was current when the mode, window
  // or rotation last changed, so scrolling past pages of other sizes does not
  // keep re-zooming the document.
  const fitInputs = area ? `${view.zoomMode}|${area.width}x${area.height}|${view.rotation}` : '';
  const [fitReference, setFitReference] = useState({ inputs: fitInputs, index: currentIndex });
  if (fitReference.inputs !== fitInputs) {
    setFitReference({ inputs: fitInputs, index: currentIndex });
  }
  const referenceSize = sizes[Math.min(fitReference.index, sizes.length - 1)];
  const scale =
    view.zoomMode === 'custom' || !area || !referenceSize
      ? clampZoom(view.zoom)
      : fitZoom(view.zoomMode, referenceSize, {
          width: area.width - VIEW_PADDING * 2,
          height: area.height - VIEW_PADDING * 2,
        });
  const layout = useMemo(
    () => (area ? computeLayout(sizes, scale, area.width) : null),
    [sizes, scale, area],
  );

  useEffect(() => {
    if (area && view.zoomMode !== 'custom') workspace.getState().syncFitZoom(key, scale);
  }, [workspace, key, area, view.zoomMode, scale]);

  const layoutRef = useRef<PageLayout | null>(null);
  const committed = useRef<{ sizes: unknown; area: Area | null } | null>(null);
  const anchors = useRef<{ top: Anchor | null; center: Anchor | null }>({
    top: null,
    center: null,
  });
  const pendingAnchor = useRef<PendingAnchor | null>(null);
  const pendingZoom = useRef<number | null>(null);
  const reported = useRef<{
    index: number;
    timer: ReturnType<typeof setTimeout> | null;
    commit: (() => void) | null;
  }>({ index: -1, timer: null, commit: null });
  const [range, setRange] = useState<RenderRange | null>(null);

  const report = useEffectEvent((index: number, offset: number) => {
    const page = pages[index];
    if (!page) return;
    const state = reported.current;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const commit = () => {
      state.timer = null;
      state.commit = null;
      workspace.getState().updatePosition(key, page.id, offset);
    };
    // A new current page shows at once (page field, pages panel); the offset
    // within the page is only needed to restore the position later.
    if (state.index !== index) {
      state.index = index;
      commit();
    } else {
      state.commit = commit;
      state.timer = setTimeout(commit, POSITION_REPORT_MS);
    }
  });

  /** Reads the scroll position: anchors for the next layout change, mounted pages, current page. */
  const track = useEffectEvent(() => {
    const element = scrollRef.current;
    const current = layoutRef.current;
    if (!element || !current) return;
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = element;
    anchors.current = {
      top: anchorAt(current, scrollLeft, scrollTop, clientWidth / 2, 0),
      center: anchorAt(current, scrollLeft, scrollTop, clientWidth / 2, clientHeight / 2),
    };
    const visible = visibleRange(current, scrollTop, clientHeight);
    const mounted = visibleRange(
      current,
      scrollTop,
      clientHeight,
      Math.max(MIN_OVERSCAN, clientHeight),
    );
    if (visible && mounted) {
      setRange((previous) =>
        previous?.first === mounted.first &&
        previous.last === mounted.last &&
        previous.visibleFirst === visible.first &&
        previous.visibleLast === visible.last
          ? previous
          : {
              first: mounted.first,
              last: mounted.last,
              visibleFirst: visible.first,
              visibleLast: visible.last,
            },
      );
    }
    const index = mostVisiblePage(current, scrollTop, clientHeight);
    const box = index === null ? undefined : current.boxes[index];
    if (index !== null && box) report(index, (scrollTop - box.top) / box.height);
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => track();
    element.addEventListener('scroll', onScroll, { passive: true });
    const state = reported.current;
    return () => {
      element.removeEventListener('scroll', onScroll);
      // Keep the latest position for when this document is shown again.
      if (state.timer) clearTimeout(state.timer);
      state.commit?.();
    };
  }, []);

  const restore = useEffectEvent((element: HTMLElement, next: PageLayout) => {
    const index = Math.max(
      0,
      pages.findIndex((page) => page.id === view.currentPageId),
    );
    const box = next.boxes[index];
    const top =
      !box || view.pageOffset === 0 ? pageTop(next, index) : box.top + view.pageOffset * box.height;
    element.scrollTo({ left: Math.max(0, (next.width - element.clientWidth) / 2), top });
  });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !layout) return;
    const previous = committed.current;
    committed.current = { sizes, area };
    layoutRef.current = layout;
    pendingZoom.current = null;
    if (!previous) {
      restore(element, layout);
    } else {
      // Keep the same part of the document in view: the point under the
      // pointer for gestures, the middle of the window for other zoom
      // changes, and the top of the window otherwise (resizing, page sizes
      // arriving, rotation).
      const pending = pendingAnchor.current;
      pendingAnchor.current = null;
      const zoomOnly = previous.sizes === sizes && previous.area === area;
      const { top, center } = anchors.current;
      const target =
        pending ??
        (zoomOnly && center
          ? { anchor: center, x: element.clientWidth / 2, y: element.clientHeight / 2 }
          : top
            ? { anchor: top, x: element.clientWidth / 2, y: 0 }
            : null);
      if (target) {
        const position = scrollForAnchor(layout, target.anchor, target.x, target.y);
        // Pages that changed shape (turned, resized window) are centred again.
        const box = layout.boxes[target.anchor.pageIndex];
        if (!pending && !zoomOnly && box) {
          position.left = Math.max(0, box.left + box.width / 2 - element.clientWidth / 2);
        }
        element.scrollTo(position);
      }
    }
    track();
  }, [layout, sizes, area]);

  const navigationSeq = useRef(0);
  const scrollToTarget = useEffectEvent(async (target: NavigationTarget) => {
    const seq = (navigationSeq.current += 1);
    const element = scrollRef.current;
    const initial = layoutRef.current;
    const page = pages[target.pageIndex];
    if (!element || !initial || !page || !initial.boxes[target.pageIndex]) return;
    const { match, point } = target;
    // Anchors follow every programmatic scroll at once: a layout change before
    // the next scroll event must keep this position, not the previous one.
    const scrollTo = (position: ScrollToOptions) => {
      element.scrollTo(position);
      track();
    };
    if (!match && !target.pagePoint && (!point || (point.x === null && point.y === null))) {
      scrollTo({ top: pageTop(initial, target.pageIndex) });
      return;
    }

    // Where the target is on the page, in CSS pixels at the initial scale.
    let x: number | null = null;
    let y: number | null = null;
    if (target.pagePoint) {
      const shown = applyMatrix(pageToDisplay(page, view.rotation), target.pagePoint);
      x = shown.x * initial.scale * page.userUnit;
      y = shown.y * initial.scale * page.userUnit;
    } else {
      try {
        const source = pageSource(page);
        const handle = source ? sourceHandle(source.sourceId) : null;
        if (!source || !handle) throw new Error('Blank page');
        const sourceIndex = source.pageIndex;
        const viewport = await handle.getViewport(sourceIndex, {
          scale: initial.scale,
          rotation: userRotation(page, view.rotation),
        });
        if (match) {
          const item = (await handle.getPageText(sourceIndex)).items[match.start.item];
          if (item) {
            const [a = 1, b = 0, , , e = 0, f = 0] = item.transform;
            const length = Math.hypot(a, b) || 1;
            const along =
              item.str.length > 0 ? (match.start.offset / item.str.length) * item.width : 0;
            [x, y] = applyTransform(
              viewport.transform,
              e + (along * a) / length,
              f + (along * b) / length,
            );
          }
        } else if (point) {
          // Missing coordinates mean "the page edge", as in PDF viewers generally.
          const [cornerX, cornerY] = applyTransform(invertTransform(viewport.transform), 0, 0);
          const [vx, vy] = applyTransform(
            viewport.transform,
            point.x ?? cornerX,
            point.y ?? cornerY,
          );
          x = point.x === null ? null : vx;
          y = vy;
        }
      } catch {
        // Fall back to the top of the page.
      }
    }
    if (seq !== navigationSeq.current) return;
    const current = layoutRef.current ?? initial;
    const box = current.boxes[target.pageIndex];
    if (!box) return;
    if (y === null) {
      scrollTo({ top: pageTop(current, target.pageIndex) });
      return;
    }
    const factor = current.scale / initial.scale;
    const contentX = x === null ? null : box.left + x * factor;
    const contentY = box.top + y * factor;
    if (target.align === 'top') {
      scrollTo({ left: contentX ?? element.scrollLeft, top: contentY });
      return;
    }
    // Search results: leave the view alone when the match is comfortably visible.
    const { scrollLeft, scrollTop, clientWidth, clientHeight } = element;
    const margin = Math.min(96, clientHeight / 4);
    const inY = contentY >= scrollTop + margin && contentY <= scrollTop + clientHeight - margin;
    const inX =
      contentX === null ||
      (contentX >= scrollLeft + 16 && contentX <= scrollLeft + clientWidth - 48);
    if (inY && inX) return;
    scrollTo({
      top: inY ? scrollTop : contentY - clientHeight / 2,
      left: inX || contentX === null ? scrollLeft : contentX - clientWidth / 3,
    });
  });

  const navigation = doc.navigation;
  const ready = layout !== null;
  useEffect(() => {
    if (!navigation || !ready) return;
    workspace.getState().clearNavigation(key, navigation.seq);
    void scrollToTarget(navigation.target);
  }, [workspace, key, navigation, ready]);

  const zoomFrom = useEffectEvent(() => pendingZoom.current ?? layoutRef.current?.scale ?? 1);
  const zoomTo = useEffectEvent((clientX: number, clientY: number, zoom: number) => {
    const element = scrollRef.current;
    const current = layoutRef.current;
    if (!element || !current) return;
    const next = clampZoom(zoom);
    if (Math.abs(next - (pendingZoom.current ?? current.scale)) < 0.0005) return;
    const bounds = element.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    const anchor = anchorAt(current, element.scrollLeft, element.scrollTop, x, y);
    if (anchor) pendingAnchor.current = { anchor, x, y };
    pendingZoom.current = next;
    workspace.getState().setZoom(key, 'custom', next);
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Trackpad pinches arrive as ctrl+wheel events without a Ctrl key press.
    let ctrlHeld = false;
    let wheelDistance = 0;
    let gestureZoom = 1;
    let pinch: { spread: number; zoom: number } | null = null;

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Control') ctrlHeld = event.type === 'keydown';
    };
    const onBlur = () => {
      ctrlHeld = false;
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const pixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * element.clientHeight
            : event.deltaY;
      if (!ctrlHeld && Math.abs(pixels) < WHEEL_NOTCH) {
        zoomTo(event.clientX, event.clientY, zoomFrom() * Math.exp(-pixels / 100));
        return;
      }
      wheelDistance += pixels;
      if (Math.abs(wheelDistance) < WHEEL_NOTCH) return;
      const direction = wheelDistance < 0 ? 1 : -1;
      wheelDistance = 0;
      zoomTo(event.clientX, event.clientY, stepZoom(zoomFrom(), direction));
    };
    // Safari and WKWebView report trackpad pinches as gesture events.
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureZoom = zoomFrom();
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      if (typeof gesture.scale !== 'number') return;
      const bounds = element.getBoundingClientRect();
      zoomTo(
        gesture.clientX ?? bounds.left + bounds.width / 2,
        gesture.clientY ?? bounds.top + bounds.height / 2,
        gestureZoom * gesture.scale,
      );
    };
    const onGestureEnd = (event: Event) => event.preventDefault();
    const fingers = (touches: TouchList) => {
      const a = touches.item(0);
      const b = touches.item(1);
      return a && b
        ? {
            spread: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
            x: (a.clientX + b.clientX) / 2,
            y: (a.clientY + b.clientY) / 2,
          }
        : null;
    };
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 2 ? fingers(event.touches) : null;
      pinch = touch && touch.spread > 0 ? { spread: touch.spread, zoom: zoomFrom() } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = pinch && event.touches.length === 2 ? fingers(event.touches) : null;
      if (!pinch || !touch) return;
      event.preventDefault();
      zoomTo(touch.x, touch.y, pinch.zoom * (touch.spread / pinch.spread));
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    element.addEventListener('gestureend', onGestureEnd);
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd);
    element.addEventListener('touchcancel', onTouchEnd);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
      element.removeEventListener('gestureend', onGestureEnd);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // While a selection is dragged, PDF.js' text layer CSS keeps it from jumping.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const stop = () => {
      for (const layer of element.querySelectorAll('.textLayer.selecting')) {
        layer.classList.remove('selecting');
      }
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('blur', stop);
    };
  }, []);
  const selection = doc.selection.annotations;
  const editable = doc.permissions.annotate;

  const press = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    event.target.closest('.textLayer')?.classList.add('selecting');
    press.current = { x: event.clientX, y: event.clientY };
    // A press away from every annotation clears the annotation selection.
    if (selection.length > 0 && !event.target.closest('[data-annotation-id], [data-handle]')) {
      workspace.getState().selectAnnotations(key, []);
    }
  };

  // Highlighted text stays selectable by dragging, so text markup has no hit
  // area of its own: a click (not a drag) on it selects it instead.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const start = press.current;
    press.current = null;
    if (tool !== 'select' || !(event.target instanceof Element) || !start) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) return;
    if (event.target.closest('[data-annotation-id], [data-handle]')) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const pageElement = event.target.closest<HTMLElement>('.folio-page');
    const page = pageElement ? pages[Number(pageElement.dataset.page) - 1] : undefined;
    if (!pageElement || !page) return;
    const bounds = pageElement.getBoundingClientRect();
    const size = displaySpaceSize(page, view.rotation);
    const point = applyMatrix(invertMatrix(pageToDisplay(page, view.rotation)), {
      x: ((event.clientX - bounds.left) / bounds.width) * size.width,
      y: ((event.clientY - bounds.top) / bounds.height) * size.height,
    });
    const hit = (annotationsByPage.get(page.id) ?? [])
      .filter(
        (annotation): annotation is TextMarkupAnnotation =>
          annotation.kind === 'highlight' ||
          annotation.kind === 'underline' ||
          annotation.kind === 'strikeout',
      )
      .reverse()
      .find((annotation) =>
        annotation.rects.some((raw) => {
          const rect = normalizeRect(raw);
          return (
            point.x >= rect.x &&
            point.x <= rect.x + rect.width &&
            point.y >= rect.y &&
            point.y <= rect.y + rect.height
          );
        }),
      );
    if (hit) workspace.getState().selectAnnotations(key, [hit.id]);
  };

  // Highlight, underline and strikethrough mark the text selected while they are active.
  const markSelection = useEffectEvent(() => {
    const element = scrollRef.current;
    const textSelection = window.getSelection();
    if (!element || !textSelection || textSelection.isCollapsed || !MARKUP_TOOLS.has(tool)) return;
    if (tool !== 'highlight' && tool !== 'underline' && tool !== 'strikeout') return;
    const found = selectedText(element, textSelection, pages, view.rotation);
    if (found.length === 0) return;
    const now = new Date().toISOString();
    const { style, authorName } = ui.getState();
    const annotations: Annotation[] = found.map((entry) => ({
      id: newAnnotationId(),
      pageId: pages[entry.position]!.id,
      author: authorName,
      createdAt: now,
      modifiedAt: now,
      color: style.colors[tool],
      opacity: 1,
      kind: tool,
      rects: entry.rects,
      text: entry.text,
    }));
    const label = { highlight: 'Highlight', underline: 'Underline', strikeout: 'Strike through' }[
      tool
    ];
    if (workspace.getState().addAnnotations(key, annotations, { label })) {
      textSelection.removeAllRanges();
    }
  });
  useEffect(() => {
    if (!MARKUP_TOOLS.has(tool)) return;
    const onUp = (event: globalThis.PointerEvent) => {
      if (event.button !== 0) return;
      // Let the selection settle (double and triple clicks select words and lines).
      setTimeout(() => markSelection(), 0);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.shiftKey || event.key === 'Shift') markSelection();
    };
    const element = scrollRef.current;
    element?.addEventListener('pointerup', onUp);
    element?.addEventListener('keyup', onKeyUp);
    return () => {
      element?.removeEventListener('pointerup', onUp);
      element?.removeEventListener('keyup', onKeyUp);
    };
  }, [tool]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const state = workspace.getState();
    if (event.key === 'Escape') {
      if (tool !== 'select') {
        event.preventDefault();
        ui.getState().setTool('select');
      } else if (selection.length > 0) {
        event.preventDefault();
        state.selectAnnotations(key, []);
      }
      return;
    }
    if (selection.length > 0 && editable && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        state.deleteAnnotations(key, [...selection]);
        return;
      }
      const steps: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const step = steps[event.key];
      if (step) {
        event.preventDefault();
        // Nudge on screen: one point, or ten with Shift, mapped into each page's space.
        const distance = event.shiftKey ? 10 : 1;
        const model = doc.editor?.model;
        if (!model) return;
        const moved: Annotation[] = [];
        for (const id of selection) {
          const annotation = model.annotations[id];
          const page = annotation ? pages.find((entry) => entry.id === annotation.pageId) : null;
          if (!annotation || !page || annotation.kind === 'highlight') continue;
          if (annotation.kind === 'underline' || annotation.kind === 'strikeout') continue;
          const [a, b, c, d] = invertMatrix(pageToDisplay(page, view.rotation));
          const dx = step[0] * distance;
          const dy = step[1] * distance;
          moved.push(moveAnnotation(annotation, a * dx + c * dy, b * dx + d * dy));
        }
        if (moved.length > 0) {
          state.updateAnnotations(key, moved, {
            label: moved.length === 1 ? 'Move comment' : `Move ${moved.length} comments`,
            coalesceKey: `nudge:${selection.join(',')}`,
          });
        }
        return;
      }
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // Without horizontal scrolling, left and right turn pages.
    const element = event.currentTarget;
    if (element.scrollWidth > element.clientWidth + 1) return;
    event.preventDefault();
    const target = currentIndex + (event.key === 'ArrowRight' ? 1 : -1);
    if (target >= 0 && target < pages.length) {
      state.navigate(key, { pageIndex: target, align: 'top' });
    }
  };

  useAnnotationClipboard(scrollRef, doc, pages, view.rotation);
  const annotationsByPage = useAnnotationsByPage(doc.editor?.model.annotations ?? {});
  const selectedByPage = useMemo(() => {
    const map = new Map<PageId, AnnotationId[]>();
    const annotations = doc.editor?.model.annotations;
    for (const id of selection) {
      const pageId = annotations?.[id]?.pageId;
      if (!pageId) continue;
      const list = map.get(pageId);
      if (list) list.push(id);
      else map.set(pageId, [id]);
    }
    return map;
  }, [selection, doc.editor?.model.annotations]);

  const groups = useMemo(() => groupMatches(doc.search.matches), [doc.search.matches]);
  const activeMatch = doc.search.matches[doc.search.active];
  const activeGroup = activeMatch ? groups.get(activeMatch.pageIndex) : undefined;
  const activeHits = useMemo<PageHits | null>(
    () =>
      activeGroup
        ? { matches: activeGroup.matches, active: doc.search.active - activeGroup.first }
        : null,
    [activeGroup, doc.search.active],
  );

  const mounted: number[] = [];
  if (layout && range) {
    for (
      let index = range.first;
      index <= Math.min(range.last, layout.boxes.length - 1);
      index += 1
    ) {
      mounted.push(index);
    }
  }

  return (
    // A scrolling region: focusable so the keyboard can scroll it (as browsers'
    // own PDF viewers do), with arrow keys turning pages and pointer handling
    // for text selection.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={scrollRef}
      role="region"
      aria-label="Page view"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className="h-full w-full touch-pan-x touch-pan-y overflow-auto outline-none [scrollbar-gutter:stable] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
    >
      {layout ? (
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          {mounted.map((index) => {
            const page = pages[index]!;
            const box = layout.boxes[index]!;
            const visible =
              range !== null && index >= range.visibleFirst && index <= range.visibleLast;
            const distance = Math.min(99, Math.abs(index - currentIndex));
            const hits =
              activeMatch?.pageIndex === index ? activeHits : (groups.get(index)?.hits ?? null);
            const source = pageSource(page);
            const handle = source ? sourceHandle(source.sourceId) : null;
            const overlay: PageOverlayProps = {
              doc,
              page,
              position: index,
              pageCount: pages.length,
              box,
              scale: layout.scale,
              viewRotation: view.rotation,
              handle,
              tool,
            };
            return (
              <Fragment key={page.id}>
                <PageView
                  cacheKey={renderCacheKey(key, source?.sourceId ?? 'blank')}
                  handle={handle}
                  position={index}
                  pageCount={pages.length}
                  sourceIndex={source?.pageIndex ?? 0}
                  box={box}
                  scale={layout.scale}
                  rotation={userRotation(page, view.rotation)}
                  userUnit={page.userUnit}
                  ratio={ratio}
                  priority={(visible ? PRIORITY.visiblePage : PRIORITY.nearbyPage) + distance}
                  hits={hits}
                />
                <StampLayer {...overlay} />
                <FormLayer {...overlay} />
                <AnnotationLayer
                  docKey={key}
                  page={page}
                  position={index}
                  box={box}
                  viewRotation={view.rotation}
                  annotations={annotationsByPage.get(page.id) ?? NO_ANNOTATIONS}
                  selected={selectedByPage.get(page.id) ?? NO_IDS}
                  tool={tool}
                  editable={editable}
                />
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
