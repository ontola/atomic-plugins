// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Q-084): the controller's `ViewState`,
 * the `Timesheet` the views show and the "Changes to send" list, mapped onto
 * one `SyncStatus`. Pure, so `status.test.ts` checks the mapping without a
 * DOM; `shell.ts` renders the result above the data views.
 *
 * Why these words: Clockify's user testers could not tell whether the app
 * writes back (usertest-findings #6), got no feedback from "Sync now" (#7),
 * and did not know what to do about "Not loaded" (#14).
 */
import type {
  IgnoredGroup,
  Problem,
  SyncStatus,
  WriteFailure,
} from '../../../sync-status/card.js';
import type { ChangesState, SyncOutcome, ViewState } from '../controller.js';
import type { Timesheet } from '../model/types.js';
import type { ProblemKind } from '../problem.js';
import { unknownIn } from './coverage.js';

export interface StatusInput {
  state: ViewState;
  sheet: Timesheet;
  changes: ChangesState;
  /** "Sync now", when the app can sync right now. */
  onSync?: () => void;
}

/** The plain next step after a failed sync, by its kind (#89 frame J). */
export const NEXT_STEP: Record<ProblemKind, string> = {
  reauth: 'Reconnect Clockify.',
  forbidden: 'Choose another workspace in Settings.',
  'rate-limited': 'Wait a moment, then try again.',
  network: 'Check your connection, then try again.',
  'too-many': 'Import 7 days instead.',
  other: 'Try again.',
};

/** `90 min`, `6 h`, `1.5 h`. */
export const hours = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;

  return `${Math.round(minutes / 6) / 10} h`;
};

const inWindow = (sheet: Timesheet) => {
  const w = sheet.window;

  return w
    ? sheet.entries.filter(e => e.start >= w.from && e.start < w.to).length
    : sheet.entries.length;
};

function lastSync(
  state: ViewState,
  sheet: Timesheet,
): SyncStatus['last'] | undefined {
  const outcome: SyncOutcome | undefined =
    state.kind === 'ready' ? state.last : undefined;

  if (outcome?.ok) {
    const { created, updated, unchanged, removed } = outcome.result;

    return {
      ok: true,
      at: outcome.at,
      counts: {
        added: created,
        updated,
        unchanged,
        ...(removed ? { removed } : {}),
      },
    };
  }

  if (outcome)
    return {
      ok: false,
      at: outcome.at,
      error: outcome.error,
      nextStep: NEXT_STEP[outcome.problem.kind],
      // The gap since the last good read may be days: name it.
      ...(sheet.lastChecked ? { lastGood: Date.parse(sheet.lastChecked) } : {}),
    };

  // Before this page load's first sync: when a complete read last confirmed
  // the window, without counts.
  if (sheet.lastChecked) return { ok: true, at: Date.parse(sheet.lastChecked) };

  return undefined;
}

/** The incomplete rows, grouped by their note ("Incomplete: missing Start"). */
function incompleteGroups(
  sheet: Timesheet,
  onOpen?: (id: string) => void,
): IgnoredGroup[] {
  const byNote = new Map<string, { id: string; description: string }[]>();
  for (const row of sheet.incomplete ?? [])
    byNote.set(row.note, [...(byNote.get(row.note) ?? []), row]);

  return [...byNote].map(([note, rows]) => ({
    count: rows.length,
    reason: `${rows.length === 1 ? 'is' : 'are'} incomplete (${note.replace(/^Incomplete:\s*/i, '')}): not counted and not sent to Clockify. Fill the column in the table.`,
    items: rows.map(r => r.description || '(no description)'),
    ...(onOpen && rows.length === 1
      ? {
          action: {
            label: 'Open row',
            key: `ss-open-row:${rows[0].id}`,
            onClick: () => onOpen(rows[0].id),
          },
        }
      : {}),
  }));
}

/**
 * Whether the "Not loaded" views may leave out the tail since the last
 * complete read (`coverage.ts` `unknownIn`): only once this page load has
 * synced successfully, or while it is syncing, when the card's "Synced …
 * ago" covers that tail. After a failed sync, or before any, the tail may
 * be days long and is shown.
 */
export const hidesTail = (state: ViewState): boolean =>
  state.kind === 'syncing' ||
  (state.kind === 'ready' && state.last?.ok === true);

/** The `no-proxy` state's write-back note (#89 frame K). */
export const NO_PROXY_NOTE =
  'This Atomic Server cannot connect apps to Clockify, so nothing is read or sent until it can.';

export function syncStatusFor(
  input: StatusInput & { onOpenRow?: (id: string) => void },
): SyncStatus {
  const { state, sheet, changes } = input;
  const local = state.kind === 'local';
  // Read-only on screen: a table that isn't synced, and a host without a
  // proxy relay (frame K), where nothing can be sent. `setup` (the settings
  // sheet over the data) stays write-back: the connection is there, and an
  // edit made now is listed to send after the next sync.
  const readOnly = local || state.kind === 'no-proxy';
  const settings =
    state.kind === 'ready' || state.kind === 'syncing'
      ? state.settings
      : undefined;
  const status: SyncStatus = {
    provider: 'Clockify',
    writeBack: readOnly ? 'read-only' : 'after-review',
    rowNoun: ['entry', 'entries'],
    rows: inWindow(sheet),
    rowsScope: settings
      ? `in the last ${settings.lookbackDays} days`
      : 'in this table',
  };

  if (local && state.paused)
    status.writeBackNote = 'Syncing with Clockify is paused.';
  if (state.kind === 'no-proxy') status.writeBackNote = NO_PROXY_NOTE;

  const last = local ? undefined : lastSync(state, sheet);
  if (last) status.last = last;

  if (state.kind === 'syncing') status.busy = 'Syncing…';
  else if (changes.sending)
    status.busy = `Sending ${Math.min(changes.sending.done + 1, changes.sending.total)} of ${changes.sending.total} to Clockify…`;

  const problems: Problem[] = [];
  /** A `not-sent` outcome with a message: another copy holds the lease. */
  let leaseHeld: string | undefined;

  if (!local) {
    const held = changes.review.filter(c => c.blockers.length).length;
    const results = changes.outcomes?.results ?? [];
    const failed: WriteFailure[] = results
      .filter(r => r.status === 'failed' || r.status === 'refused')
      .map(r => ({
        title: r.title,
        reason:
          r.message ??
          (r.status === 'refused'
            ? 'Clockify does not allow this change.'
            : 'Clockify answered with an error.'),
      }));
    // Only `uncertain` is uncertain. `not-sent` is a change the send never
    // attempted (the rest of a batch after an uncertain one, or every
    // change while another copy holds the lease): it stays in the review,
    // so it is already counted in `pending`.
    const uncertain = results.filter(r => r.status === 'uncertain').length;
    const notWritten = results.filter(
      r =>
        r.status === 'conflict' ||
        r.status === 'changed' ||
        r.status === 'gone',
    ).length;
    leaseHeld = results.find(
      r => r.status === 'not-sent' && r.message,
    )?.message;
    status.writes = {
      pending: changes.review.length,
      ...(held ? { held } : {}),
      ...(failed.length ? { failed } : {}),
      ...(uncertain ? { uncertain } : {}),
      ...(notWritten ? { notWritten } : {}),
    };

    if (changes.error)
      problems.push({
        lead: 'The last edit or send could not be saved or started.',
        text: changes.error,
        tone: 'neg',
      });
  }

  const ignored: IgnoredGroup[] = incompleteGroups(sheet, input.onOpenRow);
  if (sheet.running)
    ignored.push({
      count: sheet.running,
      reason: `${sheet.running === 1 ? 'is a running timer' : 'are running timers'}: counted, and shown once stopped in Clockify.`,
    });
  if (sheet.breaks)
    ignored.push({
      count: sheet.breaks,
      reason: `${sheet.breaks === 1 ? 'is a break' : 'are breaks'}: shown on the timeline, not as time worked.`,
    });
  if (sheet.uneditable?.locked)
    ignored.push({
      count: sheet.uneditable.locked,
      reason: `${sheet.uneditable.locked === 1 ? 'is' : 'are'} locked in Clockify: shown, but cannot be edited here.`,
    });
  if (sheet.uneditable?.customFields)
    ignored.push({
      count: sheet.uneditable.customFields,
      reason: `${sheet.uneditable.customFields === 1 ? 'has' : 'have'} custom fields: shown, but cannot be edited here yet.`,
    });
  if (ignored.length) status.ignored = ignored;

  const unknown = sheet.window
    ? unknownIn(sheet, sheet.window, { hideTail: hidesTail(state) })
    : [];
  const unknownMs = unknown.reduce((n, i) => n + (i.to - i.from), 0);

  if (unknownMs && !local)
    problems.push({
      lead: `${hours(unknownMs)} of ${settings ? `the last ${settings.lookbackDays} days` : 'the window'} not loaded yet.`,
      text: 'Clockify has not been read for that time, so entries there may be missing. Sync now to load it.',
      ...(input.onSync
        ? {
            action: {
              label: 'Sync now',
              key: 'ss-sync',
              onClick: input.onSync,
              disabled: state.kind === 'syncing',
            },
          }
        : {}),
    });

  // Seen by the last sync (the lease on the log head), or by a send that
  // found the lease held: one problem, not two.
  const elsewhere =
    state.kind === 'ready' &&
    state.last?.ok &&
    state.last.result.sendingElsewhereUntil;
  if (elsewhere || leaseHeld)
    problems.push({
      lead: 'Another open copy of this app is sending changes to Clockify.',
      // The lease message (`lease.ts` `heldMessage`) says until when; its
      // first sentence repeats the lead, so it is dropped.
      text: leaseHeld
        ? leaseHeld.replace(/^Another open copy of this app[^.]*\.\s*/, '')
        : 'Your changes stay listed; send them once it has finished.',
    });

  if (problems.length) status.problems = problems;

  return status;
}
