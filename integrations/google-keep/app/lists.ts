// @wc-ignore-file
/**
 * A list note merged item by item. Pure: `sync.ts` reads the rows and Keep's
 * note, calls `mergeList`, and writes what it returns.
 *
 * Three versions of a list meet in a pass:
 *
 * - the **baseline**: the list as both sides had it at the last sync, kept
 *   on the note's row as a Markdown checklist (`google-keep-list`);
 * - the **drive's**: the note's item rows, each with its text, done, the
 *   item it is under and its position, and the index of the baseline item
 *   it was at the last sync (`google-keep-base`; none for an item added
 *   here);
 * - **Keep's**: the note's items now.
 *
 * The drive's items carry their identity. Keep's do not: the API gives an
 * item no id (`ListItem` is text, checked and child items only), so
 * `matchKeep` pairs Keep's items with the baseline's by text and position.
 * Then every item is merged field by field (text, done, the item it is
 * under) and the order is merged as moves:
 *
 * - a field changed on one side takes that side's value;
 * - a field changed on both sides to different values keeps the drive's,
 *   and is counted in `conflicts`;
 * - an item deleted on one side and edited on the other stays;
 * - an item moved on one side keeps the position that side gave it;
 * - an item added on either side is added, after the item it followed.
 *
 * So an item moved in Keep and ticked here comes out moved and ticked.
 */
import { renderList, type Item } from './notes.js';

/** An item in list order; `depth` 1 is under the nearest depth-0 item before it. */
export interface FlatItem {
  text: string;
  done: boolean;
  depth: 0 | 1;
}

/** An item row of the drive. */
export interface ItemRow {
  subject: string;
  text: string;
  done: boolean;
  /** The item row this one is under, if any. */
  under?: string;
  position: number;
  /** The index of the baseline item this row was at the last sync. */
  base?: number;
}

export interface MergedItem extends FlatItem {
  /** The drive's row for it, or none for an item to create. */
  subject?: string;
  /** The index of its counterpart in Keep's list now, if it has one. */
  keep?: number;
}

export interface ListMerge {
  /** The merged list, in order. */
  items: MergedItem[];
  /** Rows whose item is gone from the merged list. */
  removed: string[];
  /** Whether the merged list differs from Keep's: the note must be replaced. */
  send: boolean;
  /** Fields changed on both sides to different values (the drive's kept). */
  conflicts: number;
}

export const flatten = (items: Item[]): FlatItem[] =>
  items.flatMap(item => [
    { text: item.text, done: item.checked, depth: 0 as const },
    ...item.children.map(c => ({
      text: c.text,
      done: c.checked,
      depth: 1 as const,
    })),
  ]);

/** A flat list back as Keep's nesting; a child with no item above it becomes a top item. */
export function nest(items: FlatItem[]): Item[] {
  const out: Item[] = [];

  for (const item of items) {
    const entry = { text: item.text, checked: item.done };
    const parent = out.at(-1);
    if (item.depth === 1 && parent) parent.children.push(entry);
    else out.push({ ...entry, children: [] });
  }

  return out;
}

/** The list as the Markdown checklist the baseline is kept in. */
export const listText = (items: FlatItem[]): string => renderList(nest(items));

/** Each item's parent index (top items: -1). */
const parents = (items: FlatItem[]): number[] => {
  let top = -1;

  return items.map((item, i) => {
    if (item.depth === 0 || top === -1) {
      top = i;

      return -1;
    }

    return top;
  });
};

/**
 * Keep's items paired with the baseline's: `out[k]` is the baseline index of
 * Keep's item `k`, or undefined for an item added in Keep. Same text and
 * tick first, then same text (among equal candidates the nearest index
 * wins), then an unpaired item between the same two paired neighbours (its
 * text edited in Keep). An item deleted and another added in the same gap
 * pair as an edit.
 */
export function matchKeep(
  base: FlatItem[],
  keep: FlatItem[],
): (number | undefined)[] {
  const out: (number | undefined)[] = keep.map(() => undefined);
  const taken = new Set<number>();

  const pass = (same: (b: FlatItem, k: FlatItem) => boolean) => {
    keep.forEach((k, ki) => {
      if (out[ki] !== undefined) return;
      let best: number | undefined;

      base.forEach((b, bi) => {
        if (taken.has(bi) || !same(b, k)) return;
        if (best === undefined || Math.abs(bi - ki) < Math.abs(best - ki))
          best = bi;
      });

      if (best !== undefined) {
        out[ki] = best;
        taken.add(best);
      }
    });
  };

  pass((b, k) => b.text === k.text && b.done === k.done);
  pass((b, k) => b.text === k.text);
  // An unpaired item between two paired neighbours takes the first
  // unpaired baseline item between theirs: its text was edited in Keep.
  keep.forEach((_, ki) => {
    if (out[ki] !== undefined) return;
    let before = -1;
    let after = base.length;

    for (let p = ki - 1; p >= 0; p--)
      if (out[p] !== undefined) {
        before = out[p]!;
        break;
      }

    for (let n = ki + 1; n < keep.length; n++)
      if (out[n] !== undefined) {
        after = out[n]!;
        break;
      }

    for (let bi = before + 1; bi < after; bi++)
      if (!taken.has(bi)) {
        out[ki] = bi;
        taken.add(bi);
        break;
      }
  });

  return out;
}

/** The indexes of `seq` on a longest common subsequence with `other`. */
function stayed(seq: string[], other: string[]): Set<string> {
  const common = new Set(other);
  const a = seq.filter(id => common.has(id));
  const inA = new Set(a);
  const b = other.filter(id => inA.has(id));
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);

  const out = new Set<string>();
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.add(a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }

  return out;
}

interface Entry {
  id: string;
  subject?: string;
  text: string;
  done: boolean;
  /** The entry this one is under, by id. */
  under?: string;
  keep?: number;
}

/** Three-way on one value: the side that changed wins; both changed, the drive's. */
function pick<T>(base: T, mine: T, theirs: T, conflict: () => void): T {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  conflict();

  return mine;
}

/**
 * The merge of one list note. `base` is the baseline list (empty for a note
 * that was never a list here), `rows` the drive's item rows of the note,
 * `keep` Keep's items now.
 */
export function mergeList({
  base,
  rows,
  keep,
}: {
  base: FlatItem[];
  rows: ItemRow[];
  keep: FlatItem[];
}): ListMerge {
  let conflicts = 0;

  const conflict = () => {
    conflicts++;
  };

  // The drive's rows by baseline index; a row whose index is out of range
  // or claimed twice counts as added here.
  const local = new Map<number, ItemRow>();
  const added: ItemRow[] = [];

  for (const row of [...rows].sort(
    (a, b) => a.position - b.position || a.subject.localeCompare(b.subject),
  )) {
    if (
      row.base !== undefined &&
      Number.isInteger(row.base) &&
      row.base >= 0 &&
      row.base < base.length &&
      !local.has(row.base)
    )
      local.set(row.base, row);
    else added.push(row);
  }

  const paired = matchKeep(base, keep);
  const keepOf = new Map<number, number>();
  paired.forEach((bi, ki) => {
    if (bi !== undefined) keepOf.set(bi, ki);
  });

  const baseParent = parents(base);
  const keepParent = parents(keep);
  const idOfBase = (bi: number) => `b${bi}`;
  const idOfKeep = (ki: number) =>
    paired[ki] === undefined ? `k${ki}` : idOfBase(paired[ki]!);
  const idOfRow = new Map<string, string>();
  for (const [bi, row] of local) idOfRow.set(row.subject, idOfBase(bi));
  for (const row of added) idOfRow.set(row.subject, `r${row.subject}`);

  const entries = new Map<string, Entry>();

  // Items of the baseline.
  base.forEach((b, bi) => {
    const row = local.get(bi);
    const ki = keepOf.get(bi);
    const k = ki === undefined ? undefined : keep[ki];
    const bUnder = baseParent[bi] === -1 ? undefined : idOfBase(baseParent[bi]);
    const rowUnder = row?.under ? idOfRow.get(row.under) : undefined;
    const kUnder =
      ki === undefined || keepParent[ki] === -1
        ? undefined
        : idOfKeep(keepParent[ki]);

    if (!row && !k) return;

    if (!row) {
      // Deleted here: gone, unless Keep edited it meanwhile.
      if (k!.text === b.text && k!.done === b.done) return;

      entries.set(idOfBase(bi), {
        id: idOfBase(bi),
        text: k!.text,
        done: k!.done,
        under: kUnder,
        keep: ki,
      });

      return;
    }

    if (!k) {
      // Deleted in Keep: gone, unless edited here meanwhile.
      if (row.text === b.text && row.done === b.done) return;
      entries.set(idOfBase(bi), {
        id: idOfBase(bi),
        subject: row.subject,
        text: row.text,
        done: row.done,
        under: rowUnder,
      });

      return;
    }

    entries.set(idOfBase(bi), {
      id: idOfBase(bi),
      subject: row.subject,
      text: pick(b.text, row.text, k.text, conflict),
      done: pick(b.done, row.done, k.done, conflict),
      under: pick(bUnder, rowUnder, kUnder, conflict),
      keep: ki,
    });
  });

  // Items added here, and items added in Keep.
  for (const row of added)
    entries.set(`r${row.subject}`, {
      id: `r${row.subject}`,
      subject: row.subject,
      text: row.text,
      done: row.done,
      under: row.under ? idOfRow.get(row.under) : undefined,
    });

  keep.forEach((k, ki) => {
    if (paired[ki] !== undefined) return;
    entries.set(`k${ki}`, {
      id: `k${ki}`,
      text: k.text,
      done: k.done,
      under: keepParent[ki] === -1 ? undefined : idOfKeep(keepParent[ki]),
      keep: ki,
    });
  });

  // Order: the drive's, with Keep's moves and additions put in after the
  // item they follow in Keep.
  const baseSeq = base.map((_, bi) => idOfBase(bi));
  const localSeq = [...rows]
    .sort(
      (a, b) => a.position - b.position || a.subject.localeCompare(b.subject),
    )
    .map(row => idOfRow.get(row.subject)!);
  const keepSeq = keep.map((_, ki) => idOfKeep(ki));
  const keepStayed = stayed(
    baseSeq.filter(id => keepSeq.includes(id)),
    keepSeq,
  );
  const localStayed = stayed(
    baseSeq.filter(id => localSeq.includes(id)),
    localSeq,
  );
  const movedInKeep = (id: string) =>
    id.startsWith('k') ||
    !localSeq.includes(id) ||
    (!keepStayed.has(id) && localStayed.has(id));

  const order = localSeq.filter(id => entries.has(id));

  for (const [at, id] of keepSeq.entries()) {
    if (!entries.has(id) || !movedInKeep(id)) continue;
    const was = order.indexOf(id);
    if (was !== -1) order.splice(was, 1);
    let after = -1;

    for (let p = at - 1; p >= 0; p--) {
      const found = order.indexOf(keepSeq[p]);

      if (found !== -1) {
        after = found;
        break;
      }
    }

    order.splice(after + 1, 0, id);
  }

  for (const id of entries.keys()) if (!order.includes(id)) order.push(id);

  // Nesting: one level, a child right after its parent's other children.
  const tops = order.filter(id => {
    const under = entries.get(id)!.under;

    return (
      !under || !entries.has(under) || entries.get(under)!.under !== undefined
    );
  });
  const flat: Entry[] = [];

  for (const id of tops) {
    flat.push(entries.get(id)!);

    for (const child of order)
      if (
        child !== id &&
        entries.get(child)!.under === id &&
        !tops.includes(child)
      )
        flat.push(entries.get(child)!);
  }

  const items: MergedItem[] = flat.map(e => ({
    text: e.text,
    done: e.done,
    depth: tops.includes(e.id) ? 0 : 1,
    ...(e.subject ? { subject: e.subject } : {}),
    ...(e.keep === undefined ? {} : { keep: e.keep }),
  }));
  const kept = new Set(items.map(i => i.subject).filter(Boolean));
  const send =
    items.length !== keep.length ||
    items.some(
      (item, i) =>
        item.text !== keep[i].text ||
        item.done !== keep[i].done ||
        item.depth !== keep[i].depth,
    );

  return {
    items,
    removed: rows.map(r => r.subject).filter(s => !kept.has(s)),
    send,
    conflicts,
  };
}

/** An item's text as Keep keeps it: one line, no surrounding blanks. */
export const itemText = (text: string): string =>
  text.replace(/\s*\n\s*/g, ' ').trim();

/**
 * The drive's rows of one note as a list, in order: by position, a row
 * under another right after it (one level, as Keep allows).
 */
export function localList(rows: ItemRow[]): MergedItem[] {
  const sorted = [...rows].sort(
    (a, b) => a.position - b.position || a.subject.localeCompare(b.subject),
  );
  const bySubject = new Map(sorted.map(r => [r.subject, r]));
  const isTop = (r: ItemRow) =>
    !r.under ||
    r.under === r.subject ||
    !bySubject.has(r.under) ||
    !!bySubject.get(r.under)!.under;
  const out: MergedItem[] = [];

  for (const top of sorted.filter(isTop)) {
    out.push({
      subject: top.subject,
      text: top.text,
      done: top.done,
      depth: 0,
    });

    for (const child of sorted)
      if (!isTop(child) && child.under === top.subject)
        out.push({
          subject: child.subject,
          text: child.text,
          done: child.done,
          depth: 1,
        });
  }

  return out;
}

/** The `body` of `POST /v1/notes` for a list. */
export const keepListBody = (items: FlatItem[]) => ({
  list: {
    listItems: nest(items).map(item => ({
      text: { text: item.text },
      checked: item.checked,
      ...(item.children.length
        ? {
            childListItems: item.children.map(child => ({
              text: { text: child.text },
              checked: child.checked,
            })),
          }
        : {}),
    })),
  },
});
