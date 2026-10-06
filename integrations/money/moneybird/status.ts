// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Decision Inbox Q-084): the
 * controller's `ViewState` and its latest `SyncRecord`, mapped onto one
 * `SyncStatus`. Pure, so `status.test.ts` checks every state without a DOM;
 * `main.ts` renders the result first in the view.
 *
 * What it must get right for this app:
 * - Moneybird is read-only in every state: nothing is ever sent, and a sync
 *   overwrites edits made here in the columns it imports (the policy
 *   question is atomic-plugins#97), except on a table that is not synced or
 *   whose sync is paused, where nothing is overwritten either.
 * - Each collection is reported on its own: the ones that refreshed, by
 *   count, and each one that failed, with the error, that its rows are kept,
 *   when it last refreshed, and the next step. Only when every chosen
 *   collection failed is the sync itself "failed", with the last good one
 *   named.
 * - Skipped records (a time entry without a readable start, a mutation whose
 *   amount is not a decimal string) are listed as ignored, by name and
 *   reason.
 * - A wait for Moneybird's rate limit (`throttle.ts`) shows while it lasts;
 *   a refresh that gave up on 429 names the wait as the next step.
 */
import {
  ago,
  type IgnoredGroup,
  type Problem,
  type SyncCounts,
  type SyncStatus,
} from '../../sync-status/card.js';
import { COLLECTION_LABELS, COLLECTIONS, type Collection } from './binding.js';
import {
  describeWait,
  type Failed,
  type SyncRecord,
  type ViewState,
} from './controller.js';
import type { SyncSummary } from './sync.js';

export interface StatusInput {
  state: ViewState;
  /** The latest sync this page load (`controller.last()`). */
  last?: SyncRecord;
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

/**
 * The card for `state`; `undefined` while loading, and on a table this app
 * cannot sync, where it does nothing at all.
 */
export function syncStatusFor({
  state,
  last,
  now = Date.now(),
}: StatusInput): SyncStatus | undefined {
  if (state.kind === 'loading' || state.kind === 'unsupported')
    return undefined;

  const status: SyncStatus = {
    provider: 'Moneybird',
    writeBack: 'read-only',
    writeBackNote:
      state.kind === 'unsynced'
        ? UNSYNCED_NOTE
        : state.kind === 'paused'
          ? PAUSED_NOTE
          : state.kind === 'no-relay'
            ? NO_RELAY_NOTE
            : OVERWRITES_NOTE,
  };

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

  if (last) {
    const ok = succeeded(last);
    const bad = failures(last);
    const noun: [string, string] =
      ok.length === 1 ? NOUNS[ok[0]] : ['row', 'rows'];
    status.rowNoun = noun;

    if (ok.length) {
      const counts: SyncCounts = { added: 0, updated: 0, unchanged: 0 };
      let rows = 0;

      for (const c of ok) {
        const s = summary(last, c);
        counts.added += s.added;
        counts.updated += s.updated;
        counts.unchanged += s.unchanged;
        rows += s.total - s.skipped;
      }

      status.rows = rows;
      status.rowsScope =
        ok.length === 1
          ? 'imported'
          : `imported: ${ok.map(c => plural(summary(last, c).total - summary(last, c).skipped, NOUNS[c])).join(', ')}`;
      status.last = { ok: true, at: last.at.getTime(), counts };
    } else {
      // Every chosen collection failed: the sync itself did.
      const problem = bad
        .map(c => (last.results[c] as Failed).problem)
        .find(p => p !== undefined);
      const goods = last.collections.map(c => last.lastGood[c]);
      const lastGood = goods.every(d => d !== undefined)
        ? Math.min(...goods.map(d => d!.getTime()))
        : undefined;
      status.last = {
        ok: false,
        at: last.at.getTime(),
        error:
          bad.length === 1
            ? (last.results[bad[0]] as Failed).error
            : bad
                .map(
                  c =>
                    `${COLLECTION_LABELS[c]}: ${(last.results[c] as Failed).error}`,
                )
                .join(' '),
        nextStep: NEXT_STEP[problem ?? 'other'],
        ...(lastGood !== undefined ? { lastGood } : {}),
      };
    }

    if (ok.length)
      for (const c of bad) {
        const result = last.results[c] as Failed;
        const good = last.lastGood[c];
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
  }

  if (problems.length) status.problems = problems;

  return status;
}
