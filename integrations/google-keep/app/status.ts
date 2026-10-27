// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Q-084). Pure.
 *
 * The card knows two write-back modes, "after review" and "read-only";
 * this app sends edits automatically while it is open, which is neither.
 * Adding a third mode to the shared card would change every other app's
 * bundle (and so need a release of each), so the card is given
 * `after-review` and `main.ts` puts `MODE` in its mode line instead.
 */
import {
  ago,
  type IgnoredGroup,
  type Problem,
  type SyncStatus,
} from '../../sync-status/card.js';
import { clockTime, type ViewState } from './controller.js';
import { MAX_PAGES } from './read.js';
import { CONFLICT, type NoteRow, READ_ONLY } from './sync.js';

/** The card's mode line for this app, in every state where it syncs. */
export const MODE =
  'Two-way: edits here are sent to Google Keep, and Keep’s changes come here, every minute while this app is open in anyone’s browser. Nothing syncs while no one has it open.';
export const READ_ONLY_MODE =
  'Read-only: Google Keep’s changes come here every minute while this app is open; nothing here is sent to Keep until you turn on “Send edits to Google Keep” below.';
export const NO_RELAY_MODE =
  'Nothing is sent to Google Keep or read from it until this Atomic Server can connect apps to it.';

export interface StatusInput {
  state: ViewState;
  locale?: string;
  timeZone?: string;
  now?: number;
}

export function nextStep(status: number | undefined): string {
  if (status === 401 || status === 403) return 'Reconnect Google Keep.';
  if (status !== undefined && status >= 500)
    return 'Google had a problem; the next sync tries again.';
  if (status === undefined)
    return 'Check your connection; the next sync tries again.';

  return 'The next sync tries again.';
}

const is = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The rows a pass does not sync as usual, grouped; each row in one group. */
export function ignoredGroups(notes: NoteRow[]): IgnoredGroup[] {
  const out: IgnoredGroup[] = [];

  const group = (rows: NoteRow[], reason: (n: number) => string) => {
    if (rows.length)
      out.push({
        count: rows.length,
        reason: reason(rows.length),
        items: rows.map(r => r.title),
      });
  };

  const away = (r: NoteRow) =>
    r.presence !== 'present' && r.presence !== 'local';

  group(
    notes.filter(r => r.hold === CONFLICT && !away(r)),
    n =>
      `${is(n, 'was', 'were')} changed both here and in Google Keep: nothing is sent or overwritten until you choose a version below.`,
  );
  group(
    notes.filter(r => r.hold === READ_ONLY && !away(r)),
    n =>
      `${is(n, 'has an edit', 'have edits')} waiting: sending to Google Keep is off.`,
  );
  group(
    notes.filter(
      r => r.hold && r.hold !== CONFLICT && r.hold !== READ_ONLY && !away(r),
    ),
    n =>
      `${is(n, 'has an edit', 'have edits')} that cannot be sent to Google Keep; the list below says why.`,
  );
  group(
    notes.filter(r => r.presence === 'trashed'),
    n =>
      `${is(n, 'is', 'are')} in Google Keep’s trash: kept here as last read; edits here are not sent.`,
  );
  group(
    notes.filter(r => r.presence === 'deleted'),
    n =>
      `${is(n, 'was', 'were')} deleted in Google Keep: kept here as last read; edits here are not sent.`,
  );
  group(
    notes.filter(r => r.presence === 'unconfirmed'),
    () =>
      'could not be checked in Google Keep: last known values kept; checked again at the next sync.',
  );

  return out;
}

export function syncStatusFor(input: StatusInput): SyncStatus | undefined {
  const { state } = input;
  if (state.kind === 'other-table') return undefined;
  const now = input.now ?? Date.now();
  const status: SyncStatus = {
    provider: 'Google Keep',
    writeBack:
      'settings' in state && state.settings.writeBack
        ? 'after-review'
        : 'read-only',
    rowNoun: ['note', 'notes'],
  };
  const problems: Problem[] = [];

  if ('notes' in state) {
    status.rows = state.notes.filter(n => n.noteId).length;
    status.rowsScope = 'from Google Keep';
    const ignored = ignoredGroups(state.notes);
    if (state.removedHere.length)
      ignored.push({
        count: state.removedHere.length,
        reason: `${is(state.removedHere.length, 'was', 'were')} deleted here and ${is(state.removedHere.length, 'is', 'are')} still in Google Keep: not deleted there, and not brought back here. Choose below.`,
        items: state.removedHere.map(r => r.title),
      });
    if (ignored.length) status.ignored = ignored;
    const unsent = state.notes.filter(n => n.presence === 'local').length;
    if (unsent || (state.kind === 'synced' && state.summary.failed.length))
      status.writes = {
        pending: unsent,
        ...(state.kind === 'synced' && state.summary.failed.length
          ? { failed: state.summary.failed }
          : {}),
      };
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
        lead: 'This Atomic Server cannot connect apps to Google Keep, so nothing syncs.',
        text: 'The host has no proxy client for apps yet.',
        tone: 'neg',
      });
      break;
    case 'disconnected':
      problems.push({
        lead: 'Not connected.',
        text: 'Connect Google Keep to sync your notes both ways. Google offers the Keep API to Google Workspace accounts only.',
      });
      break;
    case 'connecting':
      status.busy = 'Waiting for you to confirm the connection…';
      break;
    case 'syncing':
      status.busy = 'Syncing with Google Keep…';
      break;
    case 'elsewhere':
      status.busy = 'Another open browser is syncing this table…';
      break;

    case 'synced': {
      const s = state.summary;
      status.last = {
        ok: true,
        at: state.at.getTime(),
        counts: { added: s.added, updated: s.updated, unchanged: s.unchanged },
      };
      if (s.created + s.replaced)
        problems.push({
          lead: `${s.created + s.replaced} ${is(s.created + s.replaced, 'note was', 'notes were')} sent to Google Keep.`,
          ...(s.replaced
            ? {
                text: 'An edited note is sent as a new note and the old one deleted (the Keep API has no update), so its colour, labels and reminders are not kept.',
              }
            : {}),
        });
      if (s.itemConflicts)
        problems.push({
          lead: `${s.itemConflicts} list ${is(s.itemConflicts, 'item was', 'items were')} changed both here and in Google Keep.`,
          text: 'The version here was kept and sent to Google Keep.',
        });
      if (s.waiting)
        problems.push({
          lead: `${s.waiting} ${is(s.waiting, 'edit waits', 'edits wait')} for the next sync.`,
        });
      if (s.retiring)
        problems.push({
          lead: `${s.retiring} replaced ${is(s.retiring, 'note', 'notes')} could not be deleted in Google Keep yet.`,
          text: 'The next sync tries again; until then Keep shows the old and the new version.',
        });
      if (!s.complete)
        problems.push({
          lead: 'The read was partial, so no missing note was checked.',
          text: `Google kept sending pages past the cap of ${MAX_PAGES}.${lastGood === undefined ? '' : ` The last complete read was ${ago(lastGood, now)}.`}`,
        });
      break;
    }

    case 'error': {
      const words = { locale: input.locale, timeZone: input.timeZone };
      status.last = {
        ok: false,
        at: state.at,
        error: state.retryAt
          ? 'Google Keep is rate-limiting this app.'
          : state.message,
        nextStep: state.mismatch
          ? 'Connect the Google account this table syncs with.'
          : state.retryAt
            ? `The sync tries again after ${clockTime(state.retryAt, words)}.`
            : state.connection
              ? nextStep(state.status)
              : 'Reload the app, or press Connect Google Keep.',
        ...(lastGood !== undefined ? { lastGood } : {}),
      };
      break;
    }
  }

  if (!status.last && lastGood !== undefined)
    status.last = { ok: true, at: lastGood };
  if (problems.length) status.problems = problems;

  return status;
}

/** The mode line `main.ts` shows in place of the card's own. */
export const modeFor = (state: ViewState): string => {
  if (state.kind === 'no-relay') return NO_RELAY_MODE;
  const only =
    'settings' in state && state.settings.onlyTitle
      ? ` Only the note titled “${state.settings.onlyTitle}” is synced.`
      : '';

  return (
    ('settings' in state && state.settings.writeBack ? MODE : READ_ONLY_MODE) +
    only
  );
};
