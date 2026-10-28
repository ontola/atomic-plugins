// @wc-ignore-file
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoop, MAX_DT } from './loop.js';
import { frames, setVisibility, type Frames } from './testing.js';

let clock: Frames;
beforeEach(() => {
  clock = frames();
});
afterEach(() => {
  clock.restore();
  setVisibility(document, 'visible');
});

describe('createLoop', () => {
  it('asks for no frame until woken', () => {
    const loop = createLoop(document, document.body, () => true);
    expect(clock.pending()).toBe(0);
    expect(loop.scheduled).toBe(false);
    loop.destroy();
  });

  it('runs frames while the callback returns true, then stops asking', () => {
    const frame = vi.fn(() => frame.mock.calls.length < 3);
    const loop = createLoop(document, document.body, frame);
    loop.wake();
    loop.wake();
    expect(clock.pending()).toBe(1);
    clock.run(10);
    expect(frame).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
    loop.destroy();
  });

  it('passes dt in seconds, 0 on the first frame and capped after a stall', () => {
    const dts: number[] = [];
    const loop = createLoop(document, document.body, (_now, dt) => {
      dts.push(dt);

      return true;
    });
    loop.wake();
    clock.tick(16);
    clock.tick(20);
    clock.tick(5000);
    expect(dts[0]).toBe(0);
    expect(dts[1]).toBeCloseTo(0.02, 6);
    expect(dts[2]).toBe(MAX_DT);
    loop.destroy();
  });

  it('has no frame pending while the document is hidden, and resumes without a jump', () => {
    const dts: number[] = [];
    const loop = createLoop(document, document.body, (_n, dt) => {
      dts.push(dt);

      return true;
    });
    loop.wake();
    clock.run(3);
    expect(clock.pending()).toBe(1);

    setVisibility(document, 'hidden');
    expect(clock.pending()).toBe(0);
    expect(loop.visible).toBe(false);
    loop.wake();
    expect(clock.pending()).toBe(0);
    expect(clock.tick(10_000)).toBe(false);

    setVisibility(document, 'visible');
    expect(clock.pending()).toBe(1);
    clock.tick(16);
    expect(dts[dts.length - 1]).toBe(0);
    loop.destroy();
  });

  it('pauses when scrolled out of view', () => {
    let notify: (
      entries: Partial<IntersectionObserverEntry>[],
    ) => void = () => {};

    class FakeObserver {
      constructor(cb: typeof notify) {
        notify = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    (
      window as unknown as { IntersectionObserver: unknown }
    ).IntersectionObserver = FakeObserver;
    const loop = createLoop(document, document.body, () => true);
    loop.wake();
    expect(clock.pending()).toBe(1);
    notify([{ isIntersecting: false }]);
    expect(clock.pending()).toBe(0);
    notify([{ isIntersecting: true }]);
    expect(clock.pending()).toBe(1);
    loop.destroy();
    delete (window as unknown as { IntersectionObserver?: unknown })
      .IntersectionObserver;
    vi.unstubAllGlobals();
  });

  it('stops for good when destroyed', () => {
    const loop = createLoop(document, document.body, () => true);
    loop.wake();
    loop.destroy();
    expect(clock.pending()).toBe(0);
    loop.wake();
    expect(clock.pending()).toBe(0);
  });
});
