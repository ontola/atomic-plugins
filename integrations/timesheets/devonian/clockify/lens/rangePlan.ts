// @wc-ignore-file
/**
 * The range planner (#123 §3.2–§3.4, M4): "did not work over `[a, b)`" and
 * "worked on P over `[a, b)`" → the creates, updates and deletes that make
 * Clockify say so over exactly that range, and change nothing outside it.
 *
 * - **Did not work.** Each editable entry overlapping the range loses the
 *   overlap: inside it is deleted, sticking out on one side it is trimmed,
 *   spanning it is split (the entry keeps the left part, a copy gets the
 *   right part).
 * - **Worked on P.** Entries of other projects lose the overlap as above,
 *   except that an entry covering exactly `[a, b)`, with no P entry in the
 *   range, changes project instead (one `PUT`; `putBody` drops its task).
 *   P entries that overlap each other inside the range (duplicates) keep
 *   the earliest (by start, then id); the later ones lose the overlap. Each
 *   gap left is filled by extending a P entry that ends at its start or
 *   begins at its end (#97 answer 8), or else by a new entry.
 *
 * Refused before anything is planned: an empty range, a range ending in
 * the future, a running timer, a locked entry or one with custom field
 * values in the range, a break, holiday or time off in the range of a
 * "worked" edit (for "did not work" those entries already say so and stay),
 * an unknown or archived target project, and "worked, no project" where the
 * workspace requires a project.
 *
 * Order (§3.5): shrinks and deletes first, then extends, project changes
 * and creates, so an interrupted plan leaves a gap, never a new overlap.
 * Pure: no store, no network, no clock but `context.now`. Exact instants
 * (epoch ms): the caller snaps a range typed by a person to minutes, and
 * passes a conflict's span as it is.
 */
import {
  entryValues,
  NO_DESCRIPTION,
  type ClockifyTimeEntry,
  type EntryValues,
  type WriteContext,
} from './writeBack.js';

export type RangeTarget =
  | { kind: 'worked'; projectId: string | null }
  | { kind: 'didNotWork' };

export interface RangeEdit {
  /** `[from, to)`, epoch ms. */
  from: number;
  to: number;
  target: RangeTarget;
}

/** `shrink` steps go first: they only take time away. */
export type PlanPhase = 'shrink' | 'grow';

export type PlanStep =
  | { op: 'delete'; entryId: string; phase: 'shrink' }
  | {
      op: 'update';
      entryId: string;
      /** The entry's values now, and what they become. */
      current: EntryValues;
      desired: EntryValues;
      phase: PlanPhase;
    }
  | {
      op: 'create';
      values: EntryValues;
      /** The entry this is the right-hand part of (a split): its
       * description, task and tags are copied. */
      copyOf?: string;
      phase: 'grow';
    };

export interface RangePlan {
  steps: PlanStep[];
  /** Why the edit cannot be made; non-empty means `steps` is empty. */
  refused: string[];
}

export interface PlanContext extends WriteContext {
  /** `billable` for a new entry of this project (#123 §7.1). */
  billableDefault?: (projectId: string | null) => boolean;
}

interface Span {
  from: number;
  to: number;
}

const instant = (value: unknown) =>
  typeof value === 'string' ? Date.parse(value) : NaN;

/** `span` minus `cut`: zero, one or two spans. */
function subtract(span: Span, cut: Span): Span[] {
  if (cut.to <= span.from || cut.from >= span.to) return [span];

  return [
    ...(cut.from > span.from ? [{ from: span.from, to: cut.from }] : []),
    ...(cut.to < span.to ? [{ from: cut.to, to: span.to }] : []),
  ];
}

const overlap = (a: Span, b: Span): Span | undefined => {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);

  return from < to ? { from, to } : undefined;
};

const byStart = (a: { start: number; id: string }, b: typeof a) =>
  a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const projectNameOf = (context: PlanContext, id: string | null) =>
  (id && context.projects.find(p => p.id === id)?.name) || null;

/** Why this edit cannot be planned at all, as sentences for the view. */
export function rangeRefusals(
  entries: ClockifyTimeEntry[],
  edit: RangeEdit,
  context: PlanContext,
): string[] {
  const reasons: string[] = [];
  const range = { from: edit.from, to: edit.to };

  if (!(edit.from < edit.to)) reasons.push('The range is empty.');
  if (edit.to > context.now) reasons.push('The range ends in the future.');

  if (edit.target.kind === 'worked') {
    const { projectId } = edit.target;

    if (projectId === null) {
      if (context.forceProjects)
        reasons.push('This workspace requires a project on every entry.');
    } else {
      const project = context.projects.find(p => p.id === projectId);
      if (!project)
        reasons.push('The project is not one of this workspace’s projects.');
      else if (project.archived === true)
        reasons.push(`The project ${project.name} is archived.`);
    }
  }

  const seen = new Set<string>();

  const once = (reason: string) => {
    if (!seen.has(reason)) reasons.push(reason);
    seen.add(reason);
  };

  for (const entry of entries) {
    const start = instant(entry.timeInterval?.start);
    const end = entry.timeInterval?.end
      ? instant(entry.timeInterval.end)
      : Math.max(context.now, start);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!overlap({ from: start, to: end }, range)) continue;
    const type = entry.type ?? 'REGULAR';

    if (!entry.timeInterval?.end)
      once('A running timer is in this range. Stop it in Clockify first.');
    else if (type !== 'REGULAR') {
      if (edit.target.kind === 'worked')
        once(
          `A ${type.toLowerCase().replace('_', ' ')} entry is in this range; it can only be changed in Clockify.`,
        );
    } else if (entry.isLocked === true)
      once('A locked entry is in this range.');
    else if (
      Array.isArray(entry.customFieldValues) &&
      entry.customFieldValues.length
    )
      once(
        'An entry with custom field values is in this range; this app cannot write those back yet.',
      );
  }

  return reasons;
}

/**
 * The plan for `edit` over `entries`: this user's live entries as Clockify
 * last returned them (every entry that could overlap the range).
 */
export function planRange(
  entries: ClockifyTimeEntry[],
  edit: RangeEdit,
  context: PlanContext,
): RangePlan {
  const refused = rangeRefusals(entries, edit, context);
  if (refused.length) return { steps: [], refused };
  const range: Span = { from: edit.from, to: edit.to };
  const names = (id: string) => projectNameOf(context, id) ?? undefined;

  const target =
    edit.target.kind === 'worked' ? edit.target.projectId : undefined;
  const editable = (entry: ClockifyTimeEntry) =>
    entry.isLocked !== true &&
    !(Array.isArray(entry.customFieldValues) && entry.customFieldValues.length);

  // Completed REGULAR entries in the range (the only editable ones left
  // there), and target-project entries that touch it, to extend.
  const touched = entries
    .map(entry => ({ entry, values: entryValues(entry, names) }))
    .filter(
      (e): e is { entry: ClockifyTimeEntry; values: EntryValues } =>
        !!e.values &&
        editable(e.entry) &&
        (!!overlap({ from: e.values.start, to: e.values.end }, range) ||
          (e.values.projectId === target &&
            (e.values.end === range.from || e.values.start === range.to))),
    )
    .map(e => ({ ...e, id: e.entry.id, start: e.values.start }))
    .sort(byStart);

  const pieces = new Map<string, Span[]>(
    touched.map(t => [t.id, [{ from: t.values.start, to: t.values.end }]]),
  );
  const projectOf = new Map<string, string | null>(
    touched.map(t => [t.id, t.values.projectId]),
  );
  const cut = (id: string, span: Span) =>
    pieces.set(
      id,
      pieces.get(id)!.flatMap(p => subtract(p, span)),
    );
  const creates: Span[] = [];

  if (edit.target.kind === 'didNotWork')
    for (const t of touched) cut(t.id, range);
  else {
    const same = touched.filter(t => t.values.projectId === target);
    const others = touched.filter(t => t.values.projectId !== target);
    const exact = same.some(
      t => !!overlap({ from: t.values.start, to: t.values.end }, range),
    )
      ? undefined
      : others.find(
          t => t.values.start === range.from && t.values.end === range.to,
        );

    if (exact) projectOf.set(exact.id, edit.target.projectId);
    for (const t of others) if (t !== exact) cut(t.id, range);

    // Duplicates: the earliest P entry keeps the time, later ones give up
    // what an earlier one already covers inside the range.
    const kept: Span[] = exact ? [range] : [];

    for (const t of same) {
      for (const k of kept) {
        const both = overlap({ from: t.values.start, to: t.values.end }, k);
        if (both) cut(t.id, both);
      }

      for (const p of pieces.get(t.id)!) {
        const inside = overlap(p, range);
        if (inside) kept.push(inside);
      }
    }

    // The gaps in the range that no P entry covers now.
    let gaps: Span[] = [range];
    for (const k of kept) gaps = gaps.flatMap(g => subtract(g, k));
    const targetPieces = () =>
      touched
        .filter(t => projectOf.get(t.id) === target)
        .flatMap(t => pieces.get(t.id)!);

    for (const gap of gaps) {
      const all = targetPieces();
      const before = all.find(p => p.to === gap.from);
      const after = all.find(p => p.from === gap.to);

      if (before) before.to = gap.to;
      else if (after) after.from = gap.from;
      else creates.push(gap);
    }
  }

  const steps: PlanStep[] = [];

  for (const t of touched) {
    const left = [...pieces.get(t.id)!].sort((a, b) => a.from - b.from);
    const projectId = projectOf.get(t.id) ?? null;
    const changedProject = projectId !== t.values.projectId;
    const project = changedProject
      ? projectNameOf(context, projectId)
      : t.values.project;

    if (!left.length) {
      steps.push({ op: 'delete', entryId: t.id, phase: 'shrink' });
      continue;
    }

    const [first, ...rest] = left;
    const desired: EntryValues = {
      ...t.values,
      start: first.from,
      end: first.to,
      projectId,
      project,
    };

    if (
      desired.start !== t.values.start ||
      desired.end !== t.values.end ||
      changedProject
    )
      steps.push({
        op: 'update',
        entryId: t.id,
        current: t.values,
        desired,
        phase:
          !changedProject &&
          desired.start >= t.values.start &&
          desired.end <= t.values.end
            ? 'shrink'
            : 'grow',
      });

    for (const piece of rest)
      steps.push({
        op: 'create',
        values: { ...desired, start: piece.from, end: piece.to },
        copyOf: t.id,
        phase: 'grow',
      });
  }

  if (edit.target.kind === 'worked') {
    const { projectId } = edit.target;

    for (const gap of creates)
      steps.push({
        op: 'create',
        values: {
          name: NO_DESCRIPTION,
          start: gap.from,
          end: gap.to,
          billable: context.billableDefault?.(projectId) ?? false,
          projectId,
          project: projectNameOf(context, projectId),
        },
        phase: 'grow',
      });
  }

  return { steps: orderSteps(steps), refused: [] };
}

const RANK = { delete: 0, update: 1, create: 2 } as const;
const stepStart = (s: PlanStep) =>
  s.op === 'create' ? s.values.start : s.op === 'update' ? s.desired.start : 0;

/** Shrinks and deletes, then grows; by kind, then start, within each. */
export const orderSteps = (steps: PlanStep[]) =>
  [...steps].sort(
    (a, b) =>
      (a.phase === b.phase ? 0 : a.phase === 'shrink' ? -1 : 1) ||
      RANK[a.op] - RANK[b.op] ||
      stepStart(a) - stepStart(b),
  );
