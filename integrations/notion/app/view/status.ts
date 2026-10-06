// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Q-084): a controller `ViewState` and
 * the databases the table syncs with, mapped onto one `SyncStatus`. Pure, so
 * `status.test.ts` checks the mapping for every state without a DOM;
 * `app.ts` renders the result first in the data view, above the databases.
 *
 * Notion's writes do not go through syncables' `pendingWrites()`: the app
 * finds edits by comparing each row with its baseline (`changes.ts`) and
 * sends them itself (`send.ts`), so, as in Clockify, the write queue is the
 * review list and the last Send's outcomes. The saved sync record is the
 * last *good* sync (a failed sync keeps the previous record), so a failure
 * names it as the last good sync.
 */
import type {
  Problem,
  SyncStatus,
  WriteFailure,
} from '../../../sync-status/card.js';
import type { RowChange } from '../changes.js';
import { isConnected, type ViewState } from '../controller.js';
import { sendable } from '../changes.js';
import { clock, plural } from '../ui/format.js';
import { notes, type Source } from './model.js';

export interface StatusInput {
  state: ViewState;
  /** The databases the table syncs with (`model.ts` `sources`). */
  sources: Source[];
  now: number;
  locale?: string;
  /** Opens the Sync details panel, where the per-database notes are. */
  onDetails?: () => void;
}

/** The write-back notes, one per state in which nothing can be sent. */
export const NOTE = {
  'no-proxy':
    'This Atomic Server cannot connect apps to Notion, so nothing is read or sent until it can.',
  'not-connected': 'Connect Notion to sync.',
  disconnected:
    'Notion is not connected to this app; connect it again to sync and send.',
  reauth:
    'Notion no longer gives Atomic access; reconnect it to sync and send.',
  /** Connected, but `send()` is only offered from `ready` (`review.ts`). */
  waits: 'Sending waits until a sync succeeds.',
} as const;

const fields = (changes: readonly RowChange[]) =>
  changes.reduce((n, c) => n + c.fields.length, 0);

export function syncStatusFor(input: StatusInput): SyncStatus {
  const { state, sources, locale } = input;
  const status: SyncStatus = { provider: 'Notion', writeBack: 'read-only' };

  // Before a connection there is no data view; the mapping is still right.
  if (!isConnected(state)) {
    if (state.kind === 'no-proxy') status.writeBackNote = NOTE['no-proxy'];
    else if (state.kind !== 'loading')
      status.writeBackNote = NOTE['not-connected'];

    return status;
  }

  const record = state.last;
  const connected =
    !!state.connectionId &&
    state.kind !== 'disconnected' &&
    state.kind !== 'reauth';
  status.writeBack = connected ? 'after-review' : 'read-only';
  status.rows = state.rows.length;
  status.rowsScope = 'in this table';

  if (state.kind === 'reauth') status.writeBackNote = NOTE.reauth;
  else if (!connected) status.writeBackNote = NOTE.disconnected;
  else if (
    state.kind === 'no-databases' ||
    state.kind === 'rate-limited' ||
    state.kind === 'failed'
  )
    status.writeBackNote = NOTE.waits;

  const lastGood = record ? { lastGood: record.at } : {};

  switch (state.kind) {
    case 'failed':
      status.last = {
        ok: false,
        at: state.at,
        error: state.title,
        nextStep: 'Try again.',
        ...lastGood,
      };
      break;
    case 'rate-limited':
      status.last = {
        ok: false,
        at: state.at,
        error: 'Notion asked Atomic to slow down.',
        nextStep: `It tries again at ${clock(state.retryAt, locale)}.`,
        ...lastGood,
      };
      break;
    case 'reauth':
      status.last = {
        ok: false,
        at: state.at,
        error: 'Notion no longer gives Atomic access.',
        nextStep: 'Reconnect Notion.',
        ...lastGood,
      };
      break;
    default:
      if (record)
        status.last = {
          ok: true,
          at: record.at,
          counts: {
            added: record.created,
            updated: record.updated,
            unchanged: record.unchanged,
          },
        };
  }

  if (state.kind === 'syncing') {
    const active = [...state.progress].reverse().find(p => p.phase !== 'done');
    status.busy = active ? `Syncing… ${active.title}` : 'Syncing…';
  } else if (state.kind === 'importing') status.busy = 'Importing…';
  else if (state.sending) {
    const total = (state.changes ?? []).filter(sendable).length;
    const done = state.outcomes?.length ?? 0;
    status.busy = total
      ? `Sending ${Math.min(done + 1, total)} of ${total} to Notion…`
      : 'Sending to Notion…';
  }

  // The write queue: edits found by compare-on-open, counted in fields as
  // the strip and the Send button count them, and the last Send's outcomes
  // (cleared by the next sync or Send, so none outlives what settled it).
  const changes = state.changes ?? [];
  const held = changes.reduce(
    (n, c) => n + c.fields.filter(f => f.conflict || f.problem).length,
    0,
  );
  const outcomes = state.outcomes ?? [];
  const failed: WriteFailure[] = outcomes.flatMap(o =>
    o.status === 'failed' || o.status === 'refused'
      ? [
          {
            // A `failed` with no row is the whole send (`controller.ts`).
            title: o.name || 'The send',
            reason: o.message,
            // The PATCH stood; updating the row here failed after it.
            ...(o.status === 'refused' && o.written ? { written: true } : {}),
          },
        ]
      : [],
  );
  // Only `unknown` is uncertain: the PATCH got no answer. `changed` and
  // `gone` wrote nothing, for a reason the review lists.
  const uncertain = outcomes.filter(o => o.status === 'unknown').length;
  const notWritten = outcomes.filter(
    o => o.status === 'changed' || o.status === 'gone',
  ).length;
  status.writes = {
    pending: fields(changes),
    ...(held ? { held } : {}),
    ...(failed.length ? { failed } : {}),
    ...(uncertain ? { uncertain } : {}),
    ...(notWritten ? { notWritten } : {}),
  };

  const problems: Problem[] = [];

  // The record's own warnings (an incomplete read, a column with another
  // datatype, a record that could not be saved), then the per-database
  // notes the pill counts, which Sync details lists.
  for (const warning of record?.general ?? [])
    problems.push({ lead: 'From the last sync:', text: warning });
  const perDatabase = record ? notes(record) - record.general.length : 0;
  if (perDatabase)
    problems.push({
      lead: `${plural(perDatabase, 'note')} from the last sync.`,
      text: 'Formatting Notion keeps, archived pages and read errors, listed per database.',
      ...(input.onDetails
        ? {
            action: {
              label: 'Sync details',
              key: 'ss-details',
              onClick: input.onDetails,
            },
          }
        : {}),
    });

  if (state.kind === 'no-databases')
    problems.push({
      lead: 'Notion shares no database with Atomic any more.',
      text: 'Share a database with the integration in Notion, then sync again.',
    });
  else if (record && !state.rows.length && sources.length)
    problems.push({
      lead: 'The shared databases have no pages.',
      text: 'Add one in Notion, then sync again.',
    });

  if (problems.length) status.problems = problems;

  return status;
}
