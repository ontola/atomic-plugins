// @wc-ignore-file
/**
 * Duplicate rows (#587): two or more complete rows of one table that agree on
 * the importer's identity (`bank-source-id`), its non-empty fingerprint and
 * every bank field (`SAME_FIELDS`), which is what one transaction written
 * twice looks like (two tabs importing the same file at once, a write that
 * failed on the app's side but landed anyway, or a copy made by hand). The
 * app can't stop the second write (it can't choose a row's subject, and the
 * host has no unique create), so it finds them when it reads:
 *
 * - every row of a group but one is a duplicate, left out of every balance,
 *   total, count and filter, and listed apart, like incomplete rows;
 * - the one kept is the one with the lowest subject, so every tab and device
 *   reading the same rows keeps the same one. Not the earliest: the server
 *   serves a `createdAt` it derives from each row's genesis commit, but the
 *   host's copy of a row the app just wrote can lack it (#587's e2e: picking
 *   by it kept the person's later copy), and a pick that differs between
 *   tabs could have two tabs remove both copies.
 *
 * Rows without a source id or a fingerprint are never grouped. Rows that
 * share the source id and fingerprint but differ in a bank field (an amount
 * edited after the import, say) are not duplicates either: hiding one would
 * hide money.
 *
 * Nothing is removed by reading. `planRemoval` says what "Remove
 * duplicates" does on the person's press, from rows read again at that
 * moment: a category or note only a duplicate has moves onto the kept row,
 * then every duplicate whose category and note are empty or equal to the
 * kept row's is destroyed. A duplicate whose category or note differs is
 * kept and stays listed.
 */
import type { Txn } from './rows.js';

/** A complete row that copies another (`duplicateOf`, the kept row). */
export interface Duplicate extends Txn {
  duplicateOf: string;
}

/**
 * The fields two rows must agree on to be one transaction written twice:
 * the importer's identity and fingerprint, and every bank field the ledger
 * shows or sums. A row edited after its import (another amount, say) keeps
 * its source id and fingerprint, so those two alone don't make it a copy.
 */
const SAME_FIELDS = [
  'sourceId',
  'fingerprint',
  'account',
  'currency',
  'amount',
  'valueDate',
  'bookingDate',
  'description',
  'reference',
  'code',
] as const satisfies readonly (keyof Txn)[];

/**
 * The grouping key, or `undefined` for a row that is never grouped: one
 * without a source id or without a fingerprint (an older or hand-made row,
 * where the source id alone says too little).
 */
const keyOf = (row: Txn) =>
  row.sourceId && row.fingerprint
    ? JSON.stringify(SAME_FIELDS.map(field => row[field]))
    : undefined;

/** Whether two rows are the same transaction (`SAME_FIELDS`). */
const sameTransaction = (a: Txn, b: Txn) =>
  keyOf(a) !== undefined && keyOf(a) === keyOf(b);

/** The order of copies: the lowest subject first, the one kept. */
function firstCopy(a: Txn, b: Txn): number {
  return a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0;
}

/**
 * Splits complete rows into one row per transaction (in the order given) and
 * the duplicates of those, each naming the row it copies.
 */
export function groupDuplicates(rows: Txn[]): {
  rows: Txn[];
  duplicates: Duplicate[];
} {
  const groups = new Map<string, Txn[]>();

  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const extra = new Map<string, string>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [kept, ...copies] = [...group].sort(firstCopy);
    for (const copy of copies) extra.set(copy.subject, kept.subject);
  }

  const kept: Txn[] = [];
  const duplicates: Duplicate[] = [];

  for (const row of rows) {
    const of = extra.get(row.subject);
    if (of !== undefined) duplicates.push({ ...row, duplicateOf: of });
    else if ('duplicateOf' in row) {
      // A row that copied one since removed is a row again.
      const { duplicateOf: _, ...plain } = row as Duplicate;
      kept.push(plain);
    } else kept.push(row);
  }

  return { rows: kept, duplicates };
}

/** What pressing "Remove duplicates" does to one kept row and its copies. */
export interface GroupRemoval {
  /** The kept row. */
  subject: string;
  /** Set on the kept row first: a category or note only a copy had. */
  set: Partial<Record<'category' | 'note', string>>;
  /** Copies destroyed afterwards: nothing on them differs from the kept row. */
  remove: string[];
  /** Copies left: their category or note differs from the kept row's. */
  keep: string[];
}

export function planRemoval(
  rows: Txn[],
  duplicates: Duplicate[],
): GroupRemoval[] {
  const bySubject = new Map(rows.map(row => [row.subject, row]));
  const copies = new Map<string, Duplicate[]>();

  for (const copy of duplicates) {
    const list = copies.get(copy.duplicateOf);
    if (list) list.push(copy);
    else copies.set(copy.duplicateOf, [copy]);
  }

  const plan: GroupRemoval[] = [];

  for (const [subject, list] of copies) {
    const kept = bySubject.get(subject);
    if (!kept) continue;
    // Checked again here, right before anything is destroyed: only a copy
    // that agrees with the kept row on every bank field goes.
    const ordered = list
      .filter(copy => sameTransaction(kept, copy))
      .sort(firstCopy);
    const set: GroupRemoval['set'] = {};
    let { category, note } = kept;

    if (!category) {
      const from = ordered.find(copy => copy.category)?.category;
      if (from) category = set.category = from;
    }

    if (!note) {
      const from = ordered.find(copy => copy.note)?.note;
      if (from) note = set.note = from;
    }

    const same = (copy: Txn) =>
      (!copy.category || copy.category === category) &&
      (!copy.note || copy.note === note);

    plan.push({
      subject,
      set,
      remove: ordered.filter(same).map(copy => copy.subject),
      keep: ordered.filter(copy => !same(copy)).map(copy => copy.subject),
    });
  }

  return plan;
}
