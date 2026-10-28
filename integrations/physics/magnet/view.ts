// @wc-ignore-file
/**
 * The magnet scene: plain DOM and SVG. Cheap parts (positions, readout) are
 * updated at once; the field layers (lines, filings, strength) and the
 * compass needle are redone in animation frames, so a drag costs at most one
 * field computation per frame and nothing while the app is hidden.
 */
import {
  fieldAt,
  fieldAngle,
  fieldLines,
  inBody,
  interaction,
  magnitude,
  makeMagnet,
  midpoint,
  needleSettled,
  stepNeedle,
  strengthLevel,
  type Bounds,
  type Magnet,
  type Needle,
} from '../core/magnet.js';
import { arrowKeys, clamp, draggable } from '../shared/drag.js';
import {
  button,
  checkbox,
  node,
  r1,
  segmented,
  setAttrs,
  slider,
  snode,
  uid,
} from '../shared/dom.js';
import { fmt, type Lang } from '../shared/lang.js';
import { createLoop } from '../shared/loop.js';
import type { Strings } from './strings.js';

export type Background = 'none' | 'filings' | 'strength';

export interface MagnetState {
  count: 1 | 2;
  magnets: [Magnet, Magnet];
  compass: { x: number; y: number };
  background: Background;
  lines: boolean;
}

/** Half the drawn width and height, in cm. */
const HALF_X = 12;
const HALF_Y = 7.5;
/** Field lines are followed well beyond the picture so that large loops close. */
const TRACE: Bounds = { xmin: -36, xmax: 36, ymin: -24, ymax: 24 };
const CELL = 0.5;
const LEVELS = 8;
const HEAT_OPACITY = [0, 0.07, 0.15, 0.25, 0.37, 0.5, 0.65, 0.82];
const FILING_OPACITY = [0, 0.3, 0.5, 0.72, 0.95];

export const initialState = (): MagnetState => ({
  count: 1,
  magnets: [makeMagnet(0, 0, 0), makeMagnet(4, 0, 0)],
  compass: { x: 4.5, y: 3.5 },
  background: 'none',
  lines: true,
});

export interface MagnetApp {
  el: HTMLElement;
  state: MagnetState;
  resize(width: number): void;
}

/** A deterministic pseudo-random number in [0, 1) for a grid cell, so the filings do not shimmer. */
const hash = (i: number, j: number, k: number) => {
  const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;

  return s - Math.floor(s);
};

const deg = (rad: number) => ((((rad * 180) / Math.PI) % 360) + 360) % 360;

export function createMagnetApp(
  doc: Document,
  ui: Strings,
  lang: Lang,
  reducedMotion = false,
  initial: MagnetState = initialState(),
): MagnetApp {
  const state = initial;
  const n = (x: number, d = 1) => fmt(x, d, lang);
  let width = 720;
  let scale = 24;
  let halfX = HALF_X;
  let [ox, oy] = [0, 0];
  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy - y * scale;
  const active = () => state.magnets.slice(0, state.count);

  const svg = snode(doc, 'svg', {
    role: 'group',
    'aria-label': ui.scene,
    preserveAspectRatio: 'xMidYMid meet',
  });
  const heat = Array.from({ length: LEVELS }, (_, level) =>
    snode(doc, 'path', {
      fill: 'var(--ph-heat)',
      'fill-opacity': HEAT_OPACITY[level],
      'shape-rendering': 'crispEdges',
      'data-level': level,
    }),
  );
  const heatGroup = snode(doc, 'g', { 'data-layer': 'strength' }, ...heat);
  const filings = Array.from({ length: FILING_OPACITY.length }, (_, level) =>
    snode(doc, 'path', {
      fill: 'none',
      stroke: 'var(--ph-text)',
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
      'stroke-opacity': FILING_OPACITY[level],
    }),
  );
  const filingsGroup = snode(doc, 'g', { 'data-layer': 'filings' }, ...filings);
  const linesPath = snode(doc, 'path', {
    fill: 'none',
    stroke: 'var(--ph-text)',
    'stroke-width': 1.5,
    'stroke-opacity': 0.8,
    'stroke-linejoin': 'round',
    'data-layer': 'lines',
  });
  const arrowsPath = snode(doc, 'path', {
    fill: 'var(--ph-text)',
    'fill-opacity': 0.85,
    'data-layer': 'arrows',
  });

  const hintId = uid('ph-magnet-hint');

  // Magnets.
  const bodies = [0, 1].map(i => {
    const southHalf = snode(doc, 'rect', { fill: 'var(--ph-south)' });
    const northHalf = snode(doc, 'rect', { fill: 'var(--ph-north)' });
    const outline = snode(doc, 'rect', {
      fill: 'none',
      stroke: 'var(--ph-text)',
      'stroke-width': 2,
    });
    const ring = snode(doc, 'rect', { class: 'ph-ring', fill: 'none' });
    const body = snode(doc, 'g', {}, southHalf, northHalf, outline);
    const letterN = snode(doc, 'text', {
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: 'var(--ph-pole-ink)',
      'font-weight': 700,
      'font-size': 15,
      'pointer-events': 'none',
    });
    const letterS = snode(doc, 'text', {
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      fill: 'var(--ph-pole-ink)',
      'font-weight': 700,
      'font-size': 15,
      'pointer-events': 'none',
    });
    letterN.textContent = ui.north;
    letterS.textContent = ui.south;
    const tag = snode(doc, 'text', {
      class: 'ph-label',
      'text-anchor': 'middle',
      'pointer-events': 'none',
    });
    tag.textContent = String(i + 1);
    const handle = snode(doc, 'g', {
      class: 'ph-handle',
      tabindex: 0,
      role: 'button',
      'data-handle': `magnet-${i + 1}`,
      'aria-describedby': hintId,
    });
    handle.append(ring, body, letterN, letterS, tag);

    // Rotation handle beyond the north end.
    const rRing = snode(doc, 'circle', { class: 'ph-ring', r: 17 });
    const rHit = snode(doc, 'circle', { r: 17, fill: 'transparent' });
    const rDot = snode(doc, 'circle', {
      r: 11,
      fill: 'var(--ph-bg)',
      stroke: 'var(--ph-text)',
      'stroke-width': 2.5,
    });
    const rArc = snode(doc, 'path', {
      fill: 'none',
      stroke: 'var(--ph-text)',
      'stroke-width': 2,
      'stroke-linecap': 'round',
    });
    const rotate = snode(doc, 'g', {
      class: 'ph-handle',
      tabindex: 0,
      role: 'slider',
      'data-handle': `rotate-${i + 1}`,
      'aria-valuemin': 0,
      'aria-valuemax': 360,
      'aria-describedby': hintId,
    });
    rotate.append(rRing, rHit, rDot, rArc);

    const forceArrow = snode(doc, 'g', {
      'data-force': i + 1,
      'pointer-events': 'none',
    });
    const forceLine = snode(doc, 'line', {
      stroke: 'var(--ph-text)',
      'stroke-width': 3.5,
      'stroke-linecap': 'round',
    });
    const forceHead = snode(doc, 'path', { fill: 'var(--ph-text)' });
    forceArrow.append(forceLine, forceHead);

    return {
      southHalf,
      northHalf,
      outline,
      ring,
      body,
      letterN,
      letterS,
      tag,
      handle,
      rRing,
      rHit,
      rDot,
      rArc,
      rotate,
      forceArrow,
      forceLine,
      forceHead,
    };
  });

  // Compass.
  const cRing = snode(doc, 'circle', { class: 'ph-ring', r: 31 });
  const cFace = snode(doc, 'circle', {
    r: 26,
    fill: 'var(--ph-bg)',
    stroke: 'var(--ph-text)',
    'stroke-width': 2.5,
  });
  const needleN = snode(doc, 'path', {
    d: 'M23 0L-3 -8L-3 8Z',
    fill: 'var(--ph-north)',
    stroke: 'var(--ph-text)',
    'stroke-width': 1,
  });
  const needleS = snode(doc, 'path', {
    d: 'M-23 0L3 -8L3 8Z',
    fill: 'var(--ph-bg)',
    stroke: 'var(--ph-text)',
    'stroke-width': 1.5,
  });
  const needle = snode(doc, 'g', { 'data-needle': '' }, needleS, needleN);
  const pivot = snode(doc, 'circle', { r: 2, fill: 'var(--ph-text)' });
  const compass = snode(doc, 'g', {
    class: 'ph-handle',
    tabindex: 0,
    role: 'button',
    'data-handle': 'compass',
    'aria-describedby': hintId,
  });
  const compassPos = snode(doc, 'g', {}, cRing, cFace, needle, pivot);
  compass.append(compassPos);

  svg.append(heatGroup, filingsGroup, linesPath, arrowsPath);
  for (const b of bodies) svg.append(b.handle, b.rotate);
  for (const b of bodies) svg.append(b.forceArrow);
  svg.append(compass);

  // ---- readout and controls ----
  const verdict = node(doc, 'p', {
    class: 'ph-verdict',
    role: 'status',
    'data-verdict': '',
  });
  const why = node(doc, 'p', { class: 'ph-hint', 'data-why': '' });
  const facing = node(doc, 'p', { class: 'ph-note', 'data-facing': '' });
  const fieldValue = node(doc, 'dd', { 'data-field': '' });
  const directionValue = node(doc, 'dd', { 'data-direction': '' });
  const forceValue = node(doc, 'dd', { 'data-force-value': '' });
  const forceRow = node(
    doc,
    'div',
    {},
    node(doc, 'dt', {}, ui.force),
    forceValue,
  );
  const readout = node(
    doc,
    'section',
    { class: 'ph-panel', 'aria-label': ui.fieldAtCompass },
    node(
      doc,
      'dl',
      { class: 'ph-values' },
      node(doc, 'div', {}, node(doc, 'dt', {}, ui.fieldAtCompass), fieldValue),
      node(doc, 'div', {}, node(doc, 'dt', {}, ui.direction), directionValue),
      forceRow,
    ),
    verdict,
    why,
    facing,
  );

  const countControl = segmented(doc, {
    label: ui.count,
    options: [
      { value: '1', label: ui.one },
      { value: '2', label: ui.two },
    ],
    value: String(state.count),
    onChange: value => {
      state.count = value === '2' ? 2 : 1;
      if (
        state.count === 2 &&
        state.magnets[0].x === 0 &&
        state.magnets[0].y === 0
      )
        state.magnets[0].x = -4;
      render();
    },
  });
  const backgroundControl = segmented<Background>(doc, {
    label: ui.background,
    options: [
      { value: 'none', label: ui.none },
      { value: 'filings', label: ui.filings },
      { value: 'strength', label: ui.strength },
    ],
    value: state.background,
    onChange: value => {
      state.background = value;
      render();
    },
  });
  const linesControl = checkbox(doc, {
    label: ui.lines,
    checked: state.lines,
    onChange: value => {
      state.lines = value;
      render();
    },
  });
  const angleSliders = [0, 1].map(i =>
    slider(doc, {
      label: i === 0 ? ui.angle1 : ui.angle2,
      min: 0,
      max: 355,
      step: 5,
      value: Math.round(deg(state.magnets[i].angle) / 5) * 5,
      format: v => `${n(v, 0)}°`,
      onInput: v => {
        state.magnets[i].angle = (v * Math.PI) / 180;
        render();
      },
    }),
  );
  const flip = button(doc, ui.flip, () => {
    state.magnets[1].angle += Math.PI;
    render();
  });
  const reset = button(doc, ui.reset, () => {
    const fresh = initialState();
    state.count = 1;
    state.magnets = fresh.magnets;
    state.compass = fresh.compass;
    state.background = 'none';
    state.lines = true;
    countControl.set('1');
    backgroundControl.set('none');
    linesControl.input.checked = true;
    render();
  });
  const secondOnly = [angleSliders[1].el, flip];
  const controls = node(
    doc,
    'div',
    { class: 'ph-controls' },
    countControl.el,
    backgroundControl.el,
    angleSliders[0].el,
    angleSliders[1].el,
    node(doc, 'div', { class: 'ph-actions' }, linesControl.el, flip, reset),
  );

  const legend = node(
    doc,
    'ul',
    { class: 'ph-legend' },
    node(
      doc,
      'li',
      {},
      node(doc, 'span', { class: 'ph-swatch', style: 'color:var(--ph-north)' }),
      ui.legendN,
    ),
    node(
      doc,
      'li',
      {},
      node(doc, 'span', { class: 'ph-swatch', style: 'color:var(--ph-south)' }),
      ui.legendS,
    ),
    node(doc, 'li', {}, ui.legendNeedle),
  );

  const el = node(
    doc,
    'div',
    { class: 'ph-magnet' },
    node(doc, 'h1', { class: 'ph-title' }, ui.title),
    node(doc, 'p', { class: 'ph-intro' }, ui.intro),
    node(doc, 'div', { class: 'ph-scene' }, svg),
    legend,
    node(doc, 'p', { class: 'ph-hint', id: hintId }, ui.hint),
    readout,
    controls,
  );

  // ---- the compass needle ----
  let needleState: Needle = { angle: 0, omega: 0 };
  let needleTarget = 0;
  let fieldDirty = true;
  let needleSnap = true;

  const drawNeedle = () =>
    needle.setAttribute(
      'transform',
      `rotate(${r1(-(needleState.angle * 180) / Math.PI)})`,
    );

  const loop = createLoop(doc, svg, (_now, dt) => {
    if (fieldDirty) computeField();
    if (reducedMotion || needleSnap) {
      needleState = { angle: needleTarget, omega: 0 };
      needleSnap = false;
    } else needleState = stepNeedle(needleState, needleTarget, dt);
    drawNeedle();

    return !needleSettled(needleState, needleTarget);
  });

  // ---- drawing ----
  function arrowHead(x: number, y: number, angle: number, size = 9): string {
    // Screen angle: y points down, so negate.
    const a = -angle;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const pt = (u: number, v: number) =>
      `${r1(x + u * c - v * s)} ${r1(y + u * s + v * c)}`;

    return `M${pt(size / 2, 0)}L${pt(-size / 2, size * 0.45)}L${pt(-size / 2, -size * 0.45)}Z`;
  }

  function computeField(): void {
    fieldDirty = false;
    const list = active();
    const visible = (x: number, y: number) =>
      Math.abs(x) <= halfX + 1 && Math.abs(y) <= HALF_Y + 1;

    // Lines and arrowheads.
    if (state.lines) {
      let d = '';
      let heads = '';

      for (const line of fieldLines(list, { bounds: TRACE })) {
        // Every second point is enough for the smooth parts; the ends keep all.
        let prev = line.points[0];
        d += `M${r1(px(prev.x))} ${r1(py(prev.y))}`;

        for (let i = 1; i < line.points.length; i += 1) {
          const p = line.points[i];
          const last = i === line.points.length - 1;
          if (!last && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.12) continue;
          d += `L${r1(px(p.x))} ${r1(py(p.y))}`;
          prev = p;
        }

        const mid = midpoint(line.points.filter(p => visible(p.x, p.y)));
        if (mid) heads += arrowHead(px(mid.at.x), py(mid.at.y), mid.angle);
      }

      linesPath.setAttribute('d', d);
      arrowsPath.setAttribute('d', heads);
    } else {
      linesPath.setAttribute('d', '');
      arrowsPath.setAttribute('d', '');
    }

    // Strength view and filings share the grid.
    const showHeat = state.background === 'strength';
    const showFilings = state.background === 'filings';
    heatGroup.style.display = showHeat ? '' : 'none';
    filingsGroup.style.display = showFilings ? '' : 'none';
    if (!showHeat && !showFilings) return;

    const heatPaths = heat.map(() => '');
    const filingPaths = filings.map(() => '');
    const cols = Math.ceil((2 * halfX) / CELL);
    const rows = Math.ceil((2 * HALF_Y) / CELL);

    for (let i = 0; i < cols; i += 1)
      for (let j = 0; j < rows; j += 1) {
        const [cx, cy] = [
          -halfX + (i + 0.5) * CELL,
          -HALF_Y + (j + 0.5) * CELL,
        ];

        if (showHeat) {
          const level = strengthLevel(
            magnitude(fieldAt(list, { x: cx, y: cy })),
            LEVELS,
          );
          if (level > 0)
            heatPaths[level] +=
              `M${r1(px(cx - CELL / 2))} ${r1(py(cy + CELL / 2))}h${r1(CELL * scale)}v${r1(CELL * scale)}h${r1(-CELL * scale)}z`;
        } else {
          const [jx, jy] = [
            (hash(i, j, 1) - 0.5) * CELL * 0.8,
            (hash(i, j, 2) - 0.5) * CELL * 0.8,
          ];
          const [x, y] = [cx + jx, cy + jy];
          if (list.some(m => inBody(m, { x, y }))) continue;
          const b = fieldAt(list, { x, y });
          const strong = strengthLevel(magnitude(b), LEVELS);
          if (strong === 0) continue;
          // Levels 1 to 7 become the four opacities of the filings.
          const level = Math.min(
            FILING_OPACITY.length - 1,
            1 + Math.floor((strong - 1) / 2),
          );
          const a = Math.atan2(b.y, b.x);
          const half = CELL * 0.36 * scale;
          const [dx, dy] = [Math.cos(a) * half, -Math.sin(a) * half];
          filingPaths[level] +=
            `M${r1(px(x) - dx)} ${r1(py(y) - dy)}l${r1(2 * dx)} ${r1(2 * dy)}`;
        }
      }

    heat.forEach((path, level) => path.setAttribute('d', heatPaths[level]));
    filings.forEach((path, level) =>
      path.setAttribute('d', filingPaths[level]),
    );
  }

  function render(): void {
    const height = scale * 2 * HALF_Y;
    setAttrs(svg, {
      viewBox: `0 0 ${r1(width)} ${r1(height)}`,
      width: r1(width),
      height: r1(height),
    });
    const L = state.magnets[0].length * scale;
    const W = state.magnets[0].width * scale;

    bodies.forEach((b, i) => {
      const m = state.magnets[i];
      const on = i < state.count;
      b.handle.style.display = b.rotate.style.display = on ? '' : 'none';
      b.handle.setAttribute('tabindex', on ? '0' : '-1');
      b.rotate.setAttribute('tabindex', on ? '0' : '-1');
      if (!on) return;
      const [cx, cy] = [px(m.x), py(m.y)];
      const transform = `translate(${r1(cx)} ${r1(cy)}) rotate(${r1(-deg(m.angle))})`;
      b.body.setAttribute('transform', transform);
      b.ring.setAttribute('transform', transform);
      setAttrs(b.southHalf, {
        x: r1(-L / 2),
        y: r1(-W / 2),
        width: r1(L / 2),
        height: r1(W),
      });
      setAttrs(b.northHalf, {
        x: 0,
        y: r1(-W / 2),
        width: r1(L / 2),
        height: r1(W),
      });
      setAttrs(b.outline, {
        x: r1(-L / 2),
        y: r1(-W / 2),
        width: r1(L),
        height: r1(W),
        rx: 3,
      });
      setAttrs(b.ring, {
        x: r1(-L / 2 - 6),
        y: r1(-W / 2 - 6),
        width: r1(L + 12),
        height: r1(W + 12),
        rx: 8,
      });

      // Pole letters sit at the middle of each half, unrotated, so they stay upright.
      const along = (k: number) => ({
        x: cx + Math.cos(m.angle) * k * (L / 4),
        y: cy - Math.sin(m.angle) * k * (L / 4),
      });
      const [pn, ps] = [along(1), along(-1)];
      setAttrs(b.letterN, { x: r1(pn.x), y: r1(pn.y) });
      setAttrs(b.letterS, { x: r1(ps.x), y: r1(ps.y) });
      // The number of the magnet sits beside the middle.
      setAttrs(b.tag, { x: r1(cx), y: r1(cy - W / 2 - 12) });

      // Rotation handle: past the north end.
      const reach = L / 2 + 26;
      const [rx, ry] = [
        cx + Math.cos(m.angle) * reach,
        cy - Math.sin(m.angle) * reach,
      ];
      for (const part of [b.rRing, b.rHit, b.rDot])
        setAttrs(part, { cx: r1(rx), cy: r1(ry) });
      b.rArc.setAttribute(
        'd',
        `M${r1(rx - 6)} ${r1(ry - 1)}A6 6 0 1 1 ${r1(rx - 3)} ${r1(ry + 5)}`,
      );
      b.rArc.setAttribute(
        'transform',
        `rotate(${r1(-deg(m.angle))} ${r1(rx)} ${r1(ry)})`,
      );
      setAttrs(b.handle, {
        'aria-label': ui.magnetLabel(i + 1, n(m.x), n(m.y), n(deg(m.angle), 0)),
      });
      setAttrs(b.rotate, {
        'aria-label': ui.rotateLabel(i + 1),
        'aria-valuenow': Math.round(deg(m.angle)),
        'aria-valuetext': `${n(deg(m.angle), 0)}°`,
      });
      angleSliders[i].set((Math.round(deg(m.angle) / 5) * 5) % 360);
    });

    // Compass.
    const [kx, ky] = [px(state.compass.x), py(state.compass.y)];
    compassPos.setAttribute('transform', `translate(${r1(kx)} ${r1(ky)})`);
    compass.setAttribute(
      'aria-label',
      ui.compassLabel(n(state.compass.x), n(state.compass.y)),
    );

    const list = active();
    needleTarget = fieldAngle(list, state.compass);
    const b = fieldAt(list, state.compass);
    fieldValue.textContent = `${n(magnitude(b), 2)} (${ui.relative})`;
    directionValue.textContent = `${n(deg(needleTarget), 0)} ${ui.degrees}`;

    // Interaction.
    for (const item of secondOnly)
      item.style.display = state.count === 2 ? '' : 'none';
    forceRow.style.display = state.count === 2 ? '' : 'none';
    bodies.forEach(b2 => (b2.forceArrow.style.display = 'none'));

    if (state.count === 2) {
      const r = interaction(state.magnets[0], state.magnets[1]);
      const label = (k: 'N' | 'S') => (k === 'N' ? ui.northPole : ui.southPole);
      verdict.textContent =
        r.verdict === 'attract'
          ? ui.attract
          : r.verdict === 'repel'
            ? ui.repel
            : ui.noForce;
      why.textContent =
        r.verdict === 'attract'
          ? ui.attractWhy
          : r.verdict === 'repel'
            ? ui.repelWhy
            : '';
      facing.textContent = ui.facing(
        label(r.closest.first),
        label(r.closest.second),
        n(r.closest.distance),
      );
      forceValue.textContent = n(magnitude(r.force), 2);
      el.dataset.interaction = r.verdict;
      const length = Math.min(80, Math.sqrt(magnitude(r.force)) * 70);

      if (length >= 8) {
        const angle = Math.atan2(r.force.y, r.force.x);
        // Force on magnet 2 along `angle`, on magnet 1 the opposite way.
        [1, 0].forEach(i => {
          const a = i === 1 ? angle : angle + Math.PI;
          const m = state.magnets[i];
          const lead = (m.length * scale) / 2 + 6;
          const [sx, sy] = [
            px(m.x) + Math.cos(a) * lead,
            py(m.y) - Math.sin(a) * lead,
          ];
          const [ex, ey] = [
            sx + Math.cos(a) * length,
            sy - Math.sin(a) * length,
          ];
          const b2 = bodies[i];
          setAttrs(b2.forceLine, {
            x1: r1(sx),
            y1: r1(sy),
            x2: r1(ex),
            y2: r1(ey),
          });
          b2.forceHead.setAttribute('d', arrowHead(ex, ey, a, 14));
          b2.forceArrow.style.display = '';
        });
      }
    } else {
      verdict.textContent = ui.singleHint;
      why.textContent = '';
      facing.textContent = '';
      el.dataset.interaction = 'single';
    }

    linesControl.input.checked = state.lines;
    fieldDirty = true;
    loop.wake();
  }

  // ---- interaction ----
  const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

  const place = (m: Magnet, x: number, y: number) => {
    m.x = round(clamp(x, -halfX + 2, halfX - 2));
    m.y = round(clamp(y, -HALF_Y + 1.5, HALF_Y - 1.5));
  };

  const world = (at: { x: number; y: number }) => ({
    x: (at.x - ox) / scale,
    y: (oy - at.y) / scale,
  });

  bodies.forEach((b, i) => {
    const m = () => state.magnets[i];
    draggable(b.handle, svg, {
      onStart: () => ({ x: px(m().x), y: py(m().y) }),
      onMove: (at, grab) => {
        const w = world({ x: at.x + grab.x, y: at.y + grab.y });
        place(m(), w.x, w.y);
        render();
      },
    });
    arrowKeys(b.handle, (dir, event) => {
      const step = event.shiftKey ? 0.05 : 0.25;

      if (event.shiftKey && (dir === 'left' || dir === 'right')) {
        m().angle += ((dir === 'left' ? 1 : -1) * Math.PI) / 36;
        // Counterclockwise on the screen is positive, and Left turns that way.
        render();

        return;
      }

      const dx = dir === 'left' ? -step : dir === 'right' ? step : 0;
      const dy = dir === 'up' ? step : dir === 'down' ? -step : 0;
      place(m(), m().x + dx, m().y + dy);
      render();
    });

    draggable(b.rotate, svg, {
      onMove: at => {
        const w = world(at);
        m().angle = Math.atan2(w.y - m().y, w.x - m().x);
        render();
      },
    });
    arrowKeys(b.rotate, (dir, event) => {
      const step = event.shiftKey ? Math.PI / 180 : Math.PI / 36;
      if (dir === 'left' || dir === 'down') m().angle += step;
      else m().angle -= step;
      render();
    });
  });

  draggable(compass, svg, {
    onStart: () => ({ x: px(state.compass.x), y: py(state.compass.y) }),
    onMove: (at, grab) => {
      const w = world({ x: at.x + grab.x, y: at.y + grab.y });
      state.compass = {
        x: round(clamp(w.x, -halfX + 0.8, halfX - 0.8)),
        y: round(clamp(w.y, -HALF_Y + 0.8, HALF_Y - 0.8)),
      };
      render();
    },
  });
  arrowKeys(compass, (dir, event) => {
    const step = event.shiftKey ? 0.05 : 0.25;
    const dx = dir === 'left' ? -step : dir === 'right' ? step : 0;
    const dy = dir === 'up' ? step : dir === 'down' ? -step : 0;
    state.compass = {
      x: round(clamp(state.compass.x + dx, -halfX + 0.8, halfX - 0.8)),
      y: round(clamp(state.compass.y + dy, -HALF_Y + 0.8, HALF_Y - 0.8)),
    };
    render();
  });

  function resize(next: number): void {
    width = Math.max(280, next);
    scale = Math.min(34, width / (2 * HALF_X));
    halfX = width / (2 * scale);
    [ox, oy] = [width / 2, scale * HALF_Y];
    render();
  }

  resize(width);
  computeField();
  needleState = { angle: needleTarget, omega: 0 };
  needleSnap = false;
  drawNeedle();

  return { el, state, resize };
}
