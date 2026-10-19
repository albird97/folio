import { cn } from '@folio/shared-ui';
import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  drawStrokes,
  INK_COLORS,
  PAD_SIZE,
  type Ink,
  type Stroke,
  type StrokePoint,
} from '../../signature/render';

/** Width of the pen, in pad units: a fine felt-tip at the pad's usual size. */
const PEN_WIDTH = 3.2;
/** Samples closer than this to the previous one (pad units) only add jitter. */
const MIN_STEP = 0.6;

/** The canvas's size in device pixels, following its box and the screen's pixel ratio. */
export function useCanvasPixels(canvas: RefObject<HTMLCanvasElement | null>) {
  const [pixels, setPixels] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(element.clientWidth * ratio));
      const height = Math.max(1, Math.round(element.clientHeight * ratio));
      setPixels((previous) =>
        previous?.width === width && previous.height === height ? previous : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvas]);
  return pixels;
}

/**
 * White, like paper, with a line to sign on, whatever the theme: the pad and
 * the previews show the signature as it will look on the page.
 */
export function Paper({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md bg-page shadow-[inset_0_0_0_1px_var(--folio-border-strong)]',
        className,
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-[6%] top-[70%] border-t border-[oklch(0.2_0.02_230/0.25)]"
      />
      {children}
    </div>
  );
}

/** Pens draw wider when pressed harder; mice and fingers draw evenly. */
const widthAt = (event: PointerEvent) =>
  event.pointerType === 'pen' && event.pressure > 0
    ? PEN_WIDTH * (0.45 + event.pressure * 1.1)
    : PEN_WIDTH;

function paint(
  canvas: HTMLCanvasElement | null,
  strokes: readonly Stroke[],
  drawing: Stroke | null,
  ink: Ink,
) {
  const context = canvas?.getContext('2d');
  if (!canvas || !context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawStrokes(
    context,
    drawing ? [...strokes, drawing] : strokes,
    INK_COLORS[ink],
    canvas.width / PAD_SIZE.width,
  );
}

/**
 * Draws a signature with a mouse, trackpad, pen or finger. Strokes are kept
 * in pad units, so the pad can change size without losing them. (The Type and
 * Image tabs are the ways to sign with a keyboard.)
 */
export function SignaturePad({
  strokes,
  ink,
  onChange,
  describedBy,
}: {
  strokes: readonly Stroke[];
  ink: Ink;
  onChange(strokes: Stroke[]): void;
  describedBy: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ pointerId: number; points: StrokePoint[] } | null>(null);
  const pixels = useCanvasPixels(canvasRef);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pixels) return;
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width;
      canvas.height = pixels.height;
    }
    paint(canvas, strokes, drawing.current?.points ?? null, ink);
  }, [pixels, strokes, ink]);

  const pointAt = (event: PointerEvent): StrokePoint => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * PAD_SIZE.width,
      y: ((event.clientY - rect.top) / rect.height) * PAD_SIZE.height,
      width: widthAt(event),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || drawing.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = { pointerId: event.pointerId, points: [pointAt(event.nativeEvent)] };
    paint(canvasRef.current, strokes, drawing.current.points, ink);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drawing.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // Fast strokes deliver several samples per event.
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) {
      const point = pointAt(sample);
      const last = current.points.at(-1)!;
      if (Math.hypot(point.x - last.x, point.y - last.y) >= MIN_STEP) current.points.push(point);
    }
    paint(canvasRef.current, strokes, current.points, ink);
  };

  const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drawing.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drawing.current = null;
    onChange([...strokes, current.points]);
  };

  return (
    <Paper>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Signature pad"
        aria-describedby={describedBy}
        className="relative block aspect-[3/1] w-full cursor-crosshair touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
    </Paper>
  );
}
