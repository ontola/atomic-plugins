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
import type { Lesson } from './adapter.js';
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
  link(lesson: string, target: string): void;
}

const NODE_W = 144;
const NODE_H = 44;
const GAP_X = 16;
const GAP_Y = 12;
const HEAD_H = 26;
/** Below this the tree scrolls sideways instead of shrinking further. */
const MIN_SCALE = 0.8;
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

const mark = (doc: Document, s: SkillState) =>
  h(doc, 'span', { class: `lb-mark is-${s}`, 'aria-hidden': 'true' });

const stateLabel = (ui: Strings, s: SkillState) =>
  ({ mastered: ui.mastered, available: ui.available, locked: ui.locked })[s];

export function page(
  doc: Document,
  state: State,
  ui: Strings,
  actions: Actions,
  /** The width the tree may use, in px; 0 when unknown (no layout yet). */
  width = 0,
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

  const total = state.graph.order.length;

  if (total === 0) {
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

    return [
      head(),
      notices(doc, state, ui),
      h(
        doc,
        'section',
        { class: 'lb-card lb-empty' },
        h(doc, 'h2', {}, ui.emptyTitle),
        h(doc, 'p', { class: 'lb-muted' }, ui.empty),
        starter,
      ),
    ];
  }

  const done = state.graph.order.filter((id) => state.mastered.has(id)).length;

  return [
    head(
      h(
        doc,
        'div',
        { class: 'lb-progress', role: 'status' },
        h(doc, 'span', {}, ui.progress(done, total)),
        h(
          doc,
          'span',
          { class: 'lb-bar', 'aria-hidden': 'true' },
          h(doc, 'span', { style: `width:${(100 * done) / total}%` }),
        ),
      ),
    ),
    notices(doc, state, ui),
    nextBar(doc, state, ui, actions),
    tree(doc, state, ui, actions, width),
    detail(doc, state, ui, actions),
  ];
}

function notices(doc: Document, state: Ready, ui: Strings): HTMLElement {
  const lines: [string, string][] = [];
  const n = state.notice;
  if (n === 'denied') lines.push(['lb-bad', ui.denied]);
  else if (n === 'failed') lines.push(['lb-bad', ui.failed]);
  else if (n === 'badLink') lines.push(['lb-bad', ui.badLink]);
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
    mark(doc, stateOf(state.graph, state.mastered, id)),
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
    ...shown.map((id) => skillButton(doc, state, id, actions)),
  );
}

function tree(
  doc: Document,
  state: Ready,
  ui: Strings,
  actions: Actions,
  avail: number,
): HTMLElement {
  const { graph } = state;
  const grid = layers(graph);
  const pos = new Map<string, { x: number; y: number }>();
  grid.forEach((layer, col) =>
    layer.forEach((id, row) =>
      pos.set(id, {
        x: col * (NODE_W + GAP_X) + GAP_X / 2,
        y: HEAD_H + row * (NODE_H + GAP_Y),
      }),
    ),
  );
  const width = grid.length * (NODE_W + GAP_X);
  const height =
    HEAD_H + Math.max(...grid.map((l) => l.length)) * (NODE_H + GAP_Y);
  // Fit the width when it is not much smaller than the tree; otherwise keep
  // text readable and let the tree scroll sideways.
  const scale = avail > 0 ? Math.max(MIN_SCALE, Math.min(1, avail / width)) : 1;
  const path = new Set(
    state.goal ? pathTo(graph, state.mastered, state.goal) : [],
  );
  const sel = state.selected;

  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'lb-edges');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');

  const edges: [string, string, string][] = [];

  for (const id of graph.order) {
    const node = graph.nodes.get(id)!;
    for (const r of node.requires)
      edges.push([
        r,
        id,
        path.has(id) && path.has(r)
          ? 'on-path'
          : r === sel || id === sel
            ? 'is-near'
            : '',
      ]);
    for (const r of node.recommends)
      if (r === sel || id === sel) edges.push([r, id, 'is-near lb-rec']);
  }

  // Faint edges first so the highlighted ones are drawn on top.
  const rank = (c: string) => (c.includes('on-path') ? 2 : c ? 1 : 0);
  edges.sort((a, b) => rank(a[2]) - rank(b[2]));

  for (const [from, to, cls] of edges) {
    const a = pos.get(from)!;
    const b = pos.get(to)!;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    const p = doc.createElementNS(SVG, 'path');
    p.setAttribute('d', `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`);
    p.setAttribute('class', `lb-edge ${cls}`.trim());
    svg.append(p);
  }

  const canvas = h(
    doc,
    'div',
    {
      class: 'lb-canvas',
      style: `width:${width}px;height:${height}px;transform:scale(${scale})`,
    },
    ...grid.map((_, col) =>
      h(
        doc,
        'div',
        {
          class: `lb-band${col % 2 ? ' is-odd' : ''}`,
          'aria-hidden': 'true',
          style: `left:${col * (NODE_W + GAP_X)}px;width:${NODE_W + GAP_X}px`,
        },
        h(doc, 'span', {}, ui.level(col + 1)),
      ),
    ),
    svg,
  );

  for (const id of graph.order) {
    const s: SkillState = stateOf(graph, state.mastered, id);
    const at = pos.get(id)!;
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
          sel === id && 'is-selected',
        ]
          .filter(Boolean)
          .join(' '),
        style: `left:${at.x}px;top:${at.y}px;width:${NODE_W}px;height:${NODE_H}px`,
        'data-id': id,
        title: nameOf(state, id),
        'aria-pressed': String(sel === id),
        'aria-label': `${nameOf(state, id)}, ${stateLabel(ui, s)}`,
      },
      mark(doc, s),
      h(doc, 'span', { class: 'lb-label' }, nameOf(state, id)),
    );
    b.addEventListener('click', () => actions.select(id));
    canvas.append(b);
  }

  const legend = h(
    doc,
    'div',
    { class: 'lb-legend' },
    ...(['mastered', 'available', 'locked'] as const).map((s) =>
      h(doc, 'span', {}, mark(doc, s), stateLabel(ui, s)),
    ),
    h(doc, 'span', { class: 'lb-hint' }, ui.scrollHint),
  );

  return h(
    doc,
    'section',
    { class: 'lb-card lb-treecard', 'aria-label': ui.title },
    h(
      doc,
      'div',
      { class: 'lb-tree', tabindex: '-1' },
      h(
        doc,
        'div',
        {
          class: 'lb-fit',
          style: `width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px`,
        },
        canvas,
      ),
    ),
    legend,
  );
}

function lessonRow(
  doc: Document,
  ui: Strings,
  actions: Actions,
  l: Lesson,
): HTMLElement {
  const interactive = l.format === 'interactive';
  const meta = [
    ui.formats[l.format ?? ''] ?? l.format,
    l.minutes ? `${l.minutes} ${ui.minutes}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const body = h(
    doc,
    'span',
    { class: 'lb-lbody' },
    h(doc, 'span', { class: 'lb-lname' }, l.name),
    h(doc, 'span', { class: 'lb-muted lb-lmeta' }, meta),
  );
  const icon = h(
    doc,
    'span',
    { class: 'lb-icon', 'aria-hidden': 'true' },
    FORMAT_ICON[l.format ?? ''] ?? '\u{1F4D6}',
  );
  const li = h(doc, 'li', { class: 'lb-lesson' }, icon, body);

  if (l.content) {
    const go = h(
      doc,
      'button',
      {
        type: 'button',
        class: `lb-btn${interactive ? ' lb-primary' : ''}`,
        'aria-label': `${interactive ? ui.start : ui.openLesson}: ${l.name}`,
      },
      interactive ? ui.start : ui.openLesson,
    );
    go.addEventListener('click', () => actions.open(l));
    li.append(go);

    return li;
  }

  body.append(
    h(
      doc,
      'span',
      { class: 'lb-muted lb-lmeta' },
      interactive ? ui.notLinked : ui.noMaterial,
    ),
  );

  if (interactive) {
    const input = h(doc, 'input', {
      type: 'text',
      class: 'lb-input',
      placeholder: ui.linkPlaceholder,
      'aria-label': `${ui.linkLabel}: ${l.name}`,
    }) as HTMLInputElement;
    const submit = h(
      doc,
      'button',
      { type: 'button', class: 'lb-btn' },
      ui.link,
    );
    // Not a <form>: the host's frame is sandboxed without allow-forms.
    const go = () => actions.link(l.subject, input.value);
    submit.addEventListener('click', go);
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') go();
    });
    const form = h(doc, 'div', { class: 'lb-linkform' }, input, submit);
    li.append(form);
  }

  return li;
}

function detail(
  doc: Document,
  state: Ready,
  ui: Strings,
  actions: Actions,
): HTMLElement {
  const { graph } = state;
  const id = state.selected;
  const panel = h(doc, 'aside', {
    class: 'lb-card lb-detail',
    'aria-live': 'polite',
  });
  const node = id ? graph.nodes.get(id) : undefined;

  if (!id || !node) {
    panel.append(h(doc, 'p', { class: 'lb-muted' }, ui.pickSkill));
    if (state.goal) panel.append(pathBlock(doc, state, ui, actions));

    return panel;
  }

  const s = stateOf(graph, state.mastered, id);
  const unmet = node.requires.filter((r) => !state.mastered.has(r));
  const mine = state.lessons.filter((l) =>
    l.teaches.some((t) => graph.resolve(t) === id),
  );
  const mastered = s === 'mastered';
  const master = h(
    doc,
    'button',
    { type: 'button', class: `lb-btn${mastered ? '' : ' lb-primary'}` },
    mastered ? ui.noLonger : ui.iMaster,
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
  const row = h(
    doc,
    'button',
    { type: 'button', class: 'lb-btn lb-ghost' },
    ui.open,
  );
  row.addEventListener('click', () => actions.openRow(id));
  const refs = (ids: string[]) =>
    ids.flatMap((r, i) => [i ? ' ' : '', skillButton(doc, state, r, actions)]);

  panel.append(
    h(
      doc,
      'div',
      { class: 'lb-info' },
      h(
        doc,
        'div',
        { class: 'lb-dhead' },
        h(doc, 'h2', {}, node.name),
        h(
          doc,
          'span',
          { class: `lb-state is-${s}` },
          mark(doc, s),
          stateLabel(ui, s),
        ),
      ),
      node.description && h(doc, 'p', { class: 'lb-desc' }, node.description),
      s === 'locked' && h(doc, 'p', { class: 'lb-advice' }, ui.advisory),
      unmet.length
        ? h(
            doc,
            'p',
            { class: 'lb-refs' },
            `${ui.firstAdvised}: `,
            ...refs(unmet),
          )
        : undefined,
      node.recommends.length
        ? h(
            doc,
            'p',
            { class: 'lb-refs lb-muted' },
            `${ui.recommended}: `,
            ...refs(node.recommends),
          )
        : undefined,
      h(doc, 'div', { class: 'lb-actions' }, master, goal, row),
    ),
    h(
      doc,
      'div',
      { class: 'lb-more' },
      h(doc, 'h3', {}, ui.lessons),
      mine.length
        ? h(
            doc,
            'ul',
            { class: 'lb-lessons' },
            ...mine.map((l) => lessonRow(doc, ui, actions, l)),
          )
        : h(doc, 'p', { class: 'lb-muted' }, ui.noLessons),
      state.goal ? pathBlock(doc, state, ui, actions) : undefined,
    ),
  );

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
    { type: 'button', class: 'lb-btn lb-ghost' },
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
      ...steps.map((id) =>
        h(doc, 'li', {}, skillButton(doc, state, id, actions, 'lb-chip')),
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
