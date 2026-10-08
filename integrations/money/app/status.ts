// @wc-ignore-file
/**
 * The Money app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Decision Inbox Q-084): the
 * controller's `State` mapped onto one `SyncStatus`. Pure, so
 * `status.test.ts` checks every state without a DOM; `view.ts` renders the
 * result first on the Transactions and Imports tabs.
 *
 * What it must get right for this app:
 * - There is no provider. Transactions come in from statement files the
 *   person imports (through the importer's review, or the app's own writes)
 *   and nothing ever leaves Atomic, so the card is read-only in every state,
 *   with a note saying why, and that the category and note added here are
 *   saved in this table (after "Allow editing" where the host asks for it).
 * - The "sync" the card dates is the last import: the import that finished
 *   in this view (`state.arrived`, with its count as "added"), else the
 *   newest `imported` stamp among the table's stored statements. A table
 *   whose statements are derived from its rows (an older importer table, a
 *   hand-made shared-class table) records no import date: the card then
 *   reads "Not synced yet" over the rows, and the rows line says the dates
 *   are not recorded, rather than inventing one.
 * - Loading and an import's steps show as busy; a load error is the failed
 *   sync, with when it failed and "Try again."; an import that stopped
 *   midway is a problem that says the rows written so far are kept and how
 *   the rest gets in (check the same file again).
 * - Incomplete rows (#177) are ignored groups by what they miss, with the
 *   rows named and "Open row" when the host can show it and there is one.
 */
import type {
  IgnoredGroup,
  Problem,
  SyncStatus,
} from '../../sync-status/card.js';
import type { State } from './controller.js';
import { importedStatements } from './ledger.js';
import type { Txn } from './rows.js';

export interface StatusInput {
  state: State;
  /** Epoch ms, for "ago"; the view passes its clock. */
  now: number;
  /** "Open row" on one incomplete row, when the host can show it. */
  onOpenRow?: (subject: string) => void;
}

export const ROW_NOUN: [string, string] = ['transaction', 'transactions'];

/** The write-back note in every state: no provider, nothing sent. */
export const NO_PROVIDER_NOTE =
  'There is no bank connection: transactions come in from the MT940 and camt.053 files you import, and the category and note you add are saved in this table.';
/** Appended on a table whose rows this app may not edit yet. */
export const ALLOW_EDITING_NOTE =
  'Saving a category or note asks you to allow editing first.';
/** Appended after the person or the host refused editing. */
export const EDITING_REFUSED_NOTE =
  'Editing the rows was refused, so a category or note cannot be saved until you allow it.';
/** The rows line when the table carries no import date. */
export const NO_DATES_SCOPE =
  'in this table; when they were imported is not recorded';
export const RETRY_STEP = 'Try again.';
export const IMPORT_STOPPED_LEAD =
  'The import stopped before every row was written.';
export const IMPORT_STOPPED_TEXT =
  'The rows written so far are kept; check the same file again to import the rest.';

const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`;

/** The newest `imported` stamp among the stored statements, as epoch ms. */
export function lastImportAt(state: State): number | undefined {
  let latest: number | undefined;

  for (const statement of state.statements ?? []) {
    const at = Date.parse(statement.imported);
    if (Number.isFinite(at) && (latest === undefined || at > latest))
      latest = at;
  }

  return latest;
}

/** What a row is called in a list: its description, else its reference. */
const nameOf = (row: Txn) =>
  row.description.trim() || row.reference.trim() || '(no description)';

/** `state.incomplete` grouped by what is missing, in first-seen order. */
export function incompleteGroups(
  state: State,
  onOpenRow?: (subject: string) => void,
): IgnoredGroup[] {
  const groups = new Map<string, Txn[]>();

  for (const row of state.incomplete) {
    const missing = (row.incomplete ?? 'Incomplete').replace(
      /^Incomplete:\s*/,
      '',
    );
    groups.set(missing, [...(groups.get(missing) ?? []), row]);
  }

  return [...groups].map(([missing, rows]) => ({
    count: rows.length,
    reason: `${rows.length === 1 ? 'is' : 'are'} incomplete (${missing}): shown above the ledger, in no balance, total or import check.`,
    items: rows.map(nameOf),
    ...(rows.length === 1 && state.canOpenRows && onOpenRow
      ? {
          action: {
            label: 'Open row',
            key: `ss-open-${rows[0].subject}`,
            onClick: () => onOpenRow(rows[0].subject),
          },
        }
      : {}),
  }));
}

/** What runs now, in the card's headline, or undefined. */
export function busyText(state: State): string | undefined {
  const view = state.view;
  if (view.kind === 'loading')
    return view.total
      ? `Loading ${view.loaded} of ${view.total}…`
      : 'Loading transactions…';
  const sheet = state.importing;
  if (!sheet) return undefined;
  if (sheet.step === 'checking')
    return sheet.lines[0] !== 'done'
      ? 'Reading the file…'
      : sheet.lines[1] !== 'done'
        ? 'Checking balances…'
        : 'Comparing with the table…';
  if (sheet.step === 'preview' && sheet.applying)
    return sheet.progress
      ? `Importing ${sheet.progress.done} of ${sheet.progress.total}…`
      : 'Importing…';

  return undefined;
}

export function syncStatusFor(input: StatusInput): SyncStatus {
  const { state, now } = input;
  const view = state.view;
  const note =
    state.rowAccess === 'none'
      ? `${NO_PROVIDER_NOTE} ${ALLOW_EDITING_NOTE}`
      : state.rowAccess === 'denied'
        ? `${NO_PROVIDER_NOTE} ${EDITING_REFUSED_NOTE}`
        : NO_PROVIDER_NOTE;
  const status: SyncStatus = {
    provider: 'your bank',
    writeBack: 'read-only',
    writeBackNote: note,
    rowNoun: ROW_NOUN,
  };

  const busy = busyText(state);
  if (busy) status.busy = busy;
  if (view.kind === 'loading') return status;

  if (view.kind === 'error') {
    status.last = {
      ok: false,
      at: state.failedAt ?? now,
      error: view.message,
      nextStep: RETRY_STEP,
    };

    return status;
  }

  const rows = state.rows.length;
  const statements =
    state.statements?.length ?? importedStatements(state.rows).length;
  const importedAt = lastImportAt(state);
  status.rows = rows;
  status.rowsScope =
    statements && (importedAt !== undefined || state.arrived)
      ? `from ${plural(statements, ['statement', 'statements'])}`
      : rows && importedAt === undefined && !state.arrived
        ? NO_DATES_SCOPE
        : 'in this table';

  if (state.arrived)
    status.last = {
      ok: true,
      at: state.arrived.at,
      counts: {
        added: state.arrived.count,
        updated: 0,
        unchanged: Math.max(0, rows - state.arrived.count),
      },
    };
  else if (importedAt !== undefined) status.last = { ok: true, at: importedAt };

  const ignored = incompleteGroups(state, input.onOpenRow);
  if (ignored.length) status.ignored = ignored;

  const problems: Problem[] = [];
  const sheet = state.importing;
  if (sheet?.step === 'preview' && sheet.failure)
    problems.push({
      tone: 'neg',
      lead: IMPORT_STOPPED_LEAD,
      text: `${sheet.failure.replace(/\.?$/, '.')} ${IMPORT_STOPPED_TEXT}`,
    });
  if (problems.length) status.problems = problems;

  return status;
}
