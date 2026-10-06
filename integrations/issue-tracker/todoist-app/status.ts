// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Decision Inbox Q-084): the
 * controller's `ViewState` mapped onto one `SyncStatus`. Pure, so
 * `status.test.ts` checks every state without a DOM; `main.ts` renders the
 * result first in the view.
 *
 * What it must get right for this app: it is read-only in every state
 * (nothing is ever sent to Todoist), and a local edit to an imported column
 * is overwritten at the next sync, so the card says both, always. The #99
 * disappearance checks (completed, deleted, unavailable, unconfirmed) and
 * the rows the pass leaves alone (made here, incomplete) are listed as
 * groups with counts and names. A failed sync names the last complete read
 * (`todoist-last-sync` on the App), so a gap is never hidden; a rate limit
 * says whether the app retries by itself and when.
 */
import {
  ago,
  type IgnoredGroup,
  type Problem,
  type SyncStatus,
} from '../../sync-status/card.js';
import { rateLimitWords, type ViewState } from './controller.js';
import { MAX_PAGES } from './read.js';
import type { TaskRow } from './sync.js';

export interface StatusInput {
  state: ViewState;
  /** For the rate-limit time ("retrying at 14:05"); the browser's by default. */
  locale?: string;
  timeZone?: string;
  /** Where the host can show a row: the "Open row" action on one incomplete row. */
  onOpenRow?: (subject: string) => void;
  /** The clock, for "ago" in the card's own text; `Date.now()` by default. */
  now?: number;
}

/**
 * Appended to "Read-only: edits here stay in Atomic." wherever this app
 * syncs: every state but the two below.
 */
export const WRITE_BACK_NOTE =
  'Nothing is sent to Todoist. An edit here to an imported column (Name, Status, Description, Due date) is overwritten at the next sync; a row added here is kept.';
/** `no-relay`: no sync can run on this host. */
export const NO_RELAY_NOTE =
  'Nothing is sent to Todoist, and nothing is read or overwritten until this Atomic Server can connect apps to it.';

/** The plain next step after a failed sync, by Todoist's answer. */
export function nextStep(status: number | undefined): string {
  if (status === 401 || status === 403) return 'Reconnect Todoist.';
  if (status !== undefined && status >= 500)
    return 'Todoist had a problem; try again in a moment.';
  if (status === undefined) return 'Check your connection, then try again.';

  return 'Try again.';
}

const is = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The rows the pass left out or settled, grouped, in the table's current state. */
export function ignoredGroups(
  tasks: TaskRow[],
  onOpenRow?: (subject: string) => void,
): IgnoredGroup[] {
  const out: IgnoredGroup[] = [];
  const by = (test: (t: TaskRow) => boolean) => tasks.filter(test);
  const names = (rows: TaskRow[]) => rows.map(r => r.name || '(no name)');

  const group = (rows: TaskRow[], reason: (n: number) => string) => {
    if (rows.length)
      out.push({
        count: rows.length,
        reason: reason(rows.length),
        items: names(rows),
      });
  };

  group(
    by(t => t.presence === 'completed'),
    n =>
      `${is(n, 'is', 'are')} completed in Todoist: closed here and kept in the table.`,
  );
  group(
    by(t => t.presence === 'deleted'),
    n =>
      `${is(n, 'was', 'were')} deleted in Todoist: kept here, open, with the last values Todoist sent.`,
  );
  group(
    by(t => t.presence === 'unavailable'),
    () =>
      'can no longer be reached in Todoist (gone, or no access): kept here, open, with the last values Todoist sent; not closed.',
  );
  group(
    by(t => t.presence === 'unconfirmed'),
    () =>
      'could not be checked in Todoist: last known values kept; checked again at the next sync.',
  );
  group(
    by(t => t.presence === 'local' && !t.incomplete),
    n =>
      `${is(n, 'was', 'were')} added here, not in Todoist: kept as ${is(n, 'it is', 'they are')}; nothing is sent to Todoist.`,
  );

  const incomplete = by(t => !!t.incomplete);
  if (incomplete.length)
    out.push({
      count: incomplete.length,
      reason: `${is(incomplete.length, 'is', 'are')} incomplete (missing Name): listed, not counted above. Fill the column in the table.`,
      items: names(incomplete),
      ...(onOpenRow && incomplete.length === 1
        ? {
            action: {
              label: 'Open row',
              key: `ss-open-row:${incomplete[0].subject}`,
              onClick: () => onOpenRow(incomplete[0].subject),
            },
          }
        : {}),
    });

  return out;
}

/**
 * The card for `state`, or `undefined` for `other-table`: that is a view on
 * another app's Issue table, which this app never syncs, and whose own app
 * may well send edits back, so no "read-only" card belongs there. The view
 * shows the plain notice instead.
 */
export function syncStatusFor(input: StatusInput): SyncStatus | undefined {
  const { state } = input;
  if (state.kind === 'other-table') return undefined;
  const now = input.now ?? Date.now();
  const words = { locale: input.locale, timeZone: input.timeZone };
  const status: SyncStatus = {
    provider: 'Todoist',
    writeBack: 'read-only',
    writeBackNote: state.kind === 'no-relay' ? NO_RELAY_NOTE : WRITE_BACK_NOTE,
    rowNoun: ['task', 'tasks'],
  };
  const problems: Problem[] = [];

  if ('tasks' in state) {
    status.rows = state.tasks.filter(t => t.taskId).length;
    status.rowsScope = 'from Todoist';
    const ignored = ignoredGroups(state.tasks, input.onOpenRow);
    if (ignored.length) status.ignored = ignored;
  }

  const lastGood =
    'lastGood' in state && state.lastGood
      ? Date.parse(state.lastGood)
      : undefined;

  switch (state.kind) {
    case 'loading':
      status.busy = 'Loading…';
      break;
    case 'no-relay':
      problems.push({
        lead: 'This Atomic Server cannot connect apps to Todoist, so nothing is read.',
        text: 'The host has no proxy client for apps yet.',
        tone: 'neg',
      });
      break;
    case 'disconnected':
      problems.push({
        lead: 'Not connected.',
        text: 'Connect Todoist to import your active tasks.',
      });
      break;
    case 'connecting':
      status.busy = 'Waiting for you to confirm the connection…';
      break;
    case 'syncing':
      status.busy = 'Syncing with Todoist…';
      break;

    case 'synced': {
      const s = state.summary;
      status.last = {
        ok: true,
        at: state.at.getTime(),
        counts: { added: s.added, updated: s.updated, unchanged: s.unchanged },
      };
      if (!s.complete)
        problems.push({
          lead: 'The read was partial, so no missing task was checked.',
          text: `Todoist kept sending pages past the cap of ${MAX_PAGES}; tasks past it were not read and no task was settled. ${
            lastGood === undefined
              ? 'There has been no complete read yet.'
              : `The last complete read was ${ago(lastGood, now)}.`
          }`,
        });

      break;
    }

    case 'error': {
      const limited = state.rateLimited
        ? rateLimitWords(state.rateLimited, words)
        : undefined;
      status.last = {
        ok: false,
        at: state.at,
        error: limited ? limited.error : state.message,
        ...(limited
          ? limited.nextStep
            ? { nextStep: limited.nextStep }
            : {}
          : {
              // Without a connection only "Connect Todoist" is shown, so
              // point at it: the load's connection lookup failed.
              nextStep: state.connection
                ? nextStep(state.status)
                : 'Reload the app, or press Connect Todoist.',
            }),
        ...(lastGood !== undefined ? { lastGood } : {}),
      };
      break;
    }
  }

  // Before this page load's first sync: when a complete read last confirmed
  // the table, without counts.
  if (!status.last && lastGood !== undefined)
    status.last = { ok: true, at: lastGood };

  if (problems.length) status.problems = problems;

  return status;
}
