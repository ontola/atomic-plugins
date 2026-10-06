// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Decision Inbox Q-084): the
 * controller's `ViewState` and its `SyncHistory` (the latest sync this page
 * load, and when each collection last refreshed without error, stored on the
 * home as `moneybird-last-sync`), mapped onto one `SyncStatus`. Pure, so
 * `status.test.ts` checks every state without a DOM; `main.ts` renders the
 * result first in the view.
 *
 * What it must get right for this app:
 * - Moneybird is read-only in every state: nothing is ever sent, and a sync
 *   overwrites edits made here in the columns it imports (the policy
 *   question is atomic-plugins#97), except on a table that is not synced or
 *   whose sync is paused, where nothing is overwritten either; after an
 *   error on a table this app is not bound to, it claims no more than that
 *   nothing is sent.
 * - Each collection is reported on its own: the ones that refreshed, by
 *   count, and each one that failed, with the error, that its rows are kept,
 *   when it last refreshed, and the next step. Only when every chosen
 *   collection failed is the sync itself "failed"; then too the rows are
 *   named as kept, with the last good refresh of each collection this app
 *   knows, across page loads.
 * - A table that holds imported rows never reads "Not synced yet": before
 *   this page load's first sync, the stored last good refresh is the last
 *   sync, without counts.
 * - Skipped records (a time entry without a readable start, a mutation whose
 *   amount is not a decimal string) are listed as ignored, by name and
 *   reason; when a refresh wrote nothing but skipped something, the counts
 *   line is left out rather than read "nothing to read".
 * - A wait for Moneybird's rate limit (`throttle.ts`) shows while it lasts,
 *   counting down; a refresh that gave up on 429 names the wait as the next
 *   step. While a sync runs, the previous sync's failures are not listed:
 *   the one that is running settles them.
 */
import {
  ago,
  type IgnoredGroup,
  type Problem,
  type SyncCounts,
  type SyncStatus,
} from '../../sync-status/card.js';
import {
  COLLECTION_LABELS,
  COLLECTIONS,
  type Collection,
  type LastGood,
} from './binding.js';
import {
  describeWait,
  type Failed,
  type SyncHistory,
  type SyncRecord,
  type ViewState,
} from './controller.js';
import type { SyncSummary } from './sync.js';

export interface StatusInput {
  state: ViewState;
  /** `controller.history()`: the latest sync this page load and the last good refreshes. */
  history?: SyncHistory;
  now?: number;
}

/** Singular and plural of one collection's rows. */
export const NOUNS: Record<Collection, [string, string]> = {
  contacts: ['contact', 'contacts'],
  hours: ['time entry', 'time entries'],
  mutations: ['mutation', 'mutations'],
};

/** The plain next step after a failed refresh, by its kind. */
export const NEXT_STEP: Record<
  NonNullable<Failed['problem']> | 'other',
  string
> = {
  'rate-limited': 'Wait a few minutes, then press Sync now.',
  reauth: 'Reconnect Moneybird.',
  other: 'Press Sync now to try again.',
};

/** The write-back note in the states a sync can reach. */
export const OVERWRITES_NOTE =
  'Nothing is sent to Moneybird, and the next sync overwrites edits made here in the columns it imports.';
export const UNSYNCED_NOTE =
  'Nothing is sent to Moneybird, and this table is not synced, so nothing here is overwritten.';
export const PAUSED_NOTE =
  'Nothing is sent to Moneybird. Syncing is paused, so nothing here is overwritten until editing is allowed again.';
export const NO_RELAY_NOTE =
  'Nothing is sent to Moneybird. This Atomic Server cannot connect apps to Moneybird, so nothing is read either.';
/** After an error on a table this app is not (yet) bound to: no claim about overwriting. */
export const NOTHING_SENT_NOTE = 'Nothing is sent to Moneybird.';

const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`;

const isFailed = (result: SyncSummary | Failed): result is Failed =>
  'error' in result;

/** The chosen collections of `last` whose refresh succeeded, in catalog order. */
const succeeded = (last: SyncRecord) =>
  COLLECTIONS.filter(c => {
    const result = last.results[c];

    return result !== undefined && !isFailed(result);
  });

const failures = (last: SyncRecord) =>
  COLLECTIONS.filter(c => {
    const result = last.results[c];

    return result !== undefined && isFailed(result);
  });

const summary = (last: SyncRecord, c: Collection) =>
  last.results[c] as SyncSummary;

const times = (lastGood: LastGood, collections: readonly Collection[]) =>
  collections.flatMap(c => (lastGood[c] ? [lastGood[c]!.getTime()] : []));

function writeBackNote(state: ViewState): string {
  switch (state.kind) {
    case 'unsynced':
      return UNSYNCED_NOTE;
    case 'paused':
      return PAUSED_NOTE;
    case 'no-relay':
      return NO_RELAY_NOTE;
    case 'error':
      return state.bound ? OVERWRITES_NOTE : NOTHING_SENT_NOTE;
    default:
      return OVERWRITES_NOTE;
  }
}

/**
 * The card for `state`; `undefined` while loading, and on a table this app
 * cannot sync, where it does nothing at all.
 */
export function syncStatusFor({
  state,
  history,
  now = Date.now(),
}: StatusInput): SyncStatus | undefined {
  if (state.kind === 'loading' || state.kind === 'unsupported')
    return undefined;

  const status: SyncStatus = {
    provider: 'Moneybird',
    writeBack: 'read-only',
    writeBackNote: writeBackNote(state),
  };
  const busy = state.kind === 'syncing';

  if (state.kind === 'syncing')
    status.busy = state.waiting
      ? describeWait(state.waiting).replace(/\.$/, '…')
      : 'Syncing…';

  const problems: Problem[] = [];

  if (state.kind === 'error')
    problems.push({
      lead: 'This app hit a problem.',
      text: state.message,
      tone: 'neg',
    });

  const lastGood = history?.lastGood ?? {};
  const last = history?.last;
  const ok = last ? succeeded(last) : [];
  const bad = last ? failures(last) : [];

  if (last && ok.length) {
    status.rowNoun = ok.length === 1 ? NOUNS[ok[0]] : ['row', 'rows'];
    const counts: SyncCounts = { added: 0, updated: 0, unchanged: 0 };
    let rows = 0;
    let skipped = 0;

    for (const c of ok) {
      const s = summary(last, c);
      counts.added += s.added;
      counts.updated += s.updated;
      counts.unchanged += s.unchanged;
      rows += s.total - s.skipped;
      skipped += s.skipped;
    }

    status.rows = rows;
    status.rowsScope =
      ok.length === 1
        ? 'imported'
        : `imported: ${ok.map(c => plural(summary(last, c).total - summary(last, c).skipped, NOUNS[c])).join(', ')}`;
    // Counts that would read "nothing to read" next to skipped records are
    // left out: the ignored list says what happened.
    const wrote = counts.added + counts.updated + counts.unchanged > 0;
    status.last = {
      ok: true,
      at: last.at.getTime(),
      ...(wrote || !skipped ? { counts } : {}),
    };

    if (!busy)
      for (const c of bad) {
        const result = last.results[c] as Failed;
        const good = lastGood[c];
        problems.push({
          lead: `${COLLECTION_LABELS[c]}: refresh failed.`,
          text: `${result.error} The ${NOUNS[c][1]} imported earlier are kept${good ? `; they last refreshed ${ago(good.getTime(), now)}` : ''}. ${NEXT_STEP[result.problem ?? 'other']}`,
          tone: 'neg',
        });
      }

    const ignored: IgnoredGroup[] = [];

    for (const c of ok) {
      const byReason = new Map<string, string[]>();
      for (const row of summary(last, c).skippedRows ?? [])
        byReason.set(row.reason, [
          ...(byReason.get(row.reason) ?? []),
          row.name,
        ]);

      for (const [reason, items] of byReason)
        ignored.push({
          count: items.length,
          // The card's noun is this collection's when it is the only one;
          // otherwise "rows", so the collection is named here.
          reason:
            ok.length === 1
              ? reason
              : `(${items.length === 1 ? NOUNS[c][0] : NOUNS[c][1]}) ${reason}`,
          items,
        });
    }

    if (ignored.length) status.ignored = ignored;
  } else if (last && !busy) {
    // Every chosen collection failed: the sync itself did. The rows imported
    // earlier are kept; each collection's last good refresh this app knows
    // (this page load, or stored on the home) is named.
    const problem = bad
      .map(c => (last.results[c] as Failed).problem)
      .find(p => p !== undefined);
    const known = times(lastGood, last.collections);

    const part = (c: Collection) => {
      const result = last.results[c] as Failed;
      const good = lastGood[c];
      const when = good
        ? ` Its ${NOUNS[c][1]} last refreshed ${ago(good.getTime(), now)}.`
        : '';

      return bad.length === 1
        ? `${result.error}${when}`
        : `${COLLECTION_LABELS[c]}: ${result.error}${when}`;
    };

    status.last = {
      ok: false,
      at: last.at.getTime(),
      error: `${bad.map(part).join(' ')} The rows imported earlier are kept.`,
      nextStep: NEXT_STEP[problem ?? 'other'],
      ...(known.length ? { lastGood: Math.min(...known) } : {}),
    };
  } else {
    // Before this page load's first sync (or while it runs after a failed
    // one): the stored last good refresh, without counts, so a table that
    // holds imported rows never reads "Not synced yet".
    const known = times(lastGood, COLLECTIONS);
    if (known.length) status.last = { ok: true, at: Math.max(...known) };
  }

  if (problems.length) status.problems = problems;

  return status;
}
