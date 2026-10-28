// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  advance,
  criticalDamping,
  dampedPeriod,
  dampingRatio,
  energy,
  exact,
  naturalPeriod,
  PeriodMeter,
  regime,
  start,
  step,
  type Spring,
} from './oscillator.js';

const spring = (m: number, C: number, c = 0): Spring => ({ m, C, c });

describe('periods', () => {
  it('has T = 2 pi sqrt(m / C)', () => {
    expect(naturalPeriod(0.5, 20)).toBeCloseTo(
      2 * Math.PI * Math.sqrt(0.025),
      12,
    );
    expect(naturalPeriod(1, 4 * Math.PI * Math.PI)).toBeCloseTo(1, 12);
    // Four times the mass, twice the period.
    expect(naturalPeriod(4, 10) / naturalPeriod(1, 10)).toBeCloseTo(2, 12);
  });

  it('has a longer damped period than natural one, equal when c = 0', () => {
    const s = spring(0.5, 20, 0);
    expect(dampedPeriod(s)).toBeCloseTo(naturalPeriod(0.5, 20), 12);
    expect(dampedPeriod({ ...s, c: 3 })).toBeGreaterThan(
      naturalPeriod(0.5, 20),
    );
  });

  it('has no period at or beyond critical damping', () => {
    const s = spring(0.5, 20);
    const critical = criticalDamping(s);
    expect(critical).toBeCloseTo(2 * Math.sqrt(10), 12);
    expect(dampedPeriod({ ...s, c: critical })).toBe(Infinity);
    expect(dampedPeriod({ ...s, c: critical * 2 })).toBe(Infinity);
  });
});

describe('regime', () => {
  const s = spring(0.5, 20);

  it('tells the four cases apart', () => {
    expect(regime(s)).toBe('undamped');
    expect(regime({ ...s, c: 1 })).toBe('under');
    expect(regime({ ...s, c: criticalDamping(s) })).toBe('critical');
    expect(regime({ ...s, c: 10 })).toBe('over');
    expect(dampingRatio({ ...s, c: criticalDamping(s) })).toBeCloseTo(1, 12);
  });
});

describe('exact solution', () => {
  it('starts at the amplitude at rest', () => {
    for (const c of [0, 1, criticalDamping(spring(0.5, 20)), 12]) {
      const s = exact(spring(0.5, 20, c), 0.1, 0);
      expect(s.u).toBeCloseTo(0.1, 12);
      expect(s.w).toBeCloseTo(0, 12);
    }
  });

  it('is A cos(omega t) without damping', () => {
    const s = spring(0.5, 20);
    const w0 = Math.sqrt(40);

    for (const t of [0.1, 0.37, 1.2, 5]) {
      expect(exact(s, 0.08, t).u).toBeCloseTo(0.08 * Math.cos(w0 * t), 12);
      expect(exact(s, 0.08, t).w).toBeCloseTo(
        -0.08 * w0 * Math.sin(w0 * t),
        12,
      );
    }
  });

  it('returns to the start after one natural period without damping', () => {
    const s = spring(2, 8);
    const state = exact(s, 0.05, naturalPeriod(2, 8));
    expect(state.u).toBeCloseTo(0.05, 12);
    expect(state.w).toBeCloseTo(0, 10);
  });

  it('decays monotonically to zero when critically and over damped, without crossing zero', () => {
    const base = spring(0.5, 20);

    for (const c of [criticalDamping(base), 12]) {
      let prev = Infinity;

      for (let t = 0; t < 4; t += 0.05) {
        const { u } = exact({ ...base, c }, 0.1, t);
        expect(u).toBeGreaterThan(0);
        expect(u).toBeLessThanOrEqual(prev);
        prev = u;
      }
    }
  });

  it('keeps its derivative consistent with u (finite difference)', () => {
    for (const c of [0, 2, criticalDamping(spring(0.5, 20)), 12]) {
      const s = spring(0.5, 20, c);
      const [t, e] = [0.43, 1e-6];
      const slope = (exact(s, 0.1, t + e).u - exact(s, 0.1, t - e).u) / (2 * e);
      expect(exact(s, 0.1, t).w).toBeCloseTo(slope, 6);
    }
  });
});

describe('RK4 integration', () => {
  it('follows the exact solution for every regime', () => {
    const base = spring(0.5, 20);

    for (const c of [0, 1.5, criticalDamping(base), 12]) {
      const s = { ...base, c };
      const end = advance(s, start(0.1), 3, 1 / 240);
      const ref = exact(s, 0.1, 3);
      expect(end.t).toBeCloseTo(3, 9);
      expect(end.u).toBeCloseTo(ref.u, 7);
      expect(end.w).toBeCloseTo(ref.w, 6);
    }
  });

  it('does not depend on how a time span is cut into frames', () => {
    const s = spring(1, 30, 0.8);
    const once = advance(s, start(0.07), 1);
    let framed = start(0.07);
    for (let i = 0; i < 60; i += 1) framed = advance(s, framed, 1 / 60);
    expect(framed.u).toBeCloseTo(once.u, 8);
  });

  it('conserves energy without damping and loses it with damping', () => {
    const free = spring(0.5, 20);
    const e0 = energy(free, start(0.1));
    expect(energy(free, advance(free, start(0.1), 20))).toBeCloseTo(e0, 8);

    const damped = { ...free, c: 1 };
    let state = start(0.1);
    let prev = e0;

    for (let i = 0; i < 20; i += 1) {
      state = advance(damped, state, 0.25);
      const e = energy(damped, state);
      expect(e).toBeLessThan(prev);
      prev = e;
    }
  });

  it('takes one step of the right length', () => {
    expect(step(spring(1, 1), start(1), 0.01).t).toBeCloseTo(0.01, 12);
  });

  it('calls back for each sub step', () => {
    let calls = 0;
    advance(spring(1, 1), start(1), 0.1, 1 / 100, () => (calls += 1));
    expect(calls).toBe(10);
  });
});

describe('PeriodMeter', () => {
  const run = (s: Spring, amplitude: number, seconds: number) => {
    const meter = new PeriodMeter();
    let state = start(amplitude);
    meter.push(state.t, state.u);
    advance(s, state, seconds, 1 / 240, next => meter.push(next.t, next.u));

    return meter;
  };

  it('needs two upward crossings', () => {
    const s = spring(0.5, 20);
    const T = naturalPeriod(0.5, 20);
    // u starts at +A, so crossings up happen at 0.75 T and 1.75 T.
    expect(run(s, 0.1, 0.5 * T).period).toBeUndefined();
    expect(run(s, 0.1, 1.2 * T).period).toBeUndefined();
    expect(run(s, 0.1, 2 * T).period).toBeDefined();
  });

  it('measures T = 2 pi sqrt(m / C) without damping', () => {
    for (const [m, C] of [
      [0.5, 20],
      [2, 5],
      [0.1, 80],
    ]) {
      const meter = run(spring(m, C), 0.05, 6 * naturalPeriod(m, C));
      expect(meter.period).toBeCloseTo(naturalPeriod(m, C), 5);
    }
  });

  it('measures the damped period with damping', () => {
    const s = spring(0.5, 20, 2);
    const meter = run(s, 0.1, 6 * dampedPeriod(s));
    expect(meter.period).toBeCloseTo(dampedPeriod(s), 4);
    expect(meter.period!).toBeGreaterThan(naturalPeriod(0.5, 20));
  });

  it('finds no crossing when over damped, and forgets on reset', () => {
    const s = spring(0.5, 20, 12);
    const meter = run(s, 0.1, 5);
    expect(meter.crossings).toEqual([]);
    const free = run(spring(0.5, 20), 0.1, 3);
    expect(free.crossings.length).toBeGreaterThan(0);
    free.reset();
    expect(free.crossings).toEqual([]);
    expect(free.period).toBeUndefined();
  });
});
