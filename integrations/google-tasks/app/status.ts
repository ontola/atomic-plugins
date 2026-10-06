// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Decision Inbox Q-084): the
 * controller's `ViewState` mapped onto one `SyncStatus`. Pure, so
 * `status.test.ts` checks every state without a DOM; `main.ts` renders the
 * result first in the view.
 *
 * What it must get right for this app: it is read-only in every state
 * (nothing is ever sent to Google), and a local edit to an imported column
 * is overwritten at the next sync, so the card says both wherever it syncs.
 * Where it never syncs (a host without the proxy client) it promises no
 * next sync, and on another app's Issue table there is no card at all. The
 * tasks that stopped appearing (deleted, unavailable, unconfirmed), the rows
 * the pass leaves alone (made here, in a list no longer ticked, incomplete)
 * are listed as groups with counts and names, each row in one group only. A
 * failed sync names the last complete read (`google-tasks-last-sync` on the
 * App), so a gap is never hidden; a rate limit says whether the app retries
 * by itself and when.
 */
import {
  ago,
  type IgnoredGroup,
  type Problem,
  type SyncStatus,
} from '../../sync-status/card.js';
import { rateLimitWords, type ViewState } from './controller.js';
import { MAX_LOOKUPS, MAX_PAGES } from './read.js';
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
 * syncs: every state but `no-relay`.
 */
export const WRITE_BACK_NOTE =
  'Nothing is sent to Google Tasks. An edit here to an imported column (Name, Status, Description, Due date) is overwritten at the next sync; a row added here is kept.';
/** `no-relay`: no sync can run on this host, so no next sync is promised. */
export const NO_RELAY_NOTE =
  'Nothing is sent to Google Tasks, and nothing is read or overwritten until this Atomic Server can connect apps to it.';

/** The plain next step after a failed sync, by Google's answer. */
export function nextStep(status: number | undefined): string {
  if (status === 401 || status === 403) return 'Reconnect Google Tasks.';
  if (status !== undefined && status >= 500)
    return 'Google had a problem; try again in a moment.';
  if (status === undefined) return 'Check your connection, then try again.';

  return 'Try again.';
}

const is = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The rows the pass left out or settled, grouped, in the table's current
 * state. Each row is in at most one group: an incomplete row is only in the
 * incomplete group, whatever its presence, so nothing is counted twice.
 */
export function ignoredGroups(
  tasks: TaskRow[],
  chosen: string[],
  onOpenRow?: (subject: string) => void,
): IgnoredGroup[] {
  const out: IgnoredGroup[] = [];
  const complete = tasks.filter(t => !t.incomplete);
  const by = (test: (t: TaskRow) => boolean) => complete.filter(test);
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
    by(t => t.presence === 'deleted'),
    n =>
      `${is(n, 'was', 'were')} deleted in Google Tasks: kept here as last read; not closed.`,
  );
  group(
    by(t => t.presence === 'unavailable'),
    () =>
      'can no longer be reached in Google Tasks (gone, moved, or no access): kept here with the last values Google sent; not closed.',
  );
  group(
    by(t => t.presence === 'unconfirmed'),
    () =>
      'could not be checked in Google Tasks: last known values kept; checked again at the next sync.',
  );
  group(
    by(
      t => t.presence === 'present' && !!t.listId && !chosen.includes(t.listId),
    ),
    n =>
      `${is(n, 'is', 'are')} in a task list that is no longer ticked: kept as last read, not synced. Tick the list to sync ${is(n, 'it', 'them')} again.`,
  );
  group(
    by(t => t.presence === 'local'),
    n =>
      `${is(n, 'was', 'were')} added here, not in Google Tasks: kept as ${is(n, 'it is', 'they are')}; nothing is sent to Google.`,
  );

  const incomplete = tasks.filter(t => !!t.incomplete);
  if (incomplete.length)
    out.push({
      count: incomplete.length,
      reason: `${is(incomplete.length, 'is', 'are')} incomplete (missing Name): listed, not counted above. Fill the column in the table${
        incomplete.some(t => t.taskId)
          ? ', or give the task a title in Google'
          : ''
      }.`,
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
    provider: 'Google Tasks',
    writeBack: 'read-only',
    writeBackNote: state.kind === 'no-relay' ? NO_RELAY_NOTE : WRITE_BACK_NOTE,
    rowNoun: ['task', 'tasks'],
  };
  const problems: Problem[] = [];

  if ('tasks' in state) {
    status.rows = state.tasks.filter(t => t.taskId).length;
    status.rowsScope = 'from Google Tasks';
    const ignored = ignoredGroups(state.tasks, state.chosen, input.onOpenRow);
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
        lead: 'This Atomic Server cannot connect apps to Google Tasks, so nothing is read.',
        text: 'The host has no proxy client for apps yet.',
        tone: 'neg',
      });
      break;
    case 'disconnected':
      problems.push({
        lead: 'Not connected.',
        text: 'Connect Google Tasks to import the task lists you choose.',
      });
      break;
    case 'connecting':
      status.busy = 'Waiting for you to confirm the connection…';
      break;
    case 'syncing':
      status.busy = 'Syncing with Google Tasks…';
      break;

    case 'synced': {
      const s = state.summary;
      status.last = {
        ok: true,
        at: state.at.getTime(),
        counts: { added: s.added, updated: s.updated, unchanged: s.unchanged },
      };
      if (!s.chosen.length)
        problems.push({
          lead: 'No task list chosen.',
          text: `Google lists ${s.lists.length} task list${s.lists.length === 1 ? '' : 's'} for this account; tick the ones to import below.`,
        });
      if (!s.complete)
        problems.push({
          lead: 'The read was partial, so no missing task was checked.',
          text: `Google kept sending pages past the cap of ${MAX_PAGES}; tasks past it were not read and no task was settled. ${
            lastGood === undefined
              ? 'There has been no complete read yet.'
              : `The last complete read was ${ago(lastGood, now)}.`
          }`,
        });
      if (s.presence.unconfirmed > MAX_LOOKUPS)
        problems.push({
          lead: `More than ${MAX_LOOKUPS} tasks left their lists at once.`,
          text: `The app checks ${MAX_LOOKUPS} of them per sync; the rest are checked at later syncs.`,
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
              // Without a connection only "Connect Google Tasks" is shown,
              // so point at it: the load's connection lookup failed.
              nextStep: state.connection
                ? nextStep(state.status)
                : 'Reload the app, or press Connect Google Tasks.',
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
