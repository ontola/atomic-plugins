// @wc-ignore-file
/** Test helpers for the three apps' views: a fake host store and a manual animation-frame clock. */
import type { Scheme, ThemeStore } from './host.js';

export interface FakeStore extends ThemeStore {
  scheme: Scheme | undefined;
  /** Simulates the host switching theme. */
  switchTo(scheme: Scheme): void;
}

export function fakeStore(scheme: Scheme | undefined = 'light'): FakeStore {
  const handlers = new Set<(t: { colorScheme?: Scheme }) => void>();
  const store: FakeStore = {
    scheme,
    getTheme: () => ({ colorScheme: store.scheme }),
    onThemeChange(handler) {
      handlers.add(handler);

      return () => handlers.delete(handler);
    },
    switchTo(next) {
      store.scheme = next;
      for (const handler of handlers) handler({ colorScheme: next });
    },
  };

  return store;
}

export interface Frames {
  /** Callbacks waiting for the next frame. */
  pending(): number;
  /** Runs one frame `ms` after the previous one; returns whether one was waiting. */
  tick(ms?: number): boolean;
  /** Runs `count` frames of `ms`. */
  run(count: number, ms?: number): void;
  restore(): void;
}

/** Replaces the window's requestAnimationFrame with a clock the test advances. */
export function frames(win: Window = window): Frames {
  const original = {
    raf: win.requestAnimationFrame,
    cancel: win.cancelAnimationFrame,
  };
  let next = 1;
  let now = 1000;
  const queue = new Map<number, FrameRequestCallback>();

  win.requestAnimationFrame = cb => {
    queue.set(next, cb);

    return next++;
  };

  win.cancelAnimationFrame = id => void queue.delete(id);

  const tick = (ms = 16) => {
    const waiting = [...queue];
    queue.clear();
    now += ms;
    for (const [, cb] of waiting) cb(now);

    return waiting.length > 0;
  };

  return {
    pending: () => queue.size,
    tick,
    run(count, ms = 16) {
      for (let i = 0; i < count; i += 1) tick(ms);
    },
    restore() {
      win.requestAnimationFrame = original.raf;
      win.cancelAnimationFrame = original.cancel;
    },
  };
}

/** Sets `document.visibilityState` and fires `visibilitychange`. */
export function setVisibility(
  doc: Document,
  state: 'visible' | 'hidden',
): void {
  Object.defineProperty(doc, 'visibilityState', {
    value: state,
    configurable: true,
  });
  doc.dispatchEvent(new Event('visibilitychange'));
}

export const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise(r => setTimeout(r, 0));
};

export const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

export function setLanguage(language: string): void {
  Object.defineProperty(window.navigator, 'language', {
    value: language,
    configurable: true,
  });
}

/** A keydown on an element, as a key press would send it. */
export function press(
  el: Element,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  el.dispatchEvent(event);

  return event;
}

/** Fakes the layout of an SVG: jsdom reports zero sizes. */
export function layOut(svg: Element, width: number, height: number): void {
  (svg as SVGSVGElement).getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
}

/** A pointer event at a client position (jsdom has no PointerEvent). */
export function pointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
): void {
  el.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}
