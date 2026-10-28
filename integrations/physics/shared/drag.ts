// @wc-ignore-file
/** Pointer dragging and arrow-key moving for SVG handles. */

export interface Point {
  x: number;
  y: number;
}

/**
 * A client (viewport) position as a point in the SVG's own user units, from
 * its bounding box and viewBox, for the default `xMidYMid meet` alignment the
 * apps use.
 */
export function clientToSvg(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): Point {
  const rect = svg.getBoundingClientRect();
  const [bx, by, bw, bh] = (svg.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .map(Number);
  const box = { x: bx || 0, y: by || 0 };
  const [vw, vh] = [bw || rect.width || 1, bh || rect.height || 1];
  const scale =
    Math.min((rect.width || vw) / vw, (rect.height || vh) / vh) || 1;
  const [ox, oy] = [
    (rect.width - vw * scale) / 2,
    (rect.height - vh * scale) / 2,
  ];

  return {
    x: box.x + (clientX - rect.left - ox) / scale,
    y: box.y + (clientY - rect.top - oy) / scale,
  };
}

export interface DragOptions {
  /** Called with the pointer position in SVG units, and the offset between it and where the grab started. */
  onMove: (at: Point, grab: Point) => void;
  /** The pointer went down on the handle; return where the handle is, in SVG units, to keep the grab offset. */
  onStart?: (at: Point) => Point | void;
  onEnd?: () => void;
}

/**
 * Makes `handle` draggable. The handle keeps the point where it was grabbed
 * under the pointer (`grab` is the offset from the handle's own position, as
 * `onStart` returned it, or zero).
 */
export function draggable(
  handle: Element,
  svg: SVGSVGElement,
  { onMove, onStart, onEnd }: DragOptions,
): void {
  let grab: Point | undefined;

  handle.addEventListener('pointerdown', raw => {
    const event = raw as PointerEvent;
    if (event.button !== undefined && event.button > 0) return;
    const at = clientToSvg(svg, event.clientX, event.clientY);
    const origin = onStart?.(at);
    grab = origin ? { x: origin.x - at.x, y: origin.y - at.y } : { x: 0, y: 0 };

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer to capture.
    }

    if (handle instanceof SVGElement || handle instanceof HTMLElement)
      handle.focus({ preventScroll: true });
    event.preventDefault();
  });

  handle.addEventListener('pointermove', raw => {
    if (!grab) return;
    const event = raw as PointerEvent;
    onMove(clientToSvg(svg, event.clientX, event.clientY), grab);
  });

  const end = () => {
    if (!grab) return;
    grab = undefined;
    onEnd?.();
  };

  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

export type Arrow = 'left' | 'right' | 'up' | 'down';

const ARROWS: Record<string, Arrow> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/**
 * Calls `onArrow` for the arrow keys on `handle`, with the modifiers, and
 * stops the page from scrolling. Other keys go to `onOther`, which returns
 * true when it used the key.
 */
export function arrowKeys(
  handle: Element,
  onArrow: (arrow: Arrow, event: KeyboardEvent) => void,
  onOther?: (event: KeyboardEvent) => boolean,
): void {
  handle.addEventListener('keydown', raw => {
    const event = raw as KeyboardEvent;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const arrow = ARROWS[event.key];
    if (arrow) {
      onArrow(arrow, event);
      event.preventDefault();
    } else if (onOther?.(event)) event.preventDefault();
  });
}

export const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));
