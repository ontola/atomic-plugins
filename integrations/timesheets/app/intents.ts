// @wc-ignore-file
/**
 * Range edits as intents (#97 §5.2, #177 §4.5, #123 M5).
 *
 * A range edit ("worked on P", "worked, no project" or "did not work" over
 * `[from, to)`) or a conflict's resolution is staged on rows (M4: bookkeeping
 * on the row, #177 Q4) and, since M5, also recorded as one **intent**
 * resource under the observation log's head: what was asked, over which
 * span, the rows it staged, and the earlier intents it replaces.
 *
 * - **A grow-only set.** An intent is written once and never edited, by
 *   anyone; each device only adds its own. So two devices that edit while
 *   apart never overwrite each other's intents, even where their row edits
 *   do (a row holds one value per field: the later save wins).
 * - **Status is derived, never stored.** An intent is _superseded_ when a
 *   later one names it in `supersedes`; it is _open_ while one of its rows
 *   still holds a change to send. Sent or discarded, it closes by itself.
 * - **Supersession** (S22). A range edit made on a copy of the app that can
 *   see open intents overlapping its range replaces them: their staged
 *   changes are put back first, then the new plan is staged. An open intent
 *   that reaches outside the new range is not cut in two: the edit is
 *   refused until it is sent or discarded.
 * - **Concurrent intents** (S21). Two open intents that overlap, where
 *   neither replaces the other, were made on copies that could not see each
 *   other. Equal targets agree. Different targets are a conflict ("your
 *   edits disagree"), shown on every device that holds both, and none of
 *   their changes is sent until a resolution (a range edit over the whole
 *   span, which replaces both) settles it. No clock decides between them
 *   (#97 §5.2).
 *
 * Found with `query` on `clockify-intent-of` (the head's subject), plus the
 * ones this copy wrote, in case the host's query does not list them yet.
 */
import type {
  RangeTarget,
  TimeLabel,
} from '../devonian/clockify/lens/index.js';
import { NAME } from './ontology.js';
import type { CompleteSchema } from './schema.js';
import type { PluginStore } from './store.js';

export interface RangeIntent {
  v: 1;
  /** Unique across devices. */
  id: string;
  /** The app instance that made it (`frame-…`, new on every page load). */
  device: string;
  /** ISO 8601. Shown, never used to decide. */
  createdAt: string;
  /** `[from, to)`, epoch ms. */
  from: number;
  to: number;
  target: RangeTarget;
  /** The rows it staged: entries' rows it edited or marked for deletion,
   * and the new rows it made. */
  rows: string[];
  /** Ids of the open intents it replaces. */
  supersedes: string[];
}

export interface StoredIntent extends RangeIntent {
  subject: string;
}

/** Two or more open intents that disagree over a span (S21). */
export interface IntentConflict {
  /** The union of their spans. */
  from: number;
  to: number;
  intents: StoredIntent[];
}

const parse = (text: unknown): RangeIntent | undefined => {
  if (typeof text !== 'string' || !text) return undefined;

  try {
    const intent = JSON.parse(text) as RangeIntent;

    return typeof intent?.id === 'string' &&
      typeof intent.from === 'number' &&
      typeof intent.to === 'number' &&
      Array.isArray(intent.rows) &&
      Array.isArray(intent.supersedes)
      ? intent
      : undefined;
  } catch {
    return undefined;
  }
};

const byAge = (a: StoredIntent, b: StoredIntent) =>
  a.createdAt < b.createdAt
    ? -1
    : a.createdAt > b.createdAt
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

async function headOf(store: PluginStore, schema: CompleteSchema) {
  const home = await store.getResource(schema.home);
  const head = home.get(schema.log.log);

  return typeof head === 'string' && head ? head : undefined;
}

/** Every intent stored for this app's log, oldest first. */
export async function loadIntents(
  store: PluginStore,
  schema: CompleteSchema,
  known: Iterable<string> = [],
): Promise<StoredIntent[]> {
  const head = await headOf(store, schema);
  if (!head) return [];
  const subjects = new Set([
    ...(await store.query({ property: schema.log.intentOf, value: head })),
    ...known,
  ]);
  const out: StoredIntent[] = [];

  for (const subject of subjects) {
    let intent: RangeIntent | undefined;

    try {
      intent = parse((await store.getResource(subject)).get(schema.log.intent));
    } catch {
      continue;
    }

    if (intent) out.push({ ...intent, subject });
  }

  return out.sort(byAge);
}

/** Stores a new intent under the log head. Returns its subject. */
export async function recordIntent(
  store: PluginStore,
  schema: CompleteSchema,
  intent: RangeIntent,
): Promise<string> {
  const head = await headOf(store, schema);
  if (!head) throw new Error('Sync first: there is no observation log yet.');
  const created = await store.newResource({
    parent: head,
    propVals: {
      [NAME]: `Clockify range edit ${intent.createdAt}`,
      [schema.log.intent]: JSON.stringify(intent),
      [schema.log.intentOf]: head,
    },
  });

  return created.subject;
}

const overlaps = (
  a: { from: number; to: number },
  b: { from: number; to: number },
) => a.from < b.to && b.from < a.to;

const sameTarget = (a: RangeTarget, b: RangeTarget) =>
  a.kind === b.kind &&
  (a.kind === 'didNotWork' ||
    (b.kind === 'worked' && a.projectId === b.projectId));

/**
 * The intents still in play: not replaced by another, and with at least one
 * of their rows holding a change to send (`pending`: the subjects of the
 * "Changes to send" list).
 */
export function openIntents(
  intents: StoredIntent[],
  pending: ReadonlySet<string>,
): StoredIntent[] {
  const replaced = new Set(intents.flatMap(i => i.supersedes));

  return intents.filter(
    i => !replaced.has(i.id) && i.rows.some(row => pending.has(row)),
  );
}

/**
 * Open intents that disagree (S21): overlapping, with different targets.
 * Two open intents never replace one another (a replaced one is not open),
 * so overlapping ones were made apart. Overlapping disagreements are
 * grouped, so one conflict covers a chain of them.
 */
export function intentConflicts(open: StoredIntent[]): IntentConflict[] {
  const group = open.map((_, i) => i);
  const find = (i: number): number =>
    group[i] === i ? i : (group[i] = find(group[i]));
  const disagree = new Set<number>();

  for (let i = 0; i < open.length; i++)
    for (let j = i + 1; j < open.length; j++)
      if (
        overlaps(open[i], open[j]) &&
        !sameTarget(open[i].target, open[j].target)
      ) {
        group[find(i)] = find(j);
        disagree.add(i).add(j);
      }

  const clusters = new Map<number, StoredIntent[]>();

  for (const i of disagree) {
    const root = find(i);
    clusters.set(root, [...(clusters.get(root) ?? []), open[i]]);
  }

  return [...clusters.values()]
    .map(intents => {
      const sorted = [...intents].sort(byAge);

      return {
        from: Math.min(...sorted.map(i => i.from)),
        to: Math.max(...sorted.map(i => i.to)),
        intents: sorted,
      };
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

/** The rows whose changes wait for a conflict's resolution. */
export function heldRows(conflicts: IntentConflict[]): Set<string> {
  return new Set(conflicts.flatMap(c => c.intents.flatMap(i => i.rows)));
}

/** What a new range edit over `span` would replace: the open intents it
 * overlaps. `outside` are those reaching beyond it (the edit is refused). */
export function toSupersede(
  open: StoredIntent[],
  span: { from: number; to: number },
): { replace: StoredIntent[]; outside: StoredIntent[] } {
  const replace = open.filter(i => overlaps(i, span));

  return {
    replace,
    outside: replace.filter(i => i.from < span.from || i.to > span.to),
  };
}

export const targetLabel = (target: RangeTarget): TimeLabel =>
  target.kind === 'worked'
    ? { kind: 'worked', projectId: target.projectId }
    : { kind: 'didNotWork' };
