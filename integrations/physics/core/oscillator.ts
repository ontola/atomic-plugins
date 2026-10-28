// @wc-ignore-file
/**
 * A mass on a spring with linear damping, pure functions with no DOM.
 *
 *   m u'' + c u' + C u = 0,   u(0) = A, u'(0) = 0
 *
 * u is the displacement from the rest position (m), m the mass (kg), C the
 * spring constant (N/m), c the damping coefficient (kg/s, N s/m) and A the
 * amplitude (m). Gravity only shifts the rest position, so it is left out.
 */

export interface Spring {
  /** Mass, kg. */
  m: number;
  /** Spring constant, N/m. */
  C: number;
  /** Damping coefficient, kg/s. 0 means undamped. */
  c: number;
}

export interface State {
  t: number;
  u: number;
  /** Velocity u', m/s. */
  w: number;
}

/** T = 2 pi sqrt(m / C), the period without damping. */
export const naturalPeriod = (m: number, C: number) =>
  2 * Math.PI * Math.sqrt(m / C);

/** omega0 = sqrt(C / m), rad/s. */
export const naturalOmega = ({ m, C }: Spring) => Math.sqrt(C / m);

/** gamma = c / (2 m), the decay rate of the envelope, 1/s. */
export const decayRate = ({ m, c }: Spring) => c / (2 * m);

/** The damping that is just enough to stop it oscillating: 2 sqrt(m C). */
export const criticalDamping = ({ m, C }: Spring) => 2 * Math.sqrt(m * C);

export type Regime = 'undamped' | 'under' | 'critical' | 'over';

/** Within this relative distance of the critical damping the motion counts as critical. */
const CRITICAL_BAND = 1e-9;

export function regime(spring: Spring): Regime {
  if (spring.c <= 0) return 'undamped';
  const ratio = spring.c / criticalDamping(spring);
  if (Math.abs(ratio - 1) < CRITICAL_BAND) return 'critical';

  return ratio < 1 ? 'under' : 'over';
}

/** Damping ratio zeta = c / (2 sqrt(m C)). */
export const dampingRatio = (spring: Spring) =>
  spring.c / criticalDamping(spring);

/**
 * The period of the damped motion, 2 pi / sqrt(omega0^2 - gamma^2), or
 * Infinity when the damping is critical or more, where it does not oscillate.
 */
export function dampedPeriod(spring: Spring): number {
  const w0 = naturalOmega(spring);
  const g = decayRate(spring);
  const gap = w0 * w0 - g * g;

  return gap > w0 * w0 * 1e-12 ? (2 * Math.PI) / Math.sqrt(gap) : Infinity;
}

/** The closed-form solution at time t, for u(0) = A, u'(0) = 0. */
export function exact(spring: Spring, amplitude: number, t: number): State {
  const w0 = naturalOmega(spring);
  const g = decayRate(spring);
  const gap = w0 * w0 - g * g;
  const decay = Math.exp(-g * t);

  if (gap > w0 * w0 * 1e-12) {
    const wd = Math.sqrt(gap);
    const [cos, sin] = [Math.cos(wd * t), Math.sin(wd * t)];

    return {
      t,
      u: amplitude * decay * (cos + (g / wd) * sin),
      w: -amplitude * decay * ((w0 * w0) / wd) * sin,
    };
  }

  if (gap > -w0 * w0 * 1e-12) {
    // Critical: u = A (1 + g t) e^(-g t).
    return {
      t,
      u: amplitude * (1 + g * t) * decay,
      w: -amplitude * g * g * t * decay,
    };
  }

  const r = Math.sqrt(-gap);
  const [cosh, sinh] = [Math.cosh(r * t), Math.sinh(r * t)];

  return {
    t,
    u: amplitude * decay * (cosh + (g / r) * sinh),
    w: -amplitude * decay * ((w0 * w0) / r) * sinh,
  };
}

/** The initial state: released at rest from the amplitude. */
export const start = (amplitude: number): State => ({
  t: 0,
  u: amplitude,
  w: 0,
});

/** u'' for the state, from m u'' = -C u - c u'. */
const acceleration = ({ m, C, c }: Spring, u: number, w: number) =>
  (-C * u - c * w) / m;

/** One classical Runge-Kutta (RK4) step of length dt. */
export function step(spring: Spring, s: State, dt: number): State {
  const a1 = acceleration(spring, s.u, s.w);
  const [u1, w1] = [s.u + (dt / 2) * s.w, s.w + (dt / 2) * a1];
  const a2 = acceleration(spring, u1, w1);
  const [u2, w2] = [s.u + (dt / 2) * w1, s.w + (dt / 2) * a2];
  const a3 = acceleration(spring, u2, w2);
  const [u3, w3] = [s.u + dt * w2, s.w + dt * a3];
  const a4 = acceleration(spring, u3, w3);

  return {
    t: s.t + dt,
    u: s.u + (dt / 6) * (s.w + 2 * w1 + 2 * w2 + w3),
    w: s.w + (dt / 6) * (a1 + 2 * a2 + 2 * a3 + a4),
  };
}

/**
 * Advances a state by `elapsed` seconds in fixed steps of at most `maxStep`,
 * so that the result does not depend on the frame rate. Calls `each` with
 * every intermediate state.
 */
export function advance(
  spring: Spring,
  s: State,
  elapsed: number,
  maxStep = 1 / 240,
  each?: (state: State) => void,
): State {
  const n = Math.max(1, Math.ceil(elapsed / maxStep));
  const dt = elapsed / n;
  let state = s;

  for (let i = 0; i < n; i += 1) {
    state = step(spring, state, dt);
    each?.(state);
  }

  return state;
}

/** Total energy, 1/2 m u'^2 + 1/2 C u^2, in joules. */
export const energy = ({ m, C }: Spring, { u, w }: State) =>
  0.5 * m * w * w + 0.5 * C * u * u;

/**
 * Measures the period from samples of u(t): the time between two successive
 * upward crossings of u = 0, each found by linear interpolation. Feed it every
 * sample in time order. For the damped motion consecutive crossings of the same
 * direction are exactly one damped period apart.
 */
export class PeriodMeter {
  private last?: { t: number; u: number };
  /** The times of the upward zero crossings found so far. */
  readonly crossings: number[] = [];

  push(t: number, u: number): void {
    const prev = this.last;
    this.last = { t, u };
    if (!prev || !(prev.u < 0 && u >= 0)) return;
    const frac = -prev.u / (u - prev.u);
    this.crossings.push(prev.t + frac * (t - prev.t));
  }

  /** The most recent full period, or undefined before two crossings. */
  get period(): number | undefined {
    const n = this.crossings.length;

    return n >= 2 ? this.crossings[n - 1] - this.crossings[n - 2] : undefined;
  }

  reset(): void {
    this.last = undefined;
    this.crossings.length = 0;
  }
}
