// @wc-ignore-file
/**
 * Bar magnets in a plane, pure functions with no DOM.
 *
 * Each magnet is modelled as a pair of magnetic poles, +q (north) and -q
 * (south), a little inside the two ends. A pole produces the field
 * B = q d / |d|^3 (d the vector from the pole), the same inverse-square law as
 * a point charge, softened by a small radius so the field stays finite on a
 * pole. Everything lies in one plane through the magnets' axes, so the field
 * lines drawn in that plane are the real lines of force. Far from a magnet the
 * pair field turns into the field of a point dipole (`dipoleField`). Units are
 * arbitrary: a pole of strength 1 gives a field of 1 at distance 1.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Magnet {
  /** Centre. */
  x: number;
  y: number;
  /** Direction of the north pole, radians, counterclockwise from +x. */
  angle: number;
  /** Length of the bar. */
  length: number;
  /** Width of the bar. */
  width: number;
  /** Pole strength, > 0. */
  strength: number;
}

export interface Pole extends Vec {
  /** +strength for a north pole, -strength for a south pole. */
  q: number;
  kind: 'N' | 'S';
  /** Index of the magnet in the list it came from. */
  magnet: number;
}

/** How far a pole sits inside the end face of the bar. */
export const POLE_INSET = 0.3;

/** Softening radius of the field around a pole. */
export const SOFTENING = 0.15;

export const makeMagnet = (
  x: number,
  y: number,
  angle = 0,
  length = 6,
  width = 1.4,
  strength = 1,
): Magnet => ({ x, y, angle, length, width, strength });

/** Pole separation = bar length minus the two insets. */
export const poleSeparation = (m: Magnet) => m.length - 2 * POLE_INSET;

/** The north and south pole of a magnet. */
export function poles(m: Magnet, index = 0): [Pole, Pole] {
  const half = poleSeparation(m) / 2;
  const [dx, dy] = [Math.cos(m.angle) * half, Math.sin(m.angle) * half];

  return [
    { x: m.x + dx, y: m.y + dy, q: m.strength, kind: 'N', magnet: index },
    { x: m.x - dx, y: m.y - dy, q: -m.strength, kind: 'S', magnet: index },
  ];
}

export const allPoles = (magnets: readonly Magnet[]): Pole[] =>
  magnets.flatMap((m, i) => poles(m, i));

/** The field of a set of poles at p. */
export function poleField(list: readonly Pole[], p: Vec): Vec {
  let [bx, by] = [0, 0];

  for (const pole of list) {
    const [dx, dy] = [p.x - pole.x, p.y - pole.y];
    const r2 = dx * dx + dy * dy + SOFTENING * SOFTENING;
    const k = pole.q / (r2 * Math.sqrt(r2));
    bx += k * dx;
    by += k * dy;
  }

  return { x: bx, y: by };
}

/** The field of all magnets at p. */
export const fieldAt = (magnets: readonly Magnet[], p: Vec): Vec =>
  poleField(allPoles(magnets), p);

/**
 * The field of a point dipole with the same moment (q times the pole
 * separation) at the magnet's centre: (3 (m . r^) r^ - m) / r^3 in three
 * dimensions, evaluated in the plane of the axis.
 */
export function dipoleField(m: Magnet, p: Vec): Vec {
  const moment = m.strength * poleSeparation(m);
  const [mx, my] = [Math.cos(m.angle) * moment, Math.sin(m.angle) * moment];
  const [dx, dy] = [p.x - m.x, p.y - m.y];
  const r = Math.hypot(dx, dy);
  const [ux, uy] = [dx / r, dy / r];
  const along = mx * ux + my * uy;

  return {
    x: (3 * along * ux - mx) / (r * r * r),
    y: (3 * along * uy - my) / (r * r * r),
  };
}

export const magnitude = (v: Vec) => Math.hypot(v.x, v.y);

/** The direction of the field at p, radians (the way a compass north points). */
export function fieldAngle(magnets: readonly Magnet[], p: Vec): number {
  const b = fieldAt(magnets, p);

  return Math.atan2(b.y, b.x);
}

/** Whether p is inside the bar of the magnet. */
export function inBody(m: Magnet, p: Vec): boolean {
  const [dx, dy] = [p.x - m.x, p.y - m.y];
  const [cos, sin] = [Math.cos(m.angle), Math.sin(m.angle)];
  const [lx, ly] = [dx * cos + dy * sin, -dx * sin + dy * cos];

  return Math.abs(lx) <= m.length / 2 && Math.abs(ly) <= m.width / 2;
}

export interface Bounds {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export type LineEnd = 'south' | 'body' | 'bounds' | 'null' | 'limit';

export interface FieldLine {
  /** The angle around the north pole the line starts at, from the magnet's axis, in [0, 2 pi). */
  seed: number;
  /** Which magnet's north pole it leaves. */
  magnet: number;
  points: Vec[];
  end: LineEnd;
}

export interface LineOptions {
  bounds: Bounds;
  /**
   * Lines per north pole. The angles are spread so that each line carries the
   * same flux (cos of the angle to the axis evenly spaced, as the Stokes stream
   * function of a pole is), which is what keeps the drawing's line density
   * proportional to the field strength. Those starting inside a bar are dropped.
   */
  perPole?: number;
  /** Distance of the starting points from the pole. */
  seedRadius?: number;
  maxSteps?: number;
}

/** Stop a line this close to a south pole. */
const STOP_RADIUS = 0.3;

/**
 * Field lines from every north pole, followed with fourth-order Runge-Kutta
 * along the unit field direction until they reach a south pole or a bar, leave
 * the bounds, meet a point where the field vanishes, or run out of steps. The
 * step length grows with the distance to the nearest pole.
 */
export function fieldLines(
  magnets: readonly Magnet[],
  { bounds, perPole = 28, seedRadius = 0.75, maxSteps = 4000 }: LineOptions,
): FieldLine[] {
  const list = allPoles(magnets);
  const south = list.filter(p => p.q < 0);

  const dir = (p: Vec): Vec | undefined => {
    const b = poleField(list, p);
    const length = magnitude(b);

    return length > 1e-12 ? { x: b.x / length, y: b.y / length } : undefined;
  };

  const stepLength = (p: Vec) => {
    let nearest = Infinity;
    for (const pole of list)
      nearest = Math.min(nearest, Math.hypot(p.x - pole.x, p.y - pole.y));

    return Math.min(0.4, Math.max(0.04, 0.06 * nearest));
  };

  const lines: FieldLine[] = [];

  list.forEach(pole => {
    if (pole.q <= 0) return;

    // Angles of the seeds, measured from the magnet's axis, which at the
    // north pole points away from the magnet.
    const half = Math.max(1, Math.floor(perPole / 2));
    const around = Array.from({ length: half }, (_, k) =>
      Math.acos(1 - (2 * (k + 0.5)) / half),
    ).flatMap(phi => [phi, 2 * Math.PI - phi]);
    const axis = magnets[pole.magnet].angle;

    for (const seed of around) {
      const start: Vec = {
        x: pole.x + seedRadius * Math.cos(axis + seed),
        y: pole.y + seedRadius * Math.sin(axis + seed),
      };
      if (magnets.some(m => inBody(m, start))) continue;

      const points: Vec[] = [start];
      let p = start;
      let end: LineEnd = 'limit';

      for (let i = 0; i < maxSteps; i += 1) {
        const k1 = dir(p);

        if (!k1) {
          end = 'null';
          break;
        }

        const h = stepLength(p);
        const mid = (a: Vec, d: Vec, s: number): Vec => ({
          x: a.x + d.x * s,
          y: a.y + d.y * s,
        });
        const k2 = dir(mid(p, k1, h / 2)) ?? k1;
        const k3 = dir(mid(p, k2, h / 2)) ?? k2;
        const k4 = dir(mid(p, k3, h)) ?? k3;
        p = {
          x: p.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
          y: p.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
        };
        points.push(p);

        if (south.some(s => Math.hypot(p.x - s.x, p.y - s.y) < STOP_RADIUS)) {
          end = 'south';
          break;
        }

        if (magnets.some(m => inBody(m, p))) {
          end = 'body';
          break;
        }

        if (
          p.x < bounds.xmin ||
          p.x > bounds.xmax ||
          p.y < bounds.ymin ||
          p.y > bounds.ymax
        ) {
          end = 'bounds';
          break;
        }
      }

      lines.push({ seed, magnet: pole.magnet, points, end });
    }
  });

  return lines;
}

/**
 * The point half way along a line by length and the direction of travel
 * there, where the view draws an arrowhead.
 */
export function midpoint(
  points: readonly Vec[],
): { at: Vec; angle: number } | undefined {
  if (points.length < 3) return undefined;
  let total = 0;
  for (let i = 1; i < points.length; i += 1)
    total += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );

  let run = 0;

  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const part = Math.hypot(b.x - a.x, b.y - a.y);

    if (run + part >= total / 2) {
      const f = part > 0 ? (total / 2 - run) / part : 0;

      return {
        at: { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y) },
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    }

    run += part;
  }

  return undefined;
}

export type Verdict = 'attract' | 'repel' | 'none';

export interface Interaction {
  /** Force on the second magnet (the force on the first is its negative). */
  force: Vec;
  /** Its component along the line from the first to the second magnet: > 0 pushes them apart. */
  radial: number;
  verdict: Verdict;
  /** The pair of poles, one from each magnet, that are closest. */
  closest: { first: 'N' | 'S'; second: 'N' | 'S'; distance: number };
}

/** Below this the force counts as none. */
const FORCE_EPS = 1e-3;

/**
 * The force between two magnets from their poles: like poles repel, unlike
 * attract, F = q1 q2 d / |d|^3 for each pair.
 */
export function interaction(first: Magnet, second: Magnet): Interaction {
  const [a, b] = [poles(first), poles(second)];
  let [fx, fy] = [0, 0];
  let closest: Interaction['closest'] = {
    first: 'N',
    second: 'N',
    distance: Infinity,
  };

  for (const pa of a)
    for (const pb of b) {
      const [dx, dy] = [pb.x - pa.x, pb.y - pa.y];
      const r2 = dx * dx + dy * dy + SOFTENING * SOFTENING;
      const k = (pa.q * pb.q) / (r2 * Math.sqrt(r2));
      fx += k * dx;
      fy += k * dy;
      const distance = Math.hypot(dx, dy);
      if (distance < closest.distance)
        closest = { first: pa.kind, second: pb.kind, distance };
    }

  const [cx, cy] = [second.x - first.x, second.y - first.y];
  const cl = Math.hypot(cx, cy) || 1;
  const radial = (fx * cx + fy * cy) / cl;

  return {
    force: { x: fx, y: fy },
    radial,
    verdict:
      radial > FORCE_EPS ? 'repel' : radial < -FORCE_EPS ? 'attract' : 'none',
    closest,
  };
}

/** The smallest signed difference to - from, in (-pi, pi]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;

  return d;
}

export interface Needle {
  angle: number;
  omega: number;
}

/**
 * One step of a compass needle that is pulled to the field direction like a
 * damped torsion pendulum: it swings a little and settles. Takes sub steps of
 * at most 1/120 s so a long frame stays stable.
 */
export function stepNeedle(
  needle: Needle,
  target: number,
  dt: number,
  stiffness = 90,
  damping = 9,
): Needle {
  const n = Math.max(1, Math.ceil(dt * 120));
  const h = dt / n;
  let { angle, omega } = needle;

  for (let i = 0; i < n; i += 1) {
    omega += (stiffness * angleDelta(angle, target) - damping * omega) * h;
    angle += omega * h;
  }

  return { angle, omega };
}

/** Whether a needle has come to rest on the target. */
export const needleSettled = (needle: Needle, target: number) =>
  Math.abs(angleDelta(needle.angle, target)) < 0.002 &&
  Math.abs(needle.omega) < 0.01;

/**
 * Maps a field strength to one of `levels` steps on a logarithmic scale
 * between `low` and `high`, for the strength view. Level 0 is "almost no
 * field".
 */
export function strengthLevel(
  b: number,
  levels: number,
  low = 0.004,
  high = 3,
): number {
  if (!(b > 0)) return 0;
  const t = (Math.log(b) - Math.log(low)) / (Math.log(high) - Math.log(low));

  return Math.max(0, Math.min(levels - 1, Math.floor(t * levels)));
}
