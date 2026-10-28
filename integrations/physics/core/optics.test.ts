// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  imageDistance,
  principalRays,
  signedFocal,
  thinLens,
  type Lens,
  type Pt,
} from './optics.js';

const close = (a: number, b: number, digits = 9) =>
  expect(a).toBeCloseTo(b, digits);

/** Distance of point p from the infinite line through a and b. */
const offLine = (p: Pt, a: Pt, b: Pt) => {
  const [dx, dy] = [b.x - a.x, b.y - a.y];

  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / Math.hypot(dx, dy);
};

describe('thinLens', () => {
  it('obeys 1/f = 1/v + 1/b for real and virtual images', () => {
    for (const f of [-8, -3, 2, 5, 10])
      for (const v of [0.7, 1.5, 4, 5, 9.3, 20]) {
        const { b } = thinLens({ f, v, h: 2 });
        if (!Number.isFinite(b)) continue;
        close(1 / v + 1 / b, 1 / f);
      }
  });

  it('gives a real, inverted, equal-sized image at v = 2f', () => {
    const image = thinLens({ f: 5, v: 10, h: 2 });
    close(image.b, 10);
    close(image.n, 1);
    close(image.m, -1);
    close(image.height, -2);
    expect(image).toMatchObject({
      real: true,
      upright: false,
      size: 'same',
      atInfinity: false,
    });
  });

  it('gives an enlarged real image between f and 2f, a reduced one beyond 2f', () => {
    const near = thinLens({ f: 5, v: 7.5, h: 1 });
    close(near.b, 15);
    close(near.n, 2);
    expect(near.size).toBe('enlarged');
    expect(near.real).toBe(true);

    const far = thinLens({ f: 5, v: 20, h: 1 });
    close(far.b, 20 / 3);
    close(far.n, 1 / 3);
    expect(far.size).toBe('reduced');
  });

  it('gives a virtual, upright, enlarged image when a convex lens is used as a magnifier (v < f)', () => {
    const image = thinLens({ f: 5, v: 2, h: 1 });
    close(image.b, -10 / 3);
    close(image.n, 5 / 3);
    expect(image).toMatchObject({
      real: false,
      upright: true,
      size: 'enlarged',
    });
    expect(image.tip!.x).toBeLessThan(0);
    expect(image.tip!.y).toBeGreaterThan(0);
  });

  it('always gives a virtual, upright, reduced image for a concave lens', () => {
    for (const v of [0.5, 3, 10, 40]) {
      const image = thinLens({ f: -6, v, h: 1 });
      expect(image.real).toBe(false);
      expect(image.upright).toBe(true);
      expect(image.n).toBeLessThan(1);
      expect(image.b).toBeLessThan(0);
      expect(Math.abs(image.b)).toBeLessThan(6);
    }
  });

  it('puts the image at infinity when the object stands in the focal point', () => {
    const image = thinLens({ f: 5, v: 5, h: 1 });
    expect(image.atInfinity).toBe(true);
    expect(image.b).toBe(Infinity);
    expect(image.tip).toBeUndefined();
    expect(imageDistance(5, 5)).toBe(Infinity);
  });

  it('keeps N = b/v and m = -b/v consistent in sign and size', () => {
    const image = thinLens({ f: 4, v: 6, h: 1.5 });
    close(image.n, Math.abs(image.b) / 6);
    close(image.m, -image.b / 6);
    close(image.height, image.m * 1.5);
  });
});

describe('signedFocal', () => {
  it('is positive for convex and negative for concave', () => {
    expect(signedFocal('convex', 6)).toBe(6);
    expect(signedFocal('concave', 6)).toBe(-6);
    expect(signedFocal('concave', -6)).toBe(-6);
  });
});

describe('principalRays', () => {
  const cases: Lens[] = [
    { f: 5, v: 12, h: 2 },
    { f: 5, v: 7, h: 1.5 },
    { f: 5, v: 2, h: 1 },
    { f: -6, v: 9, h: 2.5 },
    { f: -3, v: 1.5, h: 1 },
  ];

  it('returns the three rays, in the documented order', () => {
    expect(principalRays(cases[0], 20).map(r => r.id)).toEqual([
      'parallel',
      'center',
      'focal',
    ]);
  });

  it('starts each ray at the object tip and has it meet the lens plane', () => {
    for (const lens of cases)
      for (const ray of principalRays(lens, 20)) {
        expect(ray.incoming[0]).toEqual({ x: -lens.v, y: lens.h });
        expect(ray.incoming[1].x).toBe(0);
        expect(ray.outgoing[0]).toEqual(ray.hit);
        expect(ray.outgoing[1].x).toBe(20);
      }
  });

  it('bends the parallel ray through the far focal point of a convex lens', () => {
    const ray = principalRays({ f: 5, v: 12, h: 2 }, 20)[0];
    expect(ray.hit.y).toBe(2);
    close(offLine({ x: 5, y: 0 }, ray.outgoing[0], ray.outgoing[1]), 0);
  });

  it('makes the parallel ray of a concave lens seem to come from the focal point on the object side', () => {
    const ray = principalRays({ f: -6, v: 9, h: 2.5 }, 20)[0];
    // Diverges: gets further from the axis, and its extension backwards hits (f, 0) = (-6, 0).
    expect(ray.outgoing[1].y).toBeGreaterThan(ray.hit.y);
    close(offLine({ x: -6, y: 0 }, ray.outgoing[0], ray.outgoing[1]), 0);
  });

  it('leaves the central ray undeviated', () => {
    for (const lens of cases) {
      const ray = principalRays(lens, 20)[1];
      const tip = ray.incoming[0];
      close(offLine(ray.outgoing[1], tip, { x: 0, y: 0 }), 0);
    }
  });

  it('aims the focal ray at the focal point on the object side and sends it out parallel', () => {
    for (const lens of cases) {
      const ray = principalRays(lens, 20)[2];
      close(offLine({ x: -lens.f, y: 0 }, ray.incoming[0], ray.incoming[1]), 0);
      expect(ray.outgoing[1].y).toBeCloseTo(ray.outgoing[0].y, 9);
    }
  });

  it('makes all outgoing rays of a real image meet at the image tip', () => {
    for (const lens of cases) {
      const image = thinLens(lens);
      if (!image.real) continue;
      for (const ray of principalRays(lens, 40))
        close(offLine(image.tip!, ray.outgoing[0], ray.outgoing[1]), 0, 7);
    }
  });

  it('draws the back extensions of a virtual image to the image tip, and lets the outgoing rays seem to come from it', () => {
    for (const lens of cases) {
      const image = thinLens(lens);
      if (image.real) continue;

      for (const ray of principalRays(lens, 40)) {
        expect(ray.back).toBeDefined();
        expect(ray.back![1]).toEqual(image.tip);
        close(offLine(image.tip!, ray.outgoing[0], ray.outgoing[1]), 0, 7);
      }
    }
  });

  it('has no back extensions for a real image', () => {
    for (const ray of principalRays(cases[0], 20))
      expect(ray.back).toBeUndefined();
  });

  it('leaves out the focal ray, and sends the others out parallel, when the object stands in the focal point', () => {
    const rays = principalRays({ f: 5, v: 5, h: 2 }, 20);
    expect(rays.map(r => r.id)).toEqual(['parallel', 'center']);
    expect(rays.every(r => r.back === undefined)).toBe(true);
    const [a, b] = rays.map(r => {
      const [p, q] = r.outgoing;

      return (q.y - p.y) / (q.x - p.x);
    });
    close(a, b);
  });
});
