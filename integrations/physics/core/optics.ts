// @wc-ignore-file
/**
 * Thin-lens optics, pure functions with no DOM.
 *
 * Geometry: the lens is the line x = 0, the optical axis is y = 0, light
 * travels from left to right. The object stands at x = -v with its tip at
 * height h. Lengths are in any one unit (the app uses centimetres).
 *
 * Sign convention (Dutch school books): v > 0 is the object distance, b > 0 a
 * real image behind the lens, b < 0 a virtual image on the object side. The
 * focal length f is positive for a converging (convex) lens and negative for a
 * diverging (concave) one, so that 1/f = 1/v + 1/b holds for both.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Lens {
  /** Focal length, signed: > 0 convex (converging), < 0 concave (diverging). */
  f: number;
  /** Object distance, > 0. */
  v: number;
  /** Object height, > 0 (the arrow stands above the axis). */
  h: number;
}

export interface Image {
  /** Image distance: > 0 real, < 0 virtual, Infinity when the object stands in the focal point. */
  b: number;
  /** Signed lateral magnification: negative means inverted. */
  m: number;
  /** N = |b| / v, the magnification as school books give it. */
  n: number;
  /** Signed image height (negative below the axis). */
  height: number;
  real: boolean;
  upright: boolean;
  atInfinity: boolean;
  size: 'enlarged' | 'reduced' | 'same';
  /** The image tip, undefined when the image is at infinity. */
  tip?: Pt;
}

/** Below this |v - f| the object counts as standing in the focal point. */
const FOCUS_EPS = 1e-9;

/** Image distance from 1/f = 1/v + 1/b. Infinity when v = f. */
export function imageDistance(f: number, v: number): number {
  if (Math.abs(v - f) < FOCUS_EPS) return Infinity;

  return (f * v) / (v - f);
}

/** The image of the object: where, how large, real or virtual, upright or inverted. */
export function thinLens({ f, v, h }: Lens): Image {
  const b = imageDistance(f, v);

  if (!Number.isFinite(b))
    return {
      b,
      m: Infinity,
      n: Infinity,
      height: Infinity,
      real: false,
      upright: false,
      atInfinity: true,
      size: 'enlarged',
    };

  const m = -b / v;
  const n = Math.abs(b) / v;

  return {
    b,
    m,
    n,
    height: m * h,
    real: b > 0,
    upright: m > 0,
    atInfinity: false,
    size: Math.abs(n - 1) < 1e-6 ? 'same' : n > 1 ? 'enlarged' : 'reduced',
    tip: { x: b, y: m * h },
  };
}

export type RayId = 'parallel' | 'center' | 'focal';

export interface Ray {
  id: RayId;
  /** Where the ray meets the lens plane. */
  hit: Pt;
  /** Object tip to the lens. */
  incoming: [Pt, Pt];
  /** The lens to x = xEnd, in the direction the light goes. */
  outgoing: [Pt, Pt];
  /**
   * For a virtual image: the lens back to the image tip, the line the
   * outgoing ray seems to come from. Drawn dashed.
   */
  back?: [Pt, Pt];
}

/**
 * The three principal rays from the object tip.
 *
 * 1. parallel to the axis, then through (convex) or seemingly from (concave)
 *    the focal point on the far side, at x = f;
 * 2. through the optical centre, undeviated;
 * 3. aimed at the focal point on the object side, x = -f, then parallel to the
 *    axis. Left out when the object stands in that focal point: the ray would
 *    run along the lens plane.
 *
 * `xEnd` is how far to the right the outgoing rays are drawn.
 */
export function principalRays(lens: Lens, xEnd: number): Ray[] {
  const { f, v, h } = lens;
  const tip: Pt = { x: -v, y: h };
  const image = thinLens(lens);
  const rays: Ray[] = [];
  const back = (hit: Pt): [Pt, Pt] | undefined =>
    !image.real && image.tip ? [hit, image.tip] : undefined;
  const along = (from: Pt, dx: number, dy: number): Pt => ({
    x: xEnd,
    y: from.y + (dy / dx) * (xEnd - from.x),
  });

  // 1. Parallel ray. Direction after the lens: towards (f, 0) for a convex
  // lens, away from it for a concave one, which is sign(f) * (f, -h).
  const hit1: Pt = { x: 0, y: h };
  const s = Math.sign(f) || 1;
  rays.push({
    id: 'parallel',
    hit: hit1,
    incoming: [tip, hit1],
    outgoing: [hit1, along(hit1, s * f, -s * h)],
    back: back(hit1),
  });

  // 2. Central ray.
  const hit2: Pt = { x: 0, y: 0 };
  rays.push({
    id: 'center',
    hit: hit2,
    incoming: [tip, hit2],
    outgoing: [hit2, { x: xEnd, y: (-h / v) * xEnd }],
    back: back(hit2),
  });

  // 3. Focal ray.
  if (Math.abs(v - f) > 1e-6) {
    const hit3: Pt = { x: 0, y: (-h * f) / (v - f) };
    rays.push({
      id: 'focal',
      hit: hit3,
      incoming: [tip, hit3],
      outgoing: [hit3, { x: xEnd, y: hit3.y }],
      back: back(hit3),
    });
  }

  return rays;
}

/** The signed focal length for a lens kind and a focal distance. */
export const signedFocal = (kind: 'convex' | 'concave', distance: number) =>
  kind === 'convex' ? Math.abs(distance) : -Math.abs(distance);
