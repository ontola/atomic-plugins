// @wc-ignore-file
/**
 * The lens scene: plain DOM and one SVG. Elements are created once and their
 * attributes are rewritten on every change, so keyboard focus survives dragging.
 * The scene is drawn in pixels (units: centimetres times `scale`) so text stays
 * readable on a phone; it is re-laid out when its width changes.
 */
import {
  principalRays,
  signedFocal,
  thinLens,
  type Pt,
} from '../core/optics.js';
import { arrowKeys, clamp, draggable } from '../shared/drag.js';
import {
  node,
  r1,
  segmented,
  setAttrs,
  slider,
  snode,
  uid,
} from '../shared/dom.js';
import { fmt, type Lang } from '../shared/lang.js';
import type { Strings } from './strings.js';

export type Kind = 'convex' | 'concave';

export interface LensState {
  kind: Kind;
  /** Focal distance |f|, cm. */
  focal: number;
  /** Object distance v, cm. */
  v: number;
  /** Object height, cm. */
  h: number;
}

export const LIMITS = {
  v: { min: 1, max: 18, step: 0.1 },
  focal: { min: 2, max: 10, step: 0.1 },
  h: { min: 0.5, max: 5, step: 0.1 },
};

/** Half the drawn width and height, in cm. */
const HALF_X = 20;
const HALF_Y = 9;
const LENS_HALF = 8;

export interface LensApp {
  el: HTMLElement;
  state: LensState;
  /** Re-lays out the scene for a new width. */
  resize(width: number): void;
}

export function createLensApp(
  doc: Document,
  ui: Strings,
  lang: Lang,
  initial: LensState = { kind: 'convex', focal: 6, v: 14, h: 3 },
): LensApp {
  const state: LensState = { ...initial };
  const n = (x: number, d = 1) => fmt(x, d, lang);
  let width = 720;
  let scale = 18;
  let halfVisible = HALF_X;
  let [ox, oy] = [0, 0];
  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy - y * scale;

  // ---- scene ----
  const svg = snode(doc, 'svg', {
    role: 'group',
    'aria-label': ui.scene,
    preserveAspectRatio: 'xMidYMid meet',
  });
  const grid = snode(doc, 'g');
  const ticks: { line: SVGElement; label: SVGElement; x: number }[] = [];

  for (let x = -35; x <= 35; x += 5) {
    const line = snode(doc, 'line', { class: 'ph-tick' });
    const label = snode(doc, 'text', {
      class: 'ph-label ph-small',
      'text-anchor': 'middle',
    });
    label.textContent = x === 0 ? '' : `${Math.abs(x)}`;
    if (x === 0) line.setAttribute('visibility', 'hidden');
    grid.append(line, label);
    ticks.push({ line, label, x });
  }

  const unit = snode(doc, 'text', {
    class: 'ph-label ph-small',
    'text-anchor': 'end',
  });
  unit.textContent = 'cm';
  const axis = snode(doc, 'line', {
    class: 'ph-axis',
    stroke: 'var(--ph-muted)',
    'stroke-width': 1.5,
  });
  const lensShape = snode(doc, 'path', {
    fill: 'color-mix(in srgb, var(--ph-c1) 14%, transparent)',
    stroke: 'var(--ph-text)',
    'stroke-width': 2,
    'stroke-linejoin': 'round',
  });

  const rayIds = ['parallel', 'center', 'focal'] as const;
  const rayColor = ['var(--ph-c1)', 'var(--ph-c2)', 'var(--ph-c3)'];
  const rays = rayIds.map((id, i) => {
    const common = {
      stroke: rayColor[i],
      fill: 'none',
      'stroke-linecap': 'round',
    };
    const incoming = snode(doc, 'line', { ...common, 'stroke-width': 2.5 });
    const outgoing = snode(doc, 'line', { ...common, 'stroke-width': 2.5 });
    const back = snode(doc, 'line', {
      ...common,
      'stroke-width': 2,
      'stroke-dasharray': '2 6',
    });
    const tag = snode(doc, 'text', {
      class: 'ph-label',
      'text-anchor': 'middle',
    });
    tag.textContent = String(i + 1);

    return { id, incoming, outgoing, back, tag };
  });
  const raysGroup = snode(doc, 'g', { 'data-rays': '' });
  for (const r of rays) raysGroup.append(r.back, r.incoming, r.outgoing);

  const imageGroup = snode(doc, 'g', { 'data-image': '' });
  const imageShaft = snode(doc, 'line', {
    stroke: 'var(--ph-c2)',
    'stroke-width': 4,
    'stroke-linecap': 'round',
  });
  const imageHead = snode(doc, 'path', { fill: 'var(--ph-c2)' });
  const imageLabel = snode(doc, 'text', {
    class: 'ph-label',
    'text-anchor': 'middle',
  });
  imageLabel.textContent = ui.image;
  imageGroup.append(imageShaft, imageHead, imageLabel);

  const hintId = uid('ph-lens-hint');

  // Focal points: two draggable markers.
  const focusPoints = (
    [
      ['object', -1],
      ['image', 1],
    ] as const
  ).map(([side, sign]) => {
    const ring = snode(doc, 'circle', { class: 'ph-ring', r: 15 });
    const hit = snode(doc, 'circle', { r: 18, fill: 'transparent' });
    const dot = snode(doc, 'circle', {
      r: 5.5,
      fill: 'var(--ph-bg)',
      stroke: 'var(--ph-text)',
      'stroke-width': 2.5,
    });
    const label = snode(doc, 'text', {
      class: 'ph-label',
      'text-anchor': 'middle',
    });
    label.textContent = 'F';
    const g = snode(doc, 'g', {
      class: 'ph-handle',
      tabindex: 0,
      role: 'slider',
      'data-handle': `focus-${side}`,
      'aria-describedby': hintId,
      'aria-orientation': 'horizontal',
      'aria-valuemin': LIMITS.focal.min,
      'aria-valuemax': LIMITS.focal.max,
    });
    g.append(ring, hit, dot, label);

    return { g, ring, hit, dot, label, sign, side };
  });

  // Object: an arrow with a wide grab area.
  const objRing = snode(doc, 'circle', { class: 'ph-ring', r: 17 });
  const objGrab = snode(doc, 'line', {
    stroke: 'transparent',
    'stroke-width': 30,
    'stroke-linecap': 'round',
  });
  const objShaft = snode(doc, 'line', {
    stroke: 'var(--ph-text)',
    'stroke-width': 4,
    'stroke-linecap': 'round',
  });
  const objHead = snode(doc, 'path', { fill: 'var(--ph-text)' });
  const objLabel = snode(doc, 'text', {
    class: 'ph-label',
    'text-anchor': 'middle',
  });
  objLabel.textContent = ui.object;
  const objectHandle = snode(doc, 'g', {
    class: 'ph-handle',
    tabindex: 0,
    role: 'button',
    'data-handle': 'object',
    'aria-describedby': hintId,
  });
  objectHandle.append(objRing, objGrab, objShaft, objHead, objLabel);

  svg.append(grid, axis, raysGroup, lensShape);
  for (const r of rays) svg.append(r.tag);
  svg.append(imageGroup);
  for (const f of focusPoints) svg.append(f.g);
  svg.append(unit, objectHandle);

  const arrow = (x: number, y0: number, y1: number): string => {
    // A filled head at (x, y1), pointing away from y0, in pixels.
    const dir = y1 >= y0 ? 1 : -1;

    return `M${r1(x)} ${r1(y1 + dir * 2)}L${r1(x - 7)} ${r1(y1 - dir * 11)}L${r1(x + 7)} ${r1(y1 - dir * 11)}Z`;
  };

  // ---- readout ----
  const values = {
    v: node(doc, 'dd'),
    b: node(doc, 'dd'),
    f: node(doc, 'dd'),
    n: node(doc, 'dd'),
    height: node(doc, 'dd'),
  };
  const row = (label: string, dd: HTMLElement) =>
    node(doc, 'div', {}, node(doc, 'dt', {}, label), dd);
  const formula = node(doc, 'p', { class: 'ph-formula', 'data-formula': '' });
  const verdict = node(doc, 'p', { class: 'ph-verdict', 'data-verdict': '' });
  const readout = node(
    doc,
    'section',
    { class: 'ph-panel', 'aria-label': ui.formulaTitle },
    node(
      doc,
      'dl',
      { class: 'ph-values', 'aria-live': 'polite' },
      row(ui.valueV, values.v),
      row(ui.valueB, values.b),
      row(ui.valueF, values.f),
      row(ui.valueN, values.n),
      row(ui.valueHeight, values.height),
    ),
    formula,
    verdict,
  );

  // ---- controls ----
  const kindControl = segmented(doc, {
    label: ui.kind,
    options: [
      { value: 'convex' as Kind, label: ui.convex },
      { value: 'concave' as Kind, label: ui.concave },
    ],
    value: state.kind,
    onChange: kind => {
      state.kind = kind;
      render();
    },
  });
  const cm = (x: number) => `${n(x)} cm`;
  const vSlider = slider(doc, {
    label: ui.sliderV,
    ...LIMITS.v,
    value: state.v,
    format: cm,
    onInput: v => {
      state.v = v;
      render();
    },
  });
  const fSlider = slider(doc, {
    label: ui.sliderF,
    ...LIMITS.focal,
    value: state.focal,
    format: cm,
    onInput: f => {
      state.focal = f;
      render();
    },
  });
  const hSlider = slider(doc, {
    label: ui.sliderH,
    ...LIMITS.h,
    value: state.h,
    format: cm,
    onInput: h => {
      state.h = h;
      render();
    },
  });
  const controls = node(
    doc,
    'div',
    { class: 'ph-controls' },
    kindControl.el,
    vSlider.el,
    fSlider.el,
    hSlider.el,
  );

  const legend = node(
    doc,
    'ul',
    { class: 'ph-legend', 'aria-label': ui.rays },
    ...[ui.ray1, ui.ray2, ui.ray3].map((text, i) =>
      node(
        doc,
        'li',
        {},
        node(doc, 'span', {
          class: 'ph-swatch',
          style: `color:${rayColor[i]}`,
        }),
        `${i + 1}. ${text}`,
      ),
    ),
    node(doc, 'li', { 'data-virtual-legend': '' }, ui.virtualLine),
  );

  const el = node(
    doc,
    'div',
    { class: 'ph-lens' },
    node(doc, 'h1', { class: 'ph-title' }, ui.title),
    node(doc, 'p', { class: 'ph-intro' }, ui.intro),
    node(doc, 'div', { class: 'ph-scene' }, svg),
    legend,
    node(doc, 'p', { class: 'ph-hint', id: hintId }, ui.hint),
    readout,
    controls,
    node(doc, 'p', { class: 'ph-hint' }, ui.signs),
  );

  // ---- drawing ----
  function render(): void {
    const f = signedFocal(state.kind, state.focal);
    const lens = { f, v: state.v, h: state.h };
    const image = thinLens(lens);
    const height = scale * 2 * HALF_Y;
    setAttrs(svg, {
      viewBox: `0 0 ${r1(width)} ${r1(height)}`,
      width: r1(width),
      height: r1(height),
    });

    for (const t of ticks) {
      const on = Math.abs(t.x) < halfVisible - 1;
      t.line.style.display = t.label.style.display = on ? '' : 'none';
      setAttrs(t.line, {
        x1: r1(px(t.x)),
        x2: r1(px(t.x)),
        y1: r1(oy - 4),
        y2: r1(oy + 4),
      });
      setAttrs(t.label, { x: r1(px(t.x)), y: r1(oy + 20) });
    }

    setAttrs(unit, { x: r1(width - 8), y: r1(oy - 8) });
    setAttrs(axis, { x1: 0, x2: r1(width), y1: r1(oy), y2: r1(oy) });

    const lh = LENS_HALF * scale;
    const [top, bottom, e, c] = [oy - lh, oy + lh, 0.9 * scale, 0.7 * scale];
    lensShape.setAttribute(
      'd',
      state.kind === 'convex'
        ? `M${r1(ox)} ${r1(top)}Q${r1(ox + 2 * c)} ${r1(oy)} ${r1(ox)} ${r1(bottom)}Q${r1(ox - 2 * c)} ${r1(oy)} ${r1(ox)} ${r1(top)}Z`
        : `M${r1(ox - e)} ${r1(top)}L${r1(ox + e)} ${r1(top)}Q${r1(ox - 0.7 * scale)} ${r1(oy)} ${r1(ox + e)} ${r1(bottom)}L${r1(ox - e)} ${r1(bottom)}Q${r1(ox + 0.7 * scale)} ${r1(oy)} ${r1(ox - e)} ${r1(top)}Z`,
    );

    const xEnd = halfVisible + 2;
    const traced = principalRays(lens, xEnd);
    const line = (target: Element, a: Pt, b: Pt) =>
      setAttrs(target, {
        x1: r1(px(a.x)),
        y1: r1(py(a.y)),
        x2: r1(px(b.x)),
        y2: r1(py(b.y)),
      });

    for (const r of rays) {
      const found = traced.find(t => t.id === r.id);
      r.incoming.style.display = r.outgoing.style.display = found ? '' : 'none';
      r.tag.style.display = found ? '' : 'none';
      r.back.style.display = found?.back ? '' : 'none';
      if (!found) continue;
      line(r.incoming, found.incoming[0], found.incoming[1]);
      line(r.outgoing, found.outgoing[0], found.outgoing[1]);
      if (found.back) line(r.back, found.back[0], found.back[1]);
      // The number sits on the incoming ray, a third of the way from the tip.
      const [a, b] = found.incoming;
      setAttrs(r.tag, {
        x: r1(px(a.x + (b.x - a.x) * 0.3)),
        y: r1(py(a.y + (b.y - a.y) * 0.3) - 8),
      });
    }

    // Object.
    const [objX, objY] = [px(-state.v), py(state.h)];
    for (const l of [objGrab, objShaft])
      setAttrs(l, { x1: r1(objX), x2: r1(objX), y1: r1(oy), y2: r1(objY) });
    objHead.setAttribute('d', arrow(objX, oy, objY));
    setAttrs(objRing, { cx: r1(objX), cy: r1(objY) });
    setAttrs(objLabel, { x: r1(objX), y: r1(oy + 36) });
    objectHandle.setAttribute(
      'aria-label',
      ui.objectLabel(n(state.v), n(state.h)),
    );

    // Image.
    const shown =
      !image.atInfinity && image.tip && Math.abs(image.tip.x) <= HALF_X + 1;
    imageGroup.style.display = shown ? '' : 'none';

    if (shown && image.tip) {
      const [ix, iy] = [px(image.tip.x), py(image.tip.y)];
      setAttrs(imageShaft, {
        x1: r1(ix),
        x2: r1(ix),
        y1: r1(oy),
        y2: r1(iy),
        'stroke-dasharray': image.real ? null : '7 6',
      });
      imageHead.setAttribute('d', arrow(ix, oy, iy));
      setAttrs(imageLabel, { x: r1(ix), y: r1(oy + (iy < oy ? 36 : -28)) });
    }

    legend.querySelector<HTMLElement>('[data-virtual-legend]')!.style.display =
      image.real ? 'none' : '';

    // Focal points, at -f and +f on the axis (for a concave lens the one on the object side is the real reference point).
    for (const p of focusPoints) {
      const x = px(p.sign * state.focal);
      setAttrs(p.ring, { cx: r1(x), cy: r1(oy) });
      setAttrs(p.hit, { cx: r1(x), cy: r1(oy) });
      setAttrs(p.dot, { cx: r1(x), cy: r1(oy) });
      setAttrs(p.label, { x: r1(x), y: r1(oy - 14) });
      setAttrs(p.g, {
        'aria-label': ui.focusLabel(p.side, n(state.focal)),
        'aria-valuenow': r1(state.focal),
        'aria-valuetext': `${n(state.focal)} cm`,
      });
    }

    // Controls follow the state (a drag or a key changed it).
    vSlider.set(state.v);
    fSlider.set(state.focal);
    hSlider.set(state.h);
    kindControl.set(state.kind);

    // Readout.
    const inv = (x: number) => (Number.isFinite(x) && x !== 0 ? 1 / x : 0);
    values.v.textContent = `${n(state.v)} cm`;
    values.b.textContent = image.atInfinity ? '∞' : `${n(image.b)} cm`;
    values.f.textContent = `${n(f)} cm`;
    values.n.textContent = image.atInfinity ? '∞' : n(image.n, 2);
    values.height.textContent = image.atInfinity
      ? '∞'
      : `${n(Math.abs(image.height))} cm`;
    formula.textContent = `1/f = 1/v + 1/b → ${n(inv(f), 3)} = ${n(inv(state.v), 3)} + ${n(inv(image.b), 3)} (${ui.perCm})`;
    verdict.textContent = image.atInfinity
      ? ui.atFocus
      : `${ui.describe(
          image.real ? ui.real : ui.virtual,
          image.upright ? ui.upright : ui.inverted,
          image.size === 'same'
            ? ui.same
            : image.size === 'enlarged'
              ? ui.enlarged
              : ui.reduced,
          n(image.n, 2),
        )}${shown ? '' : ` ${ui.far}`}`;
    el.dataset.real = String(image.real);
  }

  // ---- interaction ----
  const set = (patch: Partial<LensState>) => {
    Object.assign(state, patch);
    state.v = clamp(state.v, LIMITS.v.min, LIMITS.v.max);
    state.focal = clamp(state.focal, LIMITS.focal.min, LIMITS.focal.max);
    state.h = clamp(state.h, LIMITS.h.min, LIMITS.h.max);
    render();
  };

  const round1 = (x: number) => Math.round(x * 10) / 10;

  draggable(objectHandle, svg, {
    onStart: () => ({ x: px(-state.v), y: py(state.h) }),
    onMove: (at, grab) =>
      set({
        v: round1(-(at.x + grab.x - ox) / scale),
        h: round1((oy - (at.y + grab.y)) / scale),
      }),
  });
  arrowKeys(objectHandle, (dir, event) => {
    const step = event.shiftKey ? 0.1 : 0.5;
    if (dir === 'left') set({ v: round1(state.v + step) });
    else if (dir === 'right') set({ v: round1(state.v - step) });
    else if (dir === 'up') set({ h: round1(state.h + step) });
    else set({ h: round1(state.h - step) });
  });

  for (const p of focusPoints) {
    draggable(p.g, svg, {
      onStart: () => ({ x: px(p.sign * state.focal), y: oy }),
      onMove: (at, grab) =>
        set({ focal: round1((p.sign * (at.x + grab.x - ox)) / scale) }),
    });
    arrowKeys(p.g, (dir, event) => {
      const step = event.shiftKey ? 0.1 : 0.5;
      // The marker moves the way the arrow points.
      const move = dir === 'right' ? 1 : dir === 'left' ? -1 : 0;
      if (move) set({ focal: round1(state.focal + p.sign * move * step) });
    });
  }

  function resize(next: number): void {
    width = Math.max(280, next);
    scale = Math.min(22, width / (2 * HALF_X));
    halfVisible = width / (2 * scale);
    [ox, oy] = [width / 2, scale * HALF_Y];
    render();
  }

  resize(width);

  return { el, state, resize };
}
