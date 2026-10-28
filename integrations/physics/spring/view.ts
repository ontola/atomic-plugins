// @wc-ignore-file
/**
 * The spring scene: a mass on a spring, drawn in pixels, and a live u(t)
 * plot that shares its vertical scale and zero line. The simulation runs in
 * fixed RK4 sub steps inside animation frames and only while the app is
 * visible and playing.
 */
import {
  advance,
  dampedPeriod,
  decayRate,
  naturalPeriod,
  PeriodMeter,
  regime,
  start,
  type Spring,
  type State,
} from '../core/oscillator.js';
import { arrowKeys, clamp, draggable } from '../shared/drag.js';
import {
  button,
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

export interface SpringState {
  /** kg */
  m: number;
  /** N/m */
  C: number;
  /** Amplitude, cm. */
  A: number;
  /** Damping, kg/s. */
  c: number;
  speed: 0.25 | 0.5 | 1;
  running: boolean;
}

export const LIMITS = {
  m: { min: 0.1, max: 5, step: 0.1 },
  C: { min: 1, max: 100, step: 1 },
  A: { min: 2, max: 15, step: 0.5 },
  c: { min: 0, max: 8, step: 0.05 },
};

const FIG_W = 130;
/** Horizontal centre of the spring and the mass. */
const CX = 46;
const HEIGHT = 330;
const Y_EQ = 180;
/** Pixels per centimetre of displacement, for the figure and the plot alike. */
const PX_PER_CM = 7;
const CEILING = 14;
const MASS_H = 36;
const MASS_W = 64;

export interface SpringApp {
  el: HTMLElement;
  state: SpringState;
  /** The current simulation state and meter, for tests. */
  sim(): {
    time: number;
    u: number;
    period: number | undefined;
    samples: number;
  };
  resize(width: number): void;
}

export function createSpringApp(
  doc: Document,
  ui: Strings,
  lang: Lang,
  reducedMotion = false,
  initial?: Partial<SpringState>,
): SpringApp {
  const state: SpringState = {
    m: 0.5,
    C: 20,
    A: 8,
    c: 0,
    speed: 1,
    running: !reducedMotion,
    ...initial,
  };
  const n = (x: number, d = 1) => fmt(x, d, lang);
  const spring = (): Spring => ({ m: state.m, C: state.C, c: state.c });
  const amplitude = () => state.A / 100;

  let sim: State = start(amplitude());
  const meter = new PeriodMeter();
  let samples: { t: number; u: number }[] = [];
  let lastSample = -Infinity;
  let plotW = 400;

  // ---- figure ----
  const hintId = uid('ph-spring-hint');
  const fig = snode(doc, 'svg', {
    role: 'group',
    'aria-label': ui.figure,
    viewBox: `0 0 ${FIG_W} ${HEIGHT}`,
    width: FIG_W,
    height: HEIGHT,
  });
  const ceiling = snode(doc, 'path', {
    d: `M${CX - 40} ${CEILING}H${CX + 40}`,
    stroke: 'var(--ph-text)',
    'stroke-width': 5,
    'stroke-linecap': 'round',
  });
  const hatch = snode(doc, 'path', {
    d: Array.from(
      { length: 9 },
      (_, i) => `M${CX - 40 + i * 10} ${CEILING - 2}l-6 -8`,
    ).join(''),
    stroke: 'var(--ph-muted)',
    'stroke-width': 1.5,
  });
  const eqLine = snode(doc, 'line', {
    x1: 6,
    x2: FIG_W - 6,
    y1: Y_EQ,
    y2: Y_EQ,
    stroke: 'var(--ph-muted)',
    'stroke-width': 1.5,
    'stroke-dasharray': '5 5',
  });
  const rulerTitle = snode(doc, 'text', {
    class: 'ph-label ph-small',
    x: 88,
    y: 44,
    'text-anchor': 'middle',
  });
  rulerTitle.textContent = 'u (cm)';
  const ruler = snode(doc, 'g');
  const springPath = snode(doc, 'path', {
    fill: 'none',
    stroke: 'var(--ph-c2)',
    'stroke-width': 3,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'data-spring': '',
  });
  const massRing = snode(doc, 'rect', {
    class: 'ph-ring',
    x: -MASS_W / 2 - 6,
    y: -MASS_H / 2 - 6,
    width: MASS_W + 12,
    height: MASS_H + 12,
    rx: 8,
  });
  const massRect = snode(doc, 'rect', {
    x: -MASS_W / 2,
    y: -MASS_H / 2,
    width: MASS_W,
    height: MASS_H,
    rx: 5,
    fill: 'var(--ph-bg)',
    stroke: 'var(--ph-c1)',
    'stroke-width': 3.5,
  });
  const massText = snode(doc, 'text', {
    class: 'ph-label',
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    style: 'stroke:none',
  });
  const mass = snode(doc, 'g', {
    class: 'ph-handle',
    tabindex: 0,
    role: 'slider',
    'data-handle': 'mass',
    'aria-orientation': 'vertical',
    'aria-valuemin': LIMITS.A.min,
    'aria-valuemax': LIMITS.A.max,
    'aria-describedby': hintId,
  });
  mass.append(massRing, massRect, massText);
  fig.append(eqLine, rulerTitle, ruler, ceiling, hatch, springPath, mass);

  // ---- plot ----
  const plot = snode(doc, 'svg', {
    role: 'img',
    'aria-label': ui.plot,
    preserveAspectRatio: 'xMidYMid meet',
  });
  const plotGrid = snode(doc, 'g');
  const envelope = snode(doc, 'path', {
    fill: 'none',
    stroke: 'var(--ph-muted)',
    'stroke-width': 1.5,
    'stroke-dasharray': '2 5',
    'stroke-linecap': 'round',
  });
  const curve = snode(doc, 'path', {
    fill: 'none',
    stroke: 'var(--ph-c1)',
    'stroke-width': 2.5,
    'stroke-linejoin': 'round',
    'data-curve': '',
  });
  const marks = snode(doc, 'g');
  const dot = snode(doc, 'circle', {
    r: 5,
    fill: 'var(--ph-c2)',
    stroke: 'var(--ph-bg)',
    'stroke-width': 2,
  });
  const axisU = snode(doc, 'text', { class: 'ph-label ph-small', x: 4, y: 14 });
  axisU.textContent = ui.axisU;
  const axisT = snode(doc, 'text', {
    class: 'ph-label ph-small',
    'text-anchor': 'end',
    y: Y_EQ - 6,
  });
  axisT.textContent = ui.axisT;
  plot.append(plotGrid, envelope, marks, curve, dot, axisU, axisT);

  // ---- readout ----
  const dd = () => node(doc, 'dd');
  const values = { T: dd(), measured: dd(), f: dd(), time: dd(), u: dd() };
  const row = (label: string, el: HTMLElement) =>
    node(doc, 'div', {}, node(doc, 'dt', {}, label), el);
  const formula = node(doc, 'p', { class: 'ph-formula', 'data-formula': '' });
  const status = node(doc, 'p', {
    class: 'ph-verdict',
    role: 'status',
    'data-regime': '',
  });
  const readout = node(
    doc,
    'section',
    { class: 'ph-panel', 'aria-label': ui.valueT },
    node(
      doc,
      'dl',
      { class: 'ph-values' },
      row(ui.valueT, values.T),
      row(ui.valueMeasured, values.measured),
      row(ui.valueF, values.f),
      row(ui.valueTime, values.time),
      row(ui.valueU, values.u),
    ),
    formula,
    status,
    node(doc, 'p', { class: 'ph-hint' }, ui.measuredNote),
  );

  // ---- controls ----
  const restartSim = () => {
    sim = start(amplitude());
    meter.reset();
    meter.push(sim.t, sim.u);
    samples = [{ t: 0, u: sim.u }];
    lastSample = 0;
  };

  const changed = () => {
    restartSim();
    drawStatic();
    draw();
    loop.wake();
  };

  const sliders = {
    m: slider(doc, {
      label: ui.sliderM,
      ...LIMITS.m,
      value: state.m,
      format: v => `${n(v)} ${ui.m}`,
      onInput: v => {
        state.m = v;
        changed();
      },
    }),
    C: slider(doc, {
      label: ui.sliderC,
      ...LIMITS.C,
      value: state.C,
      format: v => `${n(v, 0)} ${ui.C}`,
      onInput: v => {
        state.C = v;
        changed();
      },
    }),
    A: slider(doc, {
      label: ui.sliderA,
      ...LIMITS.A,
      value: state.A,
      format: v => `${n(v)} cm`,
      onInput: v => {
        state.A = v;
        changed();
      },
    }),
    c: slider(doc, {
      label: ui.sliderD,
      ...LIMITS.c,
      value: state.c,
      format: v => `${n(v, 2)} ${ui.c}`,
      onInput: v => {
        state.c = v;
        changed();
      },
    }),
  };
  const toggle = button(
    doc,
    '',
    () => setRunning(!state.running),
    'ph-btn ph-primary',
  );
  toggle.dataset.toggle = '';
  const restart = button(doc, ui.restart, () => {
    restartSim();
    draw();
    loop.wake();
  });
  const speed = segmented(doc, {
    label: ui.speed,
    options: [
      { value: '0.25', label: '×0,25'.replace(',', lang === 'nl' ? ',' : '.') },
      { value: '0.5', label: '×0,5'.replace(',', lang === 'nl' ? ',' : '.') },
      { value: '1', label: '×1' },
    ],
    value: String(state.speed),
    onChange: v => {
      state.speed = Number(v) as SpringState['speed'];
    },
  });
  const controls = node(
    doc,
    'div',
    { class: 'ph-controls' },
    sliders.m.el,
    sliders.C.el,
    sliders.A.el,
    sliders.c.el,
    node(doc, 'div', { class: 'ph-actions' }, toggle, restart),
    speed.el,
  );

  const legend = node(
    doc,
    'ul',
    { class: 'ph-legend' },
    node(doc, 'li', { 'data-envelope-legend': '' }, ui.envelope),
  );
  const el = node(
    doc,
    'div',
    { class: 'ph-spring' },
    node(doc, 'h1', { class: 'ph-title' }, ui.title),
    node(doc, 'p', { class: 'ph-intro' }, ui.intro),
    node(
      doc,
      'div',
      { class: 'ph-scene ph-spring-scene' },
      node(doc, 'div', { class: 'ph-spring-fig' }, fig),
      node(doc, 'div', { class: 'ph-spring-plot' }, plot),
    ),
    legend,
    node(doc, 'p', { class: 'ph-hint', id: hintId }, ui.hint),
    readout,
    controls,
  );

  // ---- loop ----
  const windowSeconds = () => {
    const T = Number.isFinite(dampedPeriod(spring()))
      ? dampedPeriod(spring())
      : naturalPeriod(state.m, state.C);

    return clamp(4.5 * T, 2, 20);
  };

  const loop = createLoop(doc, fig, (_now, dt) => {
    if (!state.running) return false;
    step(dt * state.speed);
    draw();

    return true;
  });

  function step(elapsed: number): void {
    if (elapsed <= 0) return;
    const spacing = windowSeconds() / 600;
    sim = advance(spring(), sim, elapsed, 1 / 240, next => {
      meter.push(next.t, next.u);

      if (next.t - lastSample >= spacing) {
        samples.push({ t: next.t, u: next.u });
        lastSample = next.t;
      }
    });
    // Forget what has scrolled out of the plot.
    const oldest = sim.t - windowSeconds() - spacing;
    let drop = 0;
    while (drop < samples.length - 2 && samples[drop + 1].t < oldest) drop += 1;
    if (drop) samples = samples.slice(drop);
  }

  function setRunning(on: boolean): void {
    state.running = on;
    toggle.textContent = on ? ui.pause : ui.start;
    toggle.setAttribute('aria-pressed', String(on));
    loop.wake();
  }

  // ---- drawing ----
  const yOf = (uCm: number) => Y_EQ - uCm * PX_PER_CM;

  function drawStatic(): void {
    const T = naturalPeriod(state.m, state.C);
    const kind = regime(spring());
    values.T.textContent = `${n(T, 2)} s`;
    values.f.textContent = `${n(1 / T, 2)} Hz`;
    formula.textContent = ui.formula(n(state.m, 2), n(state.C, 1), n(T, 2));
    status.textContent =
      kind === 'undamped'
        ? ui.regimeNone
        : kind === 'under'
          ? ui.regimeUnder(n(dampedPeriod(spring()), 2))
          : kind === 'critical'
            ? ui.regimeCritical
            : ui.regimeOver;
    legend.querySelector<HTMLElement>('[data-envelope-legend]')!.style.display =
      kind === 'under' ? '' : 'none';
    massText.textContent = `${n(state.m)} ${ui.m}`;
    mass.setAttribute('aria-label', ui.massLabel(n(state.m), n(state.A)));
    setAttrs(mass, {
      'aria-valuenow': state.A,
      'aria-valuetext': `${n(state.A)} cm`,
    });
    for (const key of ['m', 'C', 'A', 'c'] as const)
      sliders[key].set(state[key]);

    // Ruler at the right of the figure: +A, 0, -A.
    ruler.replaceChildren();
    const rx = 88;
    const tops = [state.A, 0, -state.A];
    ruler.append(
      snode(doc, 'line', {
        x1: rx,
        x2: rx,
        y1: yOf(state.A),
        y2: yOf(-state.A),
        class: 'ph-tick',
      }),
    );

    for (const value of tops) {
      ruler.append(
        snode(doc, 'line', {
          x1: rx - 4,
          x2: rx + 4,
          y1: yOf(value),
          y2: yOf(value),
          class: 'ph-tick',
        }),
      );
      const label = snode(doc, 'text', {
        class: 'ph-label ph-small',
        x: rx + 7,
        y: yOf(value) + 4,
      });
      label.textContent =
        value === 0 ? '0' : `${value > 0 ? '+' : '-'}${n(Math.abs(value))}`;
      ruler.append(label);
    }

    drawPlotFrame();
  }

  function timeStep(span: number): number {
    // At most one label per 50 px, so the labels of a narrow plot do not run together.
    const most = Math.max(
      2,
      Math.floor((plotW - margin.left - margin.right) / 50),
    );
    for (const s of [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10])
      if (span / s <= most) return s;

    return 10;
  }

  const margin = { left: 44, right: 10 };
  const xOf = (t: number, t0: number, span: number) =>
    margin.left + ((t - t0) / span) * (plotW - margin.left - margin.right);

  function drawPlotFrame(): void {
    setAttrs(plot, {
      viewBox: `0 0 ${r1(plotW)} ${HEIGHT}`,
      width: r1(plotW),
      height: HEIGHT,
    });
    setAttrs(axisT, { x: r1(plotW - margin.right) });
  }

  function draw(): void {
    // Figure.
    const uCm = sim.u * 100;
    const cx = CX;
    const massY = yOf(uCm);
    mass.setAttribute('transform', `translate(${cx} ${r1(massY)})`);
    const top = massY - MASS_H / 2;
    const coils = 11;
    const y0 = CEILING + 6;
    const y1 = top - 8;
    let d = `M${cx} ${CEILING}V${y0}`;
    for (let i = 0; i < coils; i += 1)
      d += `L${cx + (i % 2 ? -15 : 15)} ${r1(y0 + ((i + 0.5) / coils) * (y1 - y0))}`;
    d += `L${cx} ${r1(y1)}V${r1(top)}`;
    springPath.setAttribute('d', d);

    // Plot.
    const span = windowSeconds();
    const t0 = Math.max(0, sim.t - span);
    let path = '';

    for (const s of samples) {
      if (s.t < t0 - span * 0.01) continue;
      path += `${path ? 'L' : 'M'}${r1(xOf(s.t, t0, span))} ${r1(yOf(s.u * 100))}`;
    }

    const last = samples[samples.length - 1];
    if (last && last.t < sim.t)
      path += `L${r1(xOf(sim.t, t0, span))} ${r1(yOf(uCm))}`;
    curve.setAttribute('d', path);
    setAttrs(dot, { cx: r1(xOf(sim.t, t0, span)), cy: r1(yOf(uCm)) });

    // Grid: time ticks and the zero and amplitude lines.
    plotGrid.replaceChildren();
    const tick = timeStep(span);

    for (
      let t = Math.ceil(t0 / tick) * tick;
      t <= t0 + span + 1e-9;
      t += tick
    ) {
      const x = xOf(t, t0, span);
      plotGrid.append(
        snode(doc, 'line', {
          class: 'ph-gridline',
          x1: r1(x),
          x2: r1(x),
          y1: 6,
          y2: HEIGHT - 26,
        }),
      );
      const label = snode(doc, 'text', {
        class: 'ph-label ph-small',
        x: r1(x),
        y: HEIGHT - 8,
        'text-anchor': 'middle',
      });
      label.textContent = n(t, tick < 1 ? (tick < 0.25 ? 2 : 1) : 0);
      plotGrid.append(label);
    }

    for (const value of [state.A, 0, -state.A]) {
      plotGrid.append(
        snode(doc, 'line', {
          class: value === 0 ? 'ph-tick' : 'ph-gridline',
          x1: margin.left,
          x2: r1(plotW - margin.right),
          y1: r1(yOf(value)),
          y2: r1(yOf(value)),
        }),
      );
      const label = snode(doc, 'text', {
        class: 'ph-label ph-small',
        x: margin.left - 6,
        y: r1(yOf(value) + 4),
        'text-anchor': 'end',
      });
      label.textContent =
        value === 0 ? '0' : `${value > 0 ? '+' : '-'}${n(Math.abs(value))}`;
      plotGrid.append(label);
    }

    // Envelope A e^(-gamma t) while underdamped.
    if (regime(spring()) === 'under') {
      const g = decayRate(spring());
      let up = '';
      let down = '';

      for (let i = 0; i <= 60; i += 1) {
        const t = t0 + (span * i) / 60;
        const a = state.A * Math.exp(-g * t);
        const x = r1(xOf(t, t0, span));
        up += `${i ? 'L' : 'M'}${x} ${r1(yOf(a))}`;
        down += `${i ? 'L' : 'M'}${x} ${r1(yOf(-a))}`;
      }

      envelope.setAttribute('d', up + down);
    } else envelope.setAttribute('d', '');

    // The measured period: marks at the last two upward zero crossings.
    marks.replaceChildren();
    const found = meter.crossings;
    const period = meter.period;

    if (period !== undefined && found.length >= 2) {
      const [a, b] = [found[found.length - 2], found[found.length - 1]];

      if (a >= t0) {
        const [xa, xb, y] = [
          xOf(a, t0, span),
          xOf(b, t0, span),
          yOf(0) - 0.55 * state.A * PX_PER_CM,
        ];
        marks.append(
          snode(doc, 'path', {
            d: `M${r1(xa)} ${r1(yOf(0))}V${r1(y)}M${r1(xb)} ${r1(yOf(0))}V${r1(y)}M${r1(xa)} ${r1(y)}H${r1(xb)}`,
            fill: 'none',
            stroke: 'var(--ph-c3)',
            'stroke-width': 2,
          }),
        );
        const label = snode(doc, 'text', {
          class: 'ph-label',
          x: r1((xa + xb) / 2),
          y: r1(y - 6),
          'text-anchor': 'middle',
        });
        label.textContent = ui.periodMark;
        marks.append(label);
      }
    }

    // Readout.
    const live = (target: HTMLElement, text: string) => {
      if (target.textContent !== text) target.textContent = text;
    };

    live(values.time, `${n(sim.t, 2)} s`);
    live(values.u, `${n(uCm, 1)} cm`);
    live(
      values.measured,
      period === undefined ? ui.notYet : `${n(period, 2)} s`,
    );
    el.dataset.period = period === undefined ? '' : String(period);
  }

  // ---- interaction ----
  const setAmplitude = (value: number) => {
    state.A = clamp(Math.round(value * 10) / 10, LIMITS.A.min, LIMITS.A.max);
    changed();
  };

  draggable(mass, fig, {
    onStart: () => ({ x: 0, y: yOf(state.A) }),
    onMove: (at, grab) => setAmplitude((Y_EQ - (at.y + grab.y)) / PX_PER_CM),
  });
  arrowKeys(
    mass,
    (dir, event) => {
      const by = event.shiftKey ? 0.1 : 0.5;
      if (dir === 'up') setAmplitude(state.A + by);
      else if (dir === 'down') setAmplitude(state.A - by);
    },
    event => {
      if (event.key !== ' ' && event.key !== 'Enter') return false;
      setRunning(!state.running);

      return true;
    },
  );

  function resize(width: number): void {
    const next = Math.max(180, width);
    if (next === plotW) return;
    plotW = next;
    drawPlotFrame();
    draw();
  }

  restartSim();
  drawStatic();
  draw();
  setRunning(state.running);

  return {
    el,
    state,
    sim: () => ({
      time: sim.t,
      u: sim.u,
      period: meter.period,
      samples: samples.length,
    }),
    resize,
  };
}
