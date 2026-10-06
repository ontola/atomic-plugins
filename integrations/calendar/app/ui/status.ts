// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Decision Inbox Q-084): the
 * controller's `Snapshot` (its `ViewState`, the last `ImportSummary`, the
 * rows and the send outcomes) mapped onto one `SyncStatus`. Pure, so
 * `status.test.ts` checks the mapping for every state without a DOM;
 * `main.ts` renders the result first in every data view.
 *
 * What the card replaces here: the sidebar's "Not shown" note and the
 * agenda's copy of it, the "Incomplete rows" section and the connection
 * bar's "Last synced …". The #89 banners stay: the error banner carries the
 * action and the rate-limit countdown, and the "Not synced" banner the
 * "Sync this table" offer; the card names the same failure as the last sync,
 * and says in every state whether edits go back to Google.
 */
import type {
  IgnoredGroup,
  Problem as CardProblem,
  SyncStatus,
  WriteFailure,
} from '../../../sync-status/card.js';
import {
  banner,
  PAUSED_NOTE,
  reviewCount,
  type Problem,
  type Snapshot,
} from '../controller.js';
import type { CalEvent } from '../events.js';
import { isReadOnly, type Outcome } from '../sync.js';

export const PROVIDER = 'Google Calendar';

export interface StatusInput {
  snapshot: Snapshot;
  /** Opens the Conflicts sheet, for the conflicts problem's action. */
  onConflicts?: () => void;
  /** Opens a row in the host, for a lone incomplete row's "Open row". */
  onOpenRow?: (subject: string) => void;
}

/** The plain next step after a failed read, by the banner's kind (§5.12). */
export const NEXT_STEP: Record<Problem['kind'], string> = {
  reauth: 'Reconnect Google Calendar.',
  forbidden: 'Check your access to the calendar in Google, then retry.',
  'not-found':
    'Check that the calendar still exists and is shared with you, then retry.',
  'rate-limited': 'Wait a moment, then retry.',
  network: 'Check your connection, then retry.',
  'too-many-events':
    'This app imports at most 25,000 events per scan; use a smaller calendar.',
  uncertain: 'Sync now to see what Google has.',
  refused: 'Retry; if it keeps failing, ask the server’s administrator.',
  other: 'Try again.',
};

/** The `local` state's note while a bound table's grant is taken back. */
export const PAUSED_SHORT = 'Syncing with Google Calendar is paused.';

/** The note for a calendar Google shares with you read only. */
export const READ_ONLY_CALENDAR_NOTE =
  'Google gives you view-only access to this calendar, so it refuses edits sent from here; Edit is not offered.';

const is = (n: number) => (n === 1 ? 'is' : 'are');
const them = (n: number) => (n === 1 ? 'it' : 'them');
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A held-back row's reason that means a missing required field, not a bad edit. */
const isIncomplete = (reason: string) => /^Incomplete:/i.test(reason);

/**
 * The incomplete rows (a required `event-v1` field missing), grouped by their
 * note. A row without a Day is drawn on no day, so the group says so; one
 * without a Name is drawn as "(untitled)".
 */
function incompleteGroups(
  events: CalEvent[],
  synced: boolean,
  onOpen?: (subject: string) => void,
): IgnoredGroup[] {
  const byNote = new Map<string, CalEvent[]>();
  for (const event of events)
    if (event.incomplete)
      byNote.set(event.incomplete, [
        ...(byNote.get(event.incomplete) ?? []),
        event,
      ]);

  return [...byNote].map(([note, rows]) => {
    const what = note.replace(/^Incomplete:\s*/i, '');
    const noDay = /\bDay\b/.test(what);
    const n = rows.length;
    const parts = [
      ...(noDay ? [`drawn on no day`] : []),
      ...(synced ? [`nothing of ${them(n)} is sent to Google Calendar`] : []),
    ];

    return {
      count: n,
      reason: `${is(n)} incomplete (${what})${parts.length ? `: ${parts.join(', and ')}` : ''}. Fill the column in the table.`,
      items: rows.map(r => r.title || '(untitled)'),
      ...(onOpen && n === 1
        ? {
            action: {
              label: 'Open row',
              key: `ss-open-row:${rows[0].subject}`,
              onClick: () => onOpen(rows[0].subject),
            },
          }
        : {}),
    };
  });
}

export function syncStatusFor(input: StatusInput): SyncStatus {
  const { snapshot: snap } = input;
  const { state, summary, meta, events } = snap;
  const local = state.kind === 'local';
  // Synced: the table is bound to a calendar (`calendarId`), and not paused.
  // Not `meta`: a table being set up (Sync this table pressed, no calendar
  // chosen yet, or that step failed) keeps the placeholder `meta` of the
  // not-synced view, with a `reader` role that says nothing about Google.
  const synced = !local && !!snap.calendarId;
  // Read-only on screen: a table that isn't synced. A synced table sends
  // reviewed edits, even on a calendar Google shares read only: a change
  // made in the table is still reviewed, and Google answers the send.
  const status: SyncStatus = {
    provider: PROVIDER,
    writeBack: synced ? 'after-review' : 'read-only',
    rowNoun: ['event', 'events'],
  };

  if (synced && summary) {
    status.rows = summary.total;
    if (meta) status.rowsScope = `from ${meta.summary}`;
  } else if (state.kind !== 'loading') {
    status.rows = events.length;
    status.rowsScope = 'in this table';
  }

  if (local && state.reason)
    status.writeBackNote =
      state.reason === PAUSED_NOTE ? PAUSED_SHORT : state.reason;
  if (synced && meta && isReadOnly(meta.accessRole))
    status.writeBackNote = READ_ONLY_CALENDAR_NOTE;

  // The last good read: this page load's, or the one the table or binding
  // recorded (`google-last-sync`), which survives a reload and a pause.
  const lastGood = snap.at ?? snap.lastSync;

  // The last sync: the failed read itself, or the last good read, which
  // stays while a new one runs, while a send runs and after a send failed.
  if (state.kind === 'error' && state.phase === 'read')
    status.last = {
      ok: false,
      at: state.failedAt.getTime(),
      // The banner's title, without a countdown: the banner keeps that.
      error: banner(state.problem, meta?.summary, 0).title,
      nextStep: NEXT_STEP[state.problem.kind],
      ...(lastGood ? { lastGood: lastGood.getTime() } : {}),
    };
  else if (synced && snap.at && summary)
    status.last = {
      ok: true,
      at: snap.at.getTime(),
      counts: {
        added: summary.added,
        updated: summary.updated,
        unchanged: summary.unchanged,
      },
    };
  // Before this page load's first read, or paused: when a read last
  // succeeded, without counts; never "Not synced yet" for a table that was.
  else if ((synced || local) && snap.lastSync)
    status.last = { ok: true, at: snap.lastSync.getTime() };

  if (state.kind === 'loading') status.busy = 'Loading…';
  else if (state.kind === 'refreshing')
    status.busy = state.pages ? `Syncing… (page ${state.pages})` : 'Syncing…';
  else if (state.kind === 'sending') {
    const total = state.progress.length;
    const done = state.progress.filter(
      p => p !== undefined && p !== 'sending',
    ).length;
    status.busy = `Sending ${Math.min(done + 1, total)} of ${total} to Google Calendar…`;
  }

  const problems: CardProblem[] = [];
  // Rows whose edit can't be sent (an empty title, an interval that isn't
  // valid, Day and Start disagreeing): held back whole. Incomplete rows are
  // in the same list, but they are never pending; they get their own group.
  const held = (summary?.invalid ?? []).filter(i => !isIncomplete(i.reason));

  if (synced) {
    // The outcomes of the last send stay until the next refresh replaces
    // them (`ready.outcomes`), or with the failure that ended the send.
    const outcomes: Outcome[] =
      state.kind === 'ready' || state.kind === 'error'
        ? (state.outcomes ?? [])
        : [];
    const failed: WriteFailure[] = outcomes.flatMap(o =>
      o.status === 'failed'
        ? [
            {
              title: o.title,
              reason: o.message,
              ...(o.written ? { written: true } : {}),
            },
          ]
        : [],
    );
    // Only `uncertain` is uncertain: the relay threw after the PATCH was
    // sent. `stale` (a 412) and `failed` wrote nothing.
    const uncertain = outcomes.filter(o => o.status === 'uncertain').length;
    const stale = outcomes.filter(o => o.status === 'stale').length;
    // What "Review N changes" offers: the planned sends of the last preview,
    // or, after a local edit made it stale, the rows edited here and not
    // sent. A `not-sent` or `stale` outcome's row is still edited, so it is
    // in there and stays counted. The uncertain row and a row whose PATCH
    // stood but whose baseline could not be saved are in there too (their
    // baselines did not move), but each is said by its own line, so they
    // are not counted twice.
    const pending = Math.max(
      0,
      reviewCount(snap) - uncertain - failed.filter(f => f.written).length,
    );
    const heldCount = Math.min(held.length, pending);
    status.writes = {
      pending,
      ...(heldCount ? { held: heldCount } : {}),
      ...(failed.length ? { failed } : {}),
      ...(uncertain ? { uncertain } : {}),
    };

    // A 412: Google changed the event after the review, so the send wrote
    // nothing, and the row is reviewed again. Said here as a problem rather
    // than the card's `notWritten` line, whose wording names Clockify's
    // "Changes to send" sheet (a card change would re-publish every app that
    // bundles it).
    if (stale)
      problems.push({
        lead: `${plural(stale, 'change')} not written to Google Calendar.`,
        text: `Changed in Google after you reviewed ${them(stale)}, so nothing was overwritten. Review again to see what Google has now.`,
      });

    // A send that failed before any outcome was recorded (no connection
    // left, the proxy refused): the last good sync stands, so the card says
    // this on top of it. An uncertain send is the `uncertain` line above.
    if (
      state.kind === 'error' &&
      state.phase === 'send' &&
      state.problem.kind !== 'uncertain'
    ) {
      const copy = banner(state.problem, meta?.summary, 0);
      problems.push({ lead: copy.title, text: copy.body, tone: 'neg' });
    }
  }

  const ignored: IgnoredGroup[] = incompleteGroups(
    events,
    synced,
    input.onOpenRow,
  );

  if (synced && summary) {
    const s = summary.skipped;
    if (s.recurring)
      ignored.push({
        count: s.recurring,
        reason: `${is(s.recurring)} recurring: not imported yet, so a series is never mapped in part.`,
      });
    if (s.cancelled)
      ignored.push({
        count: s.cancelled,
        reason: `${is(s.cancelled)} cancelled in Google: counted, not imported, and never treated as a deletion here.`,
      });
    if (s.unreadable)
      ignored.push({
        count: s.unreadable,
        reason: `${s.unreadable === 1 ? 'has' : 'have'} dates this app can’t read: not imported, and never treated as a deletion here.`,
        items: summary.unreadable.map(u => u.title.trim() || '(untitled)'),
      });
    if (summary.localOnly)
      ignored.push({
        count: summary.localOnly,
        reason: `${summary.localOnly === 1 ? 'was' : 'were'} made here: kept here only, not sent to Google Calendar, since creating events isn’t supported.`,
      });
    if (held.length)
      ignored.push({
        count: held.length,
        reason: `can’t be sent as edited: held back whole (nothing of ${them(held.length)} is sent, and Google’s edits to ${them(held.length)} wait) until fixed in the table or with Edit.`,
        items: held.map(r => `${r.title || '(untitled)'}: ${r.reason}`),
      });
  }

  if (ignored.length) status.ignored = ignored;

  if (synced && summary?.conflicts.length) {
    const n = summary.conflicts.length;
    problems.unshift({
      lead: `${plural(n, 'event')} ${n === 1 ? 'needs' : 'need'} a decision.`,
      text: 'Changed both here and in Google, or gone from Google: neither side is changed until you choose.',
      ...(input.onConflicts
        ? {
            action: {
              label: 'Review conflicts',
              key: 'ss-conflicts',
              onClick: input.onConflicts,
            },
          }
        : {}),
    });
  }

  if (synced && summary?.unmapped.length) {
    const cols = summary.unmapped;
    const rows = cols.reduce((n, c) => n + c.rows, 0);
    problems.push({
      lead: `${plural(cols.length, 'column')} the app doesn’t send: ${cols.map(c => c.column).join(', ')}.`,
      text: `Kept here only; ${plural(rows, 'synced event')} fill${rows === 1 ? 's' : ''} ${cols.length === 1 ? 'it' : 'them'}.`,
    });
  }

  if (problems.length) status.problems = problems;

  return status;
}
