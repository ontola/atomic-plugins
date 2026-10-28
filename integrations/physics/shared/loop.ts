// @wc-ignore-file
/**
 * A frame loop that costs nothing while nobody can see it.
 *
 * `wake()` asks for frames; the loop then calls `frame(now, dt)` once per
 * animation frame for as long as it returns true. It stops asking the browser
 * for frames when the document is hidden or the app has scrolled out of view,
 * and picks up again when it is shown, without a jump in `dt`. So
 * `requestAnimationFrame` is only pending while the app is visible and has
 * something to animate.
 */
export interface Loop {
  /** Ask for frames (a no-op while they are already coming). */
  wake(): void;
  /** Whether a frame is scheduled right now. */
  readonly scheduled: boolean;
  /** Whether the app counts as visible. */
  readonly visible: boolean;
  destroy(): void;
}

/** Longest `dt` handed to a frame, so a stalled tab does not jump the simulation. */
export const MAX_DT = 0.05;

export function createLoop(
  doc: Document,
  target: Element,
  frame: (now: number, dt: number) => boolean,
): Loop {
  const win = doc.defaultView;
  let wanted = false;
  let id: number | undefined;
  let last: number | undefined;
  let inView = true;
  let destroyed = false;

  const shown = () => doc.visibilityState !== 'hidden' && inView;

  const tick = (now: number) => {
    id = undefined;
    if (destroyed || !wanted || !shown()) return;
    const dt = last === undefined ? 0 : Math.min(MAX_DT, (now - last) / 1000);
    last = now;
    wanted = frame(now, dt);
    if (wanted) schedule();
    else last = undefined;
  };

  const schedule = () => {
    if (id !== undefined || destroyed || !wanted || !shown() || !win) return;
    id = win.requestAnimationFrame(tick);
  };

  const pause = () => {
    if (id !== undefined) win?.cancelAnimationFrame(id);
    id = undefined;
    last = undefined;
  };

  const onVisibility = () => (shown() ? schedule() : pause());
  doc.addEventListener('visibilitychange', onVisibility);

  let observer: IntersectionObserver | undefined;

  if (win && 'IntersectionObserver' in win) {
    observer = new win.IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      inView = entry.isIntersecting;
      onVisibility();
    });
    observer.observe(target);
  }

  return {
    wake() {
      wanted = true;
      schedule();
    },
    get scheduled() {
      return id !== undefined;
    },
    get visible() {
      return shown();
    },
    destroy() {
      destroyed = true;
      pause();
      doc.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
    },
  };
}
