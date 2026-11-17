// @wc-ignore-file
/**
 * Draws the state as plain DOM and SVG: a layered dependency graph (left to
 * right, prerequisites first), a bar of next steps and a detail panel. A
 * locked skill is dimmed, never disabled: every node is a button.
 */
import {
  layers,
  nextSteps,
  outerFringe,
  pathTo,
  stateOf,
  type SkillState,
} from '../core/index.js';
import type { State } from './controller.js';
import { FORMAT_ICON, type Strings } from './strings.js';

type Ready = Extract<State, { kind: 'ready' }>;

export interface Actions {
  select(id: string | undefined): void;
  setGoal(id: string | undefined): void;
  toggleMastery(id: string): void;
  loadStarter(): void;
  reload(): void;
  open(lesson: { content?: string; subject: string }): void;
  openRow(id: string): void;
}

const NODE_W = 156;
const NODE_H = 46;
const GAP_X = 52;
const GAP_Y = 14;
const SVG = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | boolean | undefined>;

export function h(
  doc: Document,
  tag: string,
  attrs: Attrs = {},
  ...kids: (Node | string | undefined | false)[]
): HTMLElement {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs))
    if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  for (const kid of kids) if (kid) el.append(kid);

  return el;
}

export function page(
  doc: Document,
  state: State,
  ui: Strings,
  actions: Actions,
): HTMLElement[] {
  const head = (extra?: Node) =>
    h(doc, 'header', { class: 'lb-head' }, h(doc, 'h1', {}, ui.title), extra);

  if (state.kind === 'loading')
    return [head(), h(doc, 'p', { class: 'lb-note', role: 'status' }, '...')];
  if (state.kind === 'unusable')
    return [head(), h(doc, 'p', { class: 'lb-note' }, ui.unusable)];

  if (state.kind === 'error') {
    const retry = h(
      doc,
      'button',
      { type: 'button', class: 'lb-btn' },
      ui.retry,
    );
    retry.addEventListener('click', actions.reload);

    return [
      head(),
      h(
        doc,
        'p',
        { class: 'lb-note lb-bad', role: 'alert' },
        `${ui.error}: ${state.message}`,
      ),
      retry,
    ];
  }

  const starter = h(
    doc,
    'button',
    {
      type: 'button',
      class: 'lb-btn lb-primary',
      disabled: state.busy === 'starter',
    },
    state.busy === 'starter' ? ui.starterBusy : ui.starter,
  );
  starter.addEventListener('click', actions.loadStarter);
  const out: HTMLElement[] = [head(starter), notices(doc, state, ui)];

  if (state.graph.order.length === 0)
    return [...out, h(doc, 'p', { class: 'lb-note' }, ui.empty)];

  out.push(
    nextBar(doc, state, ui, actions),
    h(
      doc,
      'div',
      { class: 'lb-main' },
      tree(doc, state, ui, actions),
      detail(doc, state, ui, actions),
    ),
  );

  return out;
}

function notices(doc: Document, state: Ready, ui: Strings): HTMLElement {
  const lines: [string, string][] = [];
  const n = state.notice;
  if (n === 'denied') lines.push(['lb-bad', ui.denied]);
  else if (n === 'failed') lines.push(['lb-bad', ui.failed]);
  else if (n) lines.push(['lb-ok', ui.loaded(n.loaded)]);
  if (state.graph.ignored.length)
    lines.push(['lb-warn', ui.cycles(state.graph.ignored.length)]);
  if (state.graph.missing.length)
    lines.push(['lb-warn', ui.missing(state.graph.missing.length)]);

  return h(
    doc,
    'div',
    { class: 'lb-notices', role: 'status' },
    ...lines.map(([c, t]) => h(doc, 'p', { class: `lb-note ${c}` }, t)),
  );
}

const nameOf = (state: Ready, id: string) =>
  state.graph.nodes.get(id)?.name ?? id;

function skillButton(
  doc: Document,
  state: Ready,
  id: string,
  actions: Actions,
  cls = 'lb-chip',
): HTMLElement {
  const b = h(
    doc,
    'button',
    { type: 'button', class: cls, 'data-id': id },
    nameOf(state, id),
  );
  b.addEventListener('click', () => actions.select(id));

  return b;
}

function nextBar(
  doc: Document,
  state: Ready,
  ui: Strings,
  actions: Actions,
): HTMLElement {
  const steps = nextSteps(state.graph, state.mastered, state.goal);
  const shown = steps.slice(0, 8);

  return h(
    doc,
    'section',
    { class: 'lb-next', 'aria-label': ui.next },
    h(
      doc,
      'strong',
      {},
      state.goal ? `${ui.nextForGoal}: ${nameOf(state, state.goal)}` : ui.next,
    ),
    shown.length
      ? undefined
      : h(doc, 'span', { class: 'lb-muted' }, ui.nothingNext),
    ...shown.map(id => skillButton(doc, state, id, actions)),
    h(doc, 'span', { class: 'lb-muted lb-legend' }, ui.legend),
  );
}

function tree(
  doc: Document,
  state: Ready,
  ui: Strings,
  actions: Actions,
): HTMLElement {
  const { graph } = state;
  const grid = layers(graph);
  const pos = new Map<string, { x: number; y: number }>();
  grid.forEach((layer, col) =>
    layer.forEach((id, row) =>
      pos.set(id, { x: col * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) }),
    ),
  );
  const width = grid.length * (NODE_W + GAP_X) - GAP_X;
  const height =
    Math.max(...grid.map(l => l.length)) * (NODE_H + GAP_Y) - GAP_Y;
  const path = new Set(
    state.goal ? pathTo(graph, state.mastered, state.goal) : [],
  );

  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'lb-edges');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');

  const edge = (from: string, to: string, cls: string) => {
    const a = pos.get(from)!;
    const b = pos.get(to)!;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    const p = doc.createElementNS(SVG, 'path');
    p.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
    p.setAttribute('class', cls);
    svg.append(p);
  };

  for (const id of graph.order) {
    const node = graph.nodes.get(id)!;
    for (const r of node.requires)
      edge(r, id, path.has(id) && path.has(r) ? 'lb-edge on-path' : 'lb-edge');
    if (state.selected === id || node.recommends.includes(state.selected ?? ''))
      for (const r of node.recommends)
        if (state.selected === id || r === state.selected)
          edge(r, id, 'lb-edge lb-rec');
  }

  const canvas = h(
    doc,
    'div',
    { class: 'lb-canvas', style: `width:${width}px;height:${height}px` },
    svg,
  );

  for (const id of graph.order) {
    const s: SkillState = stateOf(graph, state.mastered, id);
    const at = pos.get(id)!;
    const label = {
      mastered: ui.mastered,
      available: ui.available,
      locked: ui.locked,
    }[s];
    const b = h(
      doc,
      'button',
      {
        type: 'button',
        class: [
          'lb-node',
          `is-${s}`,
          path.has(id) && 'on-path',
          state.goal === id && 'is-goal',
          state.selected === id && 'is-selected',
        ]
          .filter(Boolean)
          .join(' '),
        style: `left:${at.x}px;top:${at.y}px;width:${NODE_W}px;height:${NODE_H}px`,
        'data-id': id,
        'aria-pressed': String(state.selected === id),
        'aria-label': `${nameOf(state, id)}, ${label}`,
      },
      s === 'mastered'
        ? h(doc, 'span', { class: 'lb-tick', 'aria-hidden': 'true' }, '✓')
        : undefined,
      h(doc, 'span', { class: 'lb-label' }, nameOf(state, id)),
    );
    b.addEventListener('click', () => actions.select(id));
    canvas.append(b);
  }

  return h(doc, 'div', { class: 'lb-tree', tabindex: '-1' }, canvas);
}

function detail(
  doc: Document,
  state: Ready,
  ui: Strings,
  actions: Actions,
): HTMLElement {
  const { graph } = state;
  const id = state.selected;
  const panel = h(doc, 'aside', { class: 'lb-detail', 'aria-live': 'polite' });
  const node = id ? graph.nodes.get(id) : undefined;

  if (!id || !node) {
    panel.append(h(doc, 'p', { class: 'lb-muted' }, ui.pickSkill));
    if (state.goal) panel.append(pathBlock(doc, state, ui, actions));

    return panel;
  }

  const s = stateOf(graph, state.mastered, id);
  const unmet = node.requires.filter(r => !state.mastered.has(r));
  const mine = state.lessons.filter(l =>
    l.teaches.some(t => graph.resolve(t) === id),
  );
  const master = h(
    doc,
    'button',
    { type: 'button', class: 'lb-btn lb-primary' },
    s === 'mastered' ? ui.noLonger : ui.iMaster,
  );
  master.addEventListener('click', () => actions.toggleMastery(id));
  const goal = h(
    doc,
    'button',
    {
      type: 'button',
      class: 'lb-btn',
      'aria-pressed': String(state.goal === id),
    },
    ui.pathTo,
  );
  goal.addEventListener('click', () => actions.setGoal(id));
  const row = h(doc, 'button', { type: 'button', class: 'lb-link' }, ui.open);
  row.addEventListener('click', () => actions.openRow(id));

  panel.append(
    ...([
      h(doc, 'h2', {}, node.name),
      h(
        doc,
        'p',
        { class: `lb-state is-${s}` },
        { mastered: ui.mastered, available: ui.available, locked: ui.locked }[
          s
        ],
      ),
      node.description && h(doc, 'p', {}, node.description),
      s === 'locked' && h(doc, 'p', { class: 'lb-muted' }, ui.advisory),
      unmet.length
        ? h(
            doc,
            'p',
            {},
            `${ui.firstAdvised}: `,
            ...unmet.flatMap((r, i) => [
              i ? ', ' : '',
              skillButton(doc, state, r, actions, 'lb-link'),
            ]),
          )
        : undefined,
      node.recommends.length
        ? h(
            doc,
            'p',
            { class: 'lb-muted' },
            `${ui.recommended}: `,
            ...node.recommends.flatMap((r, i) => [
              i ? ', ' : '',
              skillButton(doc, state, r, actions, 'lb-link'),
            ]),
          )
        : undefined,
      h(doc, 'div', { class: 'lb-actions' }, master, goal),
      h(doc, 'h3', {}, ui.lessons),
      mine.length
        ? h(
            doc,
            'ul',
            { class: 'lb-lessons' },
            ...mine.map(l => {
              const btn = h(
                doc,
                'button',
                { type: 'button', class: 'lb-link', disabled: !l.content },
                h(
                  doc,
                  'span',
                  { class: 'lb-icon', 'aria-hidden': 'true' },
                  FORMAT_ICON[l.format ?? ''] ?? '\u{1F4D6}',
                ),
                l.name,
              );
              btn.addEventListener('click', () => actions.open(l));

              return h(
                doc,
                'li',
                {},
                btn,
                h(
                  doc,
                  'span',
                  { class: 'lb-muted' },
                  ` ${[ui.formats[l.format ?? ''] ?? l.format, l.minutes ? `${l.minutes} ${ui.minutes}` : undefined, l.content ? undefined : ui.noMaterial].filter(Boolean).join(', ')}`,
                ),
              );
            }),
          )
        : h(doc, 'p', { class: 'lb-muted' }, ui.noLessons),
      row,
    ].filter(Boolean) as (Node | string)[]),
  );
  if (state.goal) panel.append(pathBlock(doc, state, ui, actions));

  return panel;
}

function pathBlock(
  doc: Document,
  state: Ready,
  ui: Strings,
  actions: Actions,
): HTMLElement {
  const steps = pathTo(state.graph, state.mastered, state.goal!);
  const clear = h(
    doc,
    'button',
    { type: 'button', class: 'lb-link' },
    ui.clearPath,
  );
  clear.addEventListener('click', () => actions.setGoal(undefined));

  return h(
    doc,
    'section',
    { class: 'lb-path' },
    h(
      doc,
      'h3',
      {},
      `${ui.path} ${nameOf(state, state.goal!)} (${steps.length} ${ui.steps})`,
    ),
    h(
      doc,
      'ol',
      {},
      ...steps.map(id =>
        h(doc, 'li', {}, skillButton(doc, state, id, actions, 'lb-link')),
      ),
    ),
    clear,
  );
}

/** Exposed for tests: the ids a view would suggest first. */
export const suggested = (state: Ready) =>
  nextSteps(state.graph, state.mastered, state.goal);
export const fringe = (state: Ready) =>
  outerFringe(state.graph, state.mastered);
