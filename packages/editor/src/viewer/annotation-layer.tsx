import {
  annotationFrame,
  contentFrame,
  isMovable,
  isResizable,
  LINE_HEIGHT,
  moveAnnotation,
  newAnnotationId,
  normalizeRect,
  NOTE_ICON_SIZE,
  TEXT_PADDING,
  withFrame,
  type AddedTextAnnotation,
  type Annotation,
  type AnnotationId,
  type NoteAnnotation,
  type PageModel,
  type Point,
  type Rect,
  type Rotation,
} from '@folio/document-model';
import { cn } from '@folio/shared-ui';
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useWorkspaceContext } from '../context';
import { MARKUP_TOOLS, type Tool } from '../store/ui';
import { AnnotationHitArea, AnnotationShape, FONT_STACKS } from './annotation-shapes';
import {
  applyMatrix,
  displayRotation,
  displaySpaceSize,
  invertMatrix,
  mapRect,
  pageSpaceSize,
  pageToDisplay,
  svgMatrix,
} from './geometry';
import { pickImageFile, prepareImage } from './images';
import type { PageBox } from './layout';

/** Screen pixels a pointer may travel before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3;
/** Side of a resize handle, in screen pixels. */
const HANDLE_PX = 9;
/** Extra reach of thin annotations' hit areas, in screen pixels. */
const HIT_SLOP_PX = 5;
/** Smallest box an annotation can be resized to, in points. */
const MIN_SIZE = 4;

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<Handle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

/** Tools that draw on the page instead of selecting text or annotations. */
const DRAWING_TOOLS: ReadonlySet<Tool> = new Set([
  'note',
  'ink',
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'text',
  'image',
]);

type Gesture =
  | {
      type: 'move';
      pointerId: number;
      start: Point;
      originals: Annotation[];
      moved: boolean;
      startClient: Point;
    }
  | {
      type: 'resize';
      pointerId: number;
      handle: Handle;
      original: Annotation;
      /** The annotation's frame in display space when the drag started. */
      frame: Rect;
      start: Point;
      moved: boolean;
      startClient: Point;
    }
  | { type: 'ink'; pointerId: number; points: Point[] }
  | { type: 'box'; pointerId: number; tool: Tool; start: Point; end: Point; startClient: Point };

interface TextEditing {
  annotation: AddedTextAnnotation | NoteAnnotation;
  isNew: boolean;
}

export interface AnnotationLayerProps {
  docKey: string;
  page: PageModel;
  /** Position of the page in the document. */
  position: number;
  box: PageBox;
  viewRotation: Rotation;
  annotations: readonly Annotation[];
  /** Selected annotations on this page. */
  selected: readonly AnnotationId[];
  tool: Tool;
  /** The document allows annotations to be added and changed. */
  editable: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** A rect from two corners, kept to a square (Shift) when asked. */
function boxFrom(start: Point, end: Point, square: boolean): Rect {
  let width = end.x - start.x;
  let height = end.y - start.y;
  if (square) {
    const side = Math.max(Math.abs(width), Math.abs(height));
    width = Math.sign(width || 1) * side;
    height = Math.sign(height || 1) * side;
  }
  return { x: start.x, y: start.y, width, height };
}

/** A line end snapped to 45° steps (Shift). */
function snapLine(start: Point, end: Point): Point {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(dx, dy);
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

/**
 * The annotations of one page, drawn as SVG over the rendered page, and the
 * pointer tools that create, select, move and resize them. Geometry is kept
 * in page space; this layer maps it to the page as shown (rotated, zoomed).
 * Changes are previewed locally while a pointer drags and reach the
 * document (and its history) once, when the pointer is released.
 */
export const AnnotationLayer = memo(function AnnotationLayer({
  docKey,
  page,
  position,
  box,
  viewRotation,
  annotations,
  selected,
  tool,
  editable,
}: AnnotationLayerProps) {
  const { workspace, ui } = useWorkspaceContext();
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreviewState] = useState<Annotation[] | null>(null);
  /** The latest preview, for the release that ends a drag (it can precede a re-render). */
  const latestPreview = useRef<Annotation[] | null>(null);
  const setPreview = (next: Annotation[] | null) => {
    latestPreview.current = next;
    setPreviewState(next);
  };
  const [editing, setEditing] = useState<TextEditing | null>(null);

  const display = displaySpaceSize(page, viewRotation);
  const pageSize = pageSpaceSize(page);
  const toDisplay = pageToDisplay(page, viewRotation);
  const fromDisplay = invertMatrix(toDisplay);
  const rotation = displayRotation(page, viewRotation);
  /** Screen pixels per page unit. */
  const ppu = box.width / display.width;

  const drawing = editable && DRAWING_TOOLS.has(tool);
  const selecting = tool === 'select';

  const toPage = (event: { clientX: number; clientY: number }): Point => {
    const rect = layerRef.current!.getBoundingClientRect();
    const point = applyMatrix(fromDisplay, {
      x: ((event.clientX - rect.left) / rect.width) * display.width,
      y: ((event.clientY - rect.top) / rect.height) * display.height,
    });
    return { x: clamp(point.x, 0, pageSize.width), y: clamp(point.y, 0, pageSize.height) };
  };

  const base = () => {
    const now = new Date().toISOString();
    return {
      id: newAnnotationId(),
      pageId: page.id,
      author: ui.getState().authorName,
      createdAt: now,
      modifiedAt: now,
      opacity: 1,
    };
  };
  const colorFor = (kind: Exclude<Tool, 'select' | 'image'>) => ui.getState().style.colors[kind];

  /** A display-space rect (e.g. 200×40 on screen) as page space. */
  const fromDisplayRect = (rect: Rect) => mapRect(fromDisplay, rect);
  const displayPointOf = (point: Point) => applyMatrix(toDisplay, point);

  const finishTool = () => {
    // One-off tools hand back to Select; pens and shapes keep drawing.
    if (tool === 'note' || tool === 'text' || tool === 'image') ui.getState().setTool('select');
  };

  const commitNew = (annotation: Annotation, label: string) => {
    workspace.getState().addAnnotations(docKey, [annotation], { label });
  };

  async function addImage(placement: Rect | null, at: Point) {
    const file = await pickImageFile();
    if (!file) return;
    let prepared;
    try {
      prepared = await prepareImage(file);
    } catch {
      workspace.getState().showNotice('That image could not be read.');
      return;
    }
    const asset = await workspace
      .getState()
      .registerImage(docKey, prepared.bytes, prepared.mimeType);
    if (!asset) return;
    // 96 pixels per inch, at most half the page as shown.
    const aspect = prepared.width / prepared.height;
    let width = Math.min((prepared.width * 72) / 96, display.width / 2);
    let height = width / aspect;
    if (height > display.height / 2) {
      height = display.height / 2;
      width = height * aspect;
    }
    let target: Rect;
    if (placement && placement.width > 4 && placement.height > 4) {
      // Fit inside the box that was drawn, keeping proportions.
      const fit = Math.min(placement.width / width, placement.height / height);
      target = { x: placement.x, y: placement.y, width: width * fit, height: height * fit };
    } else {
      const start = displayPointOf(at);
      target = {
        x: clamp(start.x, 0, Math.max(0, display.width - width)),
        y: clamp(start.y, 0, Math.max(0, display.height - height)),
        width,
        height,
      };
    }
    const annotation: Annotation = {
      ...base(),
      kind: 'added-image',
      color: '#000000',
      rect: fromDisplayRect(target),
      assetId: asset.id,
      rotation,
    };
    workspace
      .getState()
      .addAnnotations(docKey, [annotation], { label: 'Add image', assets: [asset] });
  }

  function createFromBox(current: Extract<Gesture, { type: 'box' }>, shift: boolean) {
    const { start, end } = current;
    const startDisplay = displayPointOf(start);
    const endDisplay = displayPointOf(end);
    const tiny =
      Math.abs(endDisplay.x - startDisplay.x) * ppu < DRAG_THRESHOLD_PX &&
      Math.abs(endDisplay.y - startDisplay.y) * ppu < DRAG_THRESHOLD_PX;
    const style = ui.getState().style;
    switch (current.tool) {
      case 'rectangle':
      case 'ellipse': {
        const rect = tiny
          ? fromDisplayRect({ x: startDisplay.x, y: startDisplay.y, width: 120, height: 80 })
          : normalizeRect(boxFrom(start, end, shift));
        commitNew(
          {
            ...base(),
            kind: 'shape',
            shape: current.tool,
            color: colorFor(current.tool),
            rect,
            strokeWidth: style.strokeWidth,
            fill: style.fill,
          },
          current.tool === 'rectangle' ? 'Draw rectangle' : 'Draw ellipse',
        );
        break;
      }
      case 'line':
      case 'arrow': {
        const to = tiny
          ? applyMatrix(fromDisplay, { x: startDisplay.x + 120, y: startDisplay.y })
          : shift
            ? snapLine(start, end)
            : end;
        commitNew(
          {
            ...base(),
            kind: 'shape',
            shape: current.tool,
            color: colorFor(current.tool),
            rect: { x: start.x, y: start.y, width: to.x - start.x, height: to.y - start.y },
            strokeWidth: style.strokeWidth,
            fill: null,
          },
          current.tool === 'line' ? 'Draw line' : 'Draw arrow',
        );
        break;
      }
      case 'text': {
        const defaultHeight = style.fontSize * LINE_HEIGHT + TEXT_PADDING * 2 + 4;
        const rect = tiny
          ? fromDisplayRect({
              x: clamp(startDisplay.x, 0, Math.max(0, display.width - 220)),
              y: clamp(startDisplay.y, 0, Math.max(0, display.height - defaultHeight)),
              width: Math.min(220, display.width),
              height: defaultHeight,
            })
          : normalizeRect(boxFrom(start, end, false));
        setEditing({
          isNew: true,
          annotation: {
            ...base(),
            kind: 'added-text',
            color: colorFor('text'),
            rect,
            text: '',
            fontSize: style.fontSize,
            fontFamily: style.fontFamily,
            rotation,
          },
        });
        break;
      }
      case 'image': {
        const drawn = tiny ? null : normalizeRect(boxFrom(startDisplay, endDisplay, false));
        void addImage(drawn, start);
        break;
      }
      default:
        return;
    }
    finishTool();
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !layerRef.current || editing) return;
    const target = event.target instanceof Element ? event.target : null;
    const point = toPage(event);
    const client = { x: event.clientX, y: event.clientY };
    // Keep keyboard focus in the page view so Delete, arrow keys and the
    // clipboard apply to what is drawn or picked (pointer presses here do
    // not move focus by themselves).
    const focusPageView = () =>
      layerRef.current?.closest<HTMLElement>('[role="region"]')?.focus({ preventScroll: true });

    if (drawing) {
      event.preventDefault();
      event.stopPropagation();
      focusPageView();
      layerRef.current.setPointerCapture(event.pointerId);
      if (tool === 'note') {
        const position = {
          x: clamp(point.x, 0, Math.max(0, pageSize.width - NOTE_ICON_SIZE)),
          y: clamp(point.y, NOTE_ICON_SIZE, pageSize.height),
        };
        setEditing({
          isNew: true,
          annotation: {
            ...base(),
            kind: 'note',
            color: colorFor('note'),
            position,
            contents: '',
          },
        });
        finishTool();
        return;
      }
      if (tool === 'ink') {
        gesture.current = { type: 'ink', pointerId: event.pointerId, points: [point] };
        setPreview([inkPreview([point])]);
        return;
      }
      gesture.current = {
        type: 'box',
        pointerId: event.pointerId,
        tool,
        start: point,
        end: point,
        startClient: client,
      };
      return;
    }

    if (!selecting || !editable) return;
    const handle = target?.closest<SVGElement>('[data-handle]')?.dataset.handle as
      Handle | undefined;
    const annotationId = target?.closest<SVGElement>('[data-annotation-id]')?.dataset
      .annotationId as AnnotationId | undefined;
    const state = workspace.getState();
    if (handle || annotationId) focusPageView();
    if (handle && selected.length === 1) {
      const original = annotations.find((annotation) => annotation.id === selected[0]);
      if (!original) return;
      event.preventDefault();
      event.stopPropagation();
      layerRef.current.setPointerCapture(event.pointerId);
      gesture.current = {
        type: 'resize',
        pointerId: event.pointerId,
        handle,
        original,
        frame: mapRect(toDisplay, annotationFrame(original)),
        start: displayPointOf(point),
        moved: false,
        startClient: client,
      };
      return;
    }
    if (!annotationId) return;
    event.preventDefault();
    event.stopPropagation();
    let ids: AnnotationId[];
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      ids = selected.includes(annotationId)
        ? selected.filter((id) => id !== annotationId)
        : [...currentSelection(), annotationId];
      state.selectAnnotations(docKey, ids);
      return;
    }
    ids = selected.includes(annotationId) ? [...selected] : [annotationId];
    if (!selected.includes(annotationId)) state.selectAnnotations(docKey, ids);
    const originals = annotations.filter(
      (annotation) => ids.includes(annotation.id) && isMovable(annotation),
    );
    if (originals.length === 0) return;
    layerRef.current.setPointerCapture(event.pointerId);
    gesture.current = {
      type: 'move',
      pointerId: event.pointerId,
      start: point,
      originals,
      moved: false,
      startClient: client,
    };
  };

  /** Annotations selected anywhere in the document (Shift-click adds to them). */
  const currentSelection = () =>
    workspace.getState().documents.find((doc) => doc.key === docKey)?.selection.annotations ?? [];

  const inkPreview = (points: Point[]): Annotation => ({
    ...base(),
    id: 'annot_preview' as AnnotationId,
    kind: 'ink',
    color: colorFor('ink'),
    paths: [points],
    strokeWidth: ui.getState().style.strokeWidth,
  });

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.type === 'ink') {
      const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
      const minimum = 1.5 / ppu;
      for (const sample of events.length > 0 ? events : [event.nativeEvent]) {
        const point = toPage(sample);
        const last = current.points.at(-1)!;
        if (Math.hypot(point.x - last.x, point.y - last.y) >= minimum) current.points.push(point);
      }
      setPreview([inkPreview([...current.points])]);
      return;
    }
    const point = toPage(event);
    if (current.type === 'box') {
      current.end = point;
      const startDisplay = displayPointOf(current.start);
      const endDisplay = displayPointOf(point);
      if (current.tool === 'line' || current.tool === 'arrow') {
        const end = event.shiftKey ? snapLine(current.start, point) : point;
        setPreview([
          {
            ...base(),
            id: 'annot_preview' as AnnotationId,
            kind: 'shape',
            shape: current.tool,
            color: colorFor(current.tool),
            rect: {
              x: current.start.x,
              y: current.start.y,
              width: end.x - current.start.x,
              height: end.y - current.start.y,
            },
            strokeWidth: ui.getState().style.strokeWidth,
            fill: null,
          },
        ]);
      } else if (current.tool === 'rectangle' || current.tool === 'ellipse') {
        setPreview([
          {
            ...base(),
            id: 'annot_preview' as AnnotationId,
            kind: 'shape',
            shape: current.tool,
            color: colorFor(current.tool),
            rect: normalizeRect(boxFrom(current.start, point, event.shiftKey)),
            strokeWidth: ui.getState().style.strokeWidth,
            fill: ui.getState().style.fill,
          },
        ]);
      } else {
        // Text and image boxes show as a dashed outline while drawn.
        setPreview(null);
        setDraftBox(normalizeRect(boxFrom(startDisplay, endDisplay, false)));
      }
      return;
    }
    if (current.type === 'move') {
      if (
        !current.moved &&
        Math.hypot(event.clientX - current.startClient.x, event.clientY - current.startClient.y) <
          DRAG_THRESHOLD_PX
      ) {
        return;
      }
      current.moved = true;
      let dx = point.x - current.start.x;
      let dy = point.y - current.start.y;
      // Keep every frame on the page.
      for (const original of current.originals) {
        const frame = annotationFrame(original);
        dx = clamp(dx, -frame.x, pageSize.width - frame.x - frame.width);
        dy = clamp(dy, -frame.y, pageSize.height - frame.y - frame.height);
      }
      setPreview(current.originals.map((original) => moveAnnotation(original, dx, dy)));
      return;
    }
    // Resize: move the dragged edges in display space.
    if (
      !current.moved &&
      Math.hypot(event.clientX - current.startClient.x, event.clientY - current.startClient.y) <
        DRAG_THRESHOLD_PX
    ) {
      return;
    }
    current.moved = true;
    const now = displayPointOf(point);
    const dx = now.x - current.start.x;
    const dy = now.y - current.start.y;
    let { x, y, width, height } = current.frame;
    const { handle } = current;
    if (handle.includes('w')) {
      x += dx;
      width -= dx;
    }
    if (handle.includes('e')) width += dx;
    if (handle.includes('n')) {
      y += dy;
      height -= dy;
    }
    if (handle.includes('s')) height += dy;
    const minimum = MIN_SIZE;
    // Images keep their proportions on corner handles unless Shift is held.
    const keepAspect =
      handle.length === 2 &&
      (current.original.kind === 'added-image' || current.original.kind === 'signature') !==
        event.shiftKey;
    if (keepAspect && current.frame.height > 0) {
      const aspect = current.frame.width / current.frame.height;
      if (Math.abs(width) / aspect > Math.abs(height)) height = width / aspect;
      else width = height * aspect;
      if (handle.includes('w')) x = current.frame.x + current.frame.width - width;
      if (handle.includes('n')) y = current.frame.y + current.frame.height - height;
    }
    if (width < minimum) {
      if (handle.includes('w')) x -= minimum - width;
      width = minimum;
    }
    if (height < minimum) {
      if (handle.includes('n')) y -= minimum - height;
      height = minimum;
    }
    setPreview([withFrame(current.original, fromDisplayRect({ x, y, width, height }))]);
  };

  const [draftBox, setDraftBox] = useState<Rect | null>(null);

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    const changed = latestPreview.current;
    setPreview(null);
    setDraftBox(null);
    if (cancelled) return;
    const state = workspace.getState();
    switch (current.type) {
      case 'ink':
        if (current.points.length > 0) {
          commitNew(
            {
              ...base(),
              kind: 'ink',
              color: colorFor('ink'),
              paths: [current.points],
              strokeWidth: ui.getState().style.strokeWidth,
            },
            'Draw',
          );
        }
        break;
      case 'box':
        createFromBox({ ...current, end: toPage(event) }, event.shiftKey);
        break;
      case 'move':
        if (current.moved && changed) {
          state.updateAnnotations(docKey, changed, {
            label: changed.length === 1 ? 'Move comment' : `Move ${changed.length} comments`,
          });
        }
        break;
      case 'resize':
        if (current.moved && changed) {
          state.updateAnnotations(docKey, changed, { label: 'Resize comment' });
        }
        break;
    }
  };

  // Escape abandons a drag in progress.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !gesture.current) return;
      gesture.current = null;
      setPreview(null);
      setDraftBox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const startEditing = (annotationId: AnnotationId) => {
    const annotation = annotations.find((entry) => entry.id === annotationId);
    if (annotation && (annotation.kind === 'added-text' || annotation.kind === 'note')) {
      setEditing({ annotation, isNew: false });
    }
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!selecting || !editable) return;
    // Pointer capture (taken when a press may become a drag) retargets the
    // double click to this layer, so look up what is under the pointer.
    const id = document
      .elementsFromPoint(event.clientX, event.clientY)
      .map((element) => element.closest<SVGElement>('[data-annotation-id]')?.dataset.annotationId)
      .find((value) => value !== undefined);
    if (id) startEditing(id as AnnotationId);
  };

  // Other parts of the app (the comments list, Enter on a selection) ask to edit.
  useEffect(() => {
    const onEdit = (event: Event) => {
      const detail = (event as CustomEvent<{ docKey: string; id: AnnotationId }>).detail;
      if (detail.docKey === docKey) startEditing(detail.id);
    };
    window.addEventListener(EDIT_ANNOTATION_EVENT, onEdit);
    return () => window.removeEventListener(EDIT_ANNOTATION_EVENT, onEdit);
  });

  const finishEditing = (text: string | null) => {
    const current = editing;
    setEditing(null);
    if (!current || text === null) return;
    const state = workspace.getState();
    const { annotation, isNew } = current;
    const value = annotation.kind === 'note' ? annotation.contents : annotation.text;
    const updated =
      annotation.kind === 'note'
        ? { ...annotation, contents: text }
        : { ...annotation, text: text.replace(/\s+$/, '') };
    const empty = (updated.kind === 'note' ? updated.contents : updated.text).trim() === '';
    if (isNew) {
      // Text boxes need text; a note may be empty (its position says enough).
      if (updated.kind === 'added-text' && empty) return;
      commitNew(updated, updated.kind === 'note' ? 'Add note' : 'Add text');
    } else if (updated.kind === 'added-text' && empty) {
      state.deleteAnnotations(docKey, [annotation.id]);
    } else if (text !== value) {
      state.updateAnnotations(docKey, [updated], {
        label: updated.kind === 'note' ? 'Edit note' : 'Edit text',
      });
    }
  };

  // What is drawn: the document's annotations with previews in place.
  const previewIds = new Set(preview?.map((annotation) => annotation.id));
  const shown = annotations.filter(
    (annotation) => !previewIds.has(annotation.id) && annotation.id !== editing?.annotation.id,
  );
  const drafts = preview ?? [];
  const selectedShown = [...annotations, ...drafts].filter(
    (annotation) => selected.includes(annotation.id) && annotation.id !== editing?.annotation.id,
  );
  const resolvedSelection = selectedShown.map((annotation) => {
    const replaced = drafts.find((draft) => draft.id === annotation.id);
    return replaced ?? annotation;
  });
  const single =
    resolvedSelection.length === 1 && editable && selecting ? resolvedSelection[0]! : null;
  const slop = HIT_SLOP_PX / ppu;
  const handleSize = HANDLE_PX / ppu;

  const layerStyle: CSSProperties = {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    pointerEvents: drawing || editing ? 'auto' : 'none',
    cursor: drawing ? (tool === 'text' ? 'text' : 'crosshair') : undefined,
  };

  return (
    <div
      ref={layerRef}
      className="absolute touch-none select-none"
      style={layerStyle}
      data-annotation-layer={position + 1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endGesture(event, false)}
      onPointerCancel={(event) => endGesture(event, true)}
      onLostPointerCapture={(event) => {
        if (gesture.current?.pointerId === event.pointerId) endGesture(event, false);
      }}
      onDoubleClick={onDoubleClick}
    >
      <svg
        aria-hidden
        className="absolute inset-0 size-full overflow-visible"
        viewBox={`0 0 ${display.width} ${display.height}`}
        preserveAspectRatio="none"
        pointerEvents="none"
      >
        <g transform={svgMatrix(toDisplay)}>
          {shown.map((annotation) => (
            <g key={annotation.id} data-annotation-id={annotation.id}>
              <AnnotationShape
                annotation={annotation}
                imageUrl={
                  'assetId' in annotation ? workspace.getAssetUrl(docKey, annotation.assetId) : null
                }
              />
              {selecting && editable && !MARKUP_TOOLS.has(tool) ? (
                <AnnotationHitArea annotation={annotation} slop={slop} />
              ) : null}
            </g>
          ))}
          {drafts.map((annotation) => (
            <g key={`draft-${annotation.id}`}>
              <AnnotationShape
                annotation={annotation}
                imageUrl={
                  'assetId' in annotation ? workspace.getAssetUrl(docKey, annotation.assetId) : null
                }
              />
            </g>
          ))}
        </g>
        {resolvedSelection.map((annotation) => {
          const frame = mapRect(toDisplay, annotationFrame(annotation));
          return (
            <rect
              key={`selection-${annotation.id}`}
              x={frame.x}
              y={frame.y}
              width={frame.width}
              height={frame.height}
              fill="none"
              className="stroke-accent"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {single && isResizable(single)
          ? (() => {
              const frame = mapRect(toDisplay, annotationFrame(single));
              return HANDLES.map((handle) => {
                const cx = handle.includes('w')
                  ? frame.x
                  : handle.includes('e')
                    ? frame.x + frame.width
                    : frame.x + frame.width / 2;
                const cy = handle.includes('n')
                  ? frame.y
                  : handle.includes('s')
                    ? frame.y + frame.height
                    : frame.y + frame.height / 2;
                return (
                  <rect
                    key={handle}
                    data-handle={handle}
                    x={cx - handleSize / 2}
                    y={cy - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    className="fill-raised stroke-accent"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="all"
                    style={{ cursor: HANDLE_CURSOR[handle] }}
                  />
                );
              });
            })()
          : null}
        {draftBox ? (
          <rect
            x={draftBox.x}
            y={draftBox.y}
            width={draftBox.width}
            height={draftBox.height}
            fill="none"
            className="stroke-accent"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      {editing ? (
        <TextEditor
          key={editing.annotation.id}
          editing={editing}
          toDisplay={(rect) => mapRect(toDisplay, rect)}
          ppu={ppu}
          displayRotation={rotation}
          onDone={finishEditing}
        />
      ) : null}
    </div>
  );
});

/** Ask the page showing an annotation to start editing its text. */
export const EDIT_ANNOTATION_EVENT = 'folio:edit-annotation';

/**
 * Typing into a text box or a note. Text boxes are edited in place, in the
 * box's font; notes in a small card beside their icon.
 */
function TextEditor({
  editing,
  toDisplay,
  ppu,
  displayRotation: shownRotation,
  onDone,
}: {
  editing: TextEditing;
  toDisplay: (rect: Rect) => Rect;
  ppu: number;
  displayRotation: Rotation;
  onDone(text: string | null): void;
}) {
  const { annotation } = editing;
  const ref = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  const initial = annotation.kind === 'note' ? annotation.contents : annotation.text;

  useEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  const done = (text: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(text);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      done(editing.isNew && annotation.kind === 'added-text' ? null : initial);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      done(event.currentTarget.value);
    }
  };

  let style: CSSProperties;
  let className: string;
  if (annotation.kind === 'added-text') {
    const frame = contentFrame(annotation.rect, annotation.rotation);
    const shown = toDisplay(normalizeRect(annotation.rect));
    const width = frame.width * ppu;
    const height = frame.height * ppu;
    // The text is turned on screen by however far the page turned since it was added.
    const turn = (shownRotation - annotation.rotation + 360) % 360;
    style = {
      left: (shown.x + shown.width / 2) * ppu - width / 2,
      top: (shown.y + shown.height / 2) * ppu - height / 2,
      width,
      height,
      transform: turn ? `rotate(${turn}deg)` : undefined,
      fontFamily: FONT_STACKS[annotation.fontFamily],
      fontSize: annotation.fontSize * ppu,
      lineHeight: LINE_HEIGHT,
      padding: `${TEXT_PADDING * ppu}px`,
      color: annotation.color,
    };
    className =
      'absolute resize-none overflow-hidden border border-dashed border-accent bg-[oklch(1_0_0/0.75)] outline-none [color-scheme:light]';
  } else {
    const icon = toDisplay({
      x: annotation.position.x,
      y: annotation.position.y - NOTE_ICON_SIZE,
      width: NOTE_ICON_SIZE,
      height: NOTE_ICON_SIZE,
    });
    style = {
      left: (icon.x + icon.width) * ppu + 6,
      top: icon.y * ppu,
      width: 240,
      height: 120,
    };
    className =
      'absolute z-10 resize-none rounded-md border border-line bg-raised p-2 text-sm text-ink shadow-pop outline-none focus-visible:outline-2 focus-visible:outline-focus';
  }

  return (
    <textarea
      ref={ref}
      aria-label={annotation.kind === 'note' ? 'Note' : 'Text box'}
      placeholder={annotation.kind === 'note' ? 'Write a note…' : 'Type here…'}
      defaultValue={initial}
      spellCheck
      className={cn(className)}
      style={style}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => done(event.currentTarget.value)}
    />
  );
}
