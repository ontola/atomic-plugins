// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  allPoles,
  angleDelta,
  dipoleField,
  fieldAngle,
  fieldAt,
  fieldLines,
  inBody,
  interaction,
  magnitude,
  makeMagnet,
  midpoint,
  needleSettled,
  poleSeparation,
  poles,
  stepNeedle,
  strengthLevel,
  type Bounds,
  type Needle,
} from './magnet.js';

const bounds: Bounds = { xmin: -30, xmax: 30, ymin: -20, ymax: 20 };

describe('poles', () => {
  it('puts the north pole in the direction of the angle and the south pole opposite', () => {
    const m = makeMagnet(2, 1, Math.PI / 2);
    const [n, s] = poles(m);
    expect(n.kind).toBe('N');
    expect(n.q).toBe(1);
    expect(n.x).toBeCloseTo(2, 12);
    expect(n.y).toBeCloseTo(1 + poleSeparation(m) / 2, 12);
    expect(s.q).toBe(-1);
    expect(s.y).toBeCloseTo(1 - poleSeparation(m) / 2, 12);
  });

  it('inside the end faces, so lines can start beside the bar', () => {
    const m = makeMagnet(0, 0);
    expect(poleSeparation(m)).toBeLessThan(m.length);
    expect(inBody(m, { x: 0, y: 0 })).toBe(true);
    expect(inBody(m, { x: 3.1, y: 0 })).toBe(false);
    expect(inBody(m, { x: 0, y: 0.8 })).toBe(false);
  });

  it('rotates the body with the angle', () => {
    const m = makeMagnet(0, 0, Math.PI / 2);
    expect(inBody(m, { x: 0, y: 2.9 })).toBe(true);
    expect(inBody(m, { x: 2.9, y: 0 })).toBe(false);
  });
});

describe('field', () => {
  const m = makeMagnet(0, 0);

  it('points along the axis away from north and towards south outside the bar', () => {
    expect(fieldAt([m], { x: 6, y: 0 }).x).toBeGreaterThan(0);
    expect(fieldAt([m], { x: -6, y: 0 }).x).toBeGreaterThan(0);
  });

  it('points from north to south between the poles (the pole model gives H, which does so inside the bar)', () => {
    expect(fieldAt([m], { x: 0, y: 0 }).x).toBeLessThan(0);
  });

  it('falls off as 1/r^2 near an isolated pole', () => {
    const one = fieldAt([m], { x: 3 + 1, y: 0 });
    const two = fieldAt([m], { x: 3 + 2, y: 0 });
    // Not exactly 4 (the other pole and the softening), but close at short range.
    expect(magnitude(one) / magnitude(two)).toBeGreaterThan(3);
    expect(magnitude(one) / magnitude(two)).toBeLessThan(5);
  });

  it('turns into the dipole field far away', () => {
    for (const angle of [0, 0.7, 2.1]) {
      const magnet = makeMagnet(1, -2, angle);

      for (const phi of [0.2, 1.1, 2.5, 4]) {
        const p = {
          x: 1 + 400 * Math.cos(phi),
          y: -2 + 400 * Math.sin(phi),
        };
        const [exact, dipole] = [fieldAt([magnet], p), dipoleField(magnet, p)];
        expect(exact.x / dipole.x).toBeCloseTo(1, 2);
        expect(exact.y / dipole.y).toBeCloseTo(1, 2);
      }
    }
  });

  it('is the sum of the magnets and has no field far from nothing', () => {
    const [a, b] = [makeMagnet(-4, 0), makeMagnet(4, 0, Math.PI)];
    const p = { x: 0, y: 3 };
    const sum = fieldAt([a], p);
    const other = fieldAt([b], p);
    const both = fieldAt([a, b], p);
    expect(both.x).toBeCloseTo(sum.x + other.x, 12);
    expect(both.y).toBeCloseTo(sum.y + other.y, 12);
  });

  it('flips sign when the magnet is turned half a circle', () => {
    const p = { x: 3, y: 4 };
    const [a, b] = [
      fieldAt([makeMagnet(0, 0, 0)], p),
      fieldAt([makeMagnet(0, 0, Math.PI)], p),
    ];
    // Turning by 180 degrees about the centre is a point reflection of the field.
    const mirrored = fieldAt([makeMagnet(0, 0, Math.PI)], { x: -3, y: -4 });
    expect(mirrored.x).toBeCloseTo(-a.x, 12);
    expect(mirrored.y).toBeCloseTo(-a.y, 12);
    expect(b).not.toEqual(a);
  });
});

describe('fieldLines', () => {
  const m = makeMagnet(0, 0);

  it('leaves only from north poles and drops seeds that start inside the bar', () => {
    const lines = fieldLines([m], { bounds });
    expect(lines.length).toBeGreaterThan(12);
    expect(lines.length).toBeLessThan(28);

    for (const line of lines) {
      expect(line.magnet).toBe(0);
      expect(inBody(m, line.points[0])).toBe(false);
    }
  });

  it('has most lines come back to the magnet, the rest leave the bounds', () => {
    const lines = fieldLines([m], { bounds });
    const home = lines.filter(l => l.end === 'south' || l.end === 'body');
    expect(home.length / lines.length).toBeGreaterThan(0.6);
    expect(lines.every(l => l.end !== 'limit' && l.end !== 'null')).toBe(true);
  });

  it('spreads the seeds by equal flux: fewer near the axis than around the sides', () => {
    const lines = fieldLines([m], { bounds, perPole: 40 });
    const near = lines.filter(l => Math.cos(l.seed) > 0.8).length;
    const side = lines.filter(l => Math.abs(Math.cos(l.seed)) < 0.2).length;
    expect(side).toBeGreaterThan(near);
  });

  it('is symmetric about the axis of the magnet', () => {
    const lines = fieldLines([m], { bounds });
    let pairs = 0;

    for (const line of lines) {
      if (line.seed > Math.PI) continue;
      const mirror = lines.find(
        l => Math.abs(l.seed - (2 * Math.PI - line.seed)) < 1e-9,
      );
      if (!mirror) continue;
      pairs += 1;
      expect(mirror.points.length).toBe(line.points.length);
      line.points.forEach((p, i) => {
        expect(mirror.points[i].x).toBeCloseTo(p.x, 6);
        expect(mirror.points[i].y).toBeCloseTo(-p.y, 6);
      });
    }

    expect(pairs).toBeGreaterThan(4);
  });

  it('turns with the magnet', () => {
    const turned = makeMagnet(0, 0, Math.PI / 2);
    const [flat, up] = [
      fieldLines([m], { bounds }),
      fieldLines([turned], { bounds }),
    ];
    expect(up.length).toBe(flat.length);
    flat[3].points.forEach((p, i) => {
      // A quarter turn counterclockwise sends (x, y) to (-y, x).
      expect(up[3].points[i].x).toBeCloseTo(-p.y, 6);
      expect(up[3].points[i].y).toBeCloseTo(p.x, 6);
    });
  });

  it('follows the field: each segment is tangent to B at its middle', () => {
    for (const line of fieldLines([m], { bounds }))
      for (let i = 1; i < line.points.length; i += 7) {
        const [a, b] = [line.points[i - 1], line.points[i]];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const err = Math.abs(
          angleDelta(Math.atan2(b.y - a.y, b.x - a.x), fieldAngle([m], mid)),
        );
        expect(err).toBeLessThan(0.05);
      }
  });

  it('runs lines from the first magnet into the second when they attract', () => {
    const [a, b] = [makeMagnet(-4, 0), makeMagnet(4, 0)];
    const lines = fieldLines([a, b], { bounds });
    const across = lines.filter(
      l => l.magnet === 0 && l.end === 'body' && l.points.at(-1)!.x > 0.5,
    );
    expect(across.length).toBeGreaterThan(3);
    // Magnet 2's south pole is at its left end, x = 4 - 2.7 = 1.3.
    for (const line of across) expect(line.points.at(-1)!.x).toBeLessThan(1.8);
  });

  it('keeps lines from the first magnet out of the second when they repel', () => {
    const [a, b] = [makeMagnet(-4, 0), makeMagnet(4, 0, Math.PI)];
    const lines = fieldLines([a, b], { bounds });

    // A neutral point sits half way, so no line from one north pole crosses the middle plane.
    for (const line of lines) {
      const xs = line.points.slice(0, 40).map(p => p.x);
      if (line.magnet === 0) expect(Math.max(...xs)).toBeLessThan(0.1);
      else expect(Math.min(...xs)).toBeGreaterThan(-0.1);
    }
  });
});

describe('midpoint', () => {
  it('finds the middle by length and the direction there', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ];
    const mid = midpoint(points)!;
    expect(mid.at.x).toBeCloseTo(2, 12);
    expect(mid.at.y).toBeCloseTo(0, 12);
    expect(midpoint(points.slice(0, 2))).toBeUndefined();
  });
});

describe('interaction', () => {
  it('attracts when north faces south', () => {
    const r = interaction(makeMagnet(-4, 0), makeMagnet(4, 0));
    expect(r.verdict).toBe('attract');
    expect(r.radial).toBeLessThan(0);
    expect(r.closest).toMatchObject({ first: 'N', second: 'S' });
  });

  it('repels when north faces north, and when south faces south', () => {
    const nn = interaction(makeMagnet(-4, 0), makeMagnet(4, 0, Math.PI));
    expect(nn.verdict).toBe('repel');
    expect(nn.closest).toMatchObject({ first: 'N', second: 'N' });
    const ss = interaction(makeMagnet(-4, 0, Math.PI), makeMagnet(4, 0));
    expect(ss.verdict).toBe('repel');
    expect(ss.closest).toMatchObject({ first: 'S', second: 'S' });
  });

  it('pushes the second magnet away along the axis when repelling, towards the first when attracting', () => {
    expect(
      interaction(makeMagnet(-4, 0), makeMagnet(4, 0, Math.PI)).force.x,
    ).toBeGreaterThan(0);
    expect(
      interaction(makeMagnet(-4, 0), makeMagnet(4, 0)).force.x,
    ).toBeLessThan(0);
  });

  it('obeys the third law: swapping the magnets reverses the force', () => {
    const [a, b] = [makeMagnet(-3, 1, 0.4), makeMagnet(3.5, -0.5, 2)];
    const [ab, ba] = [interaction(a, b), interaction(b, a)];
    expect(ab.force.x).toBeCloseTo(-ba.force.x, 12);
    expect(ab.force.y).toBeCloseTo(-ba.force.y, 12);
  });

  it('weakens with distance', () => {
    const near = interaction(makeMagnet(-4, 0), makeMagnet(4, 0));
    const far = interaction(makeMagnet(-8, 0), makeMagnet(8, 0));
    expect(Math.abs(far.radial)).toBeLessThan(Math.abs(near.radial) / 3);
  });

  it('repels two parallel bars side by side, as the poles beside each other are alike', () => {
    expect(interaction(makeMagnet(0, 0), makeMagnet(0, 2)).verdict).toBe(
      'repel',
    );
    expect(
      interaction(makeMagnet(0, 0), makeMagnet(0, 2, Math.PI)).verdict,
    ).toBe('attract');
  });
});

describe('compass needle', () => {
  it('takes the short way round', () => {
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 12);
    expect(angleDelta(3, -3)).toBeCloseTo(2 * Math.PI - 6, 12);
    expect(angleDelta(0, 2 * Math.PI)).toBeCloseTo(0, 12);
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI, 12);
  });

  it('settles on the field direction and stays there', () => {
    let needle: Needle = { angle: 0, omega: 0 };
    const target = 2.2;
    for (let i = 0; i < 180; i += 1)
      needle = stepNeedle(needle, target, 1 / 60);
    expect(needleSettled(needle, target)).toBe(true);
    expect(angleDelta(needle.angle, target)).toBeCloseTo(0, 2);
  });

  it('is stable over a long frame and over the wrap at pi', () => {
    let needle: Needle = { angle: 3, omega: 0 };
    needle = stepNeedle(needle, -3, 0.5);
    expect(Number.isFinite(needle.angle)).toBe(true);
    for (let i = 0; i < 200; i += 1) needle = stepNeedle(needle, -3, 1 / 60);
    expect(Math.abs(angleDelta(needle.angle, -3))).toBeLessThan(0.01);
  });

  it('lines up with a field line when dropped on it', () => {
    const m = makeMagnet(0, 0);
    const p = { x: 0, y: 3 };
    const target = fieldAngle([m], p);
    // Beside the middle of the bar the field outside runs from north (right) to south (left): towards -x.
    expect(Math.cos(target)).toBeLessThan(-0.9);
    let needle: Needle = { angle: -2, omega: 0 };
    for (let i = 0; i < 240; i += 1)
      needle = stepNeedle(needle, target, 1 / 60);
    expect(Math.abs(angleDelta(needle.angle, target))).toBeLessThan(0.01);
  });
});

describe('strengthLevel', () => {
  it('is monotonic, clamped to the number of levels', () => {
    let prev = -1;

    for (const b of [0, 0.001, 0.01, 0.05, 0.2, 1, 5, 100]) {
      const level = strengthLevel(b, 8);
      expect(level).toBeGreaterThanOrEqual(prev);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(7);
      prev = level;
    }

    expect(strengthLevel(0, 8)).toBe(0);
    expect(strengthLevel(100, 8)).toBe(7);
    expect(strengthLevel(NaN, 8)).toBe(0);
  });
});

describe('allPoles', () => {
  it('lists north then south of each magnet with the magnet index', () => {
    const list = allPoles([makeMagnet(0, 0), makeMagnet(5, 0)]);
    expect(list.map(p => `${p.magnet}${p.kind}`)).toEqual([
      '0N',
      '0S',
      '1N',
      '1S',
    ]);
  });
});
