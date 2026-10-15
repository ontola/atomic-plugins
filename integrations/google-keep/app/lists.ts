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
 * The pairing and the merge are syncables' (`pairItems`,
 * `mergeUnkeyedList`, CRUD Causality 0.7.0 §4.9); this file adapts the
 * drive's rows and Keep's items to them.
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
import {
  mergeUnkeyedList,
  pairItems,
  type FlatListItem,
  type UnkeyedList,
} from 'syncables/browser';
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

/**
 * Keep's list items as CRUD Causality 0.7.0 `unkeyedLists` declares them
 * (§7.8 of the spec): paired on text and tick, children one level down.
 */
export const KEEP_LIST: UnkeyedList = {
  match: ['text.text', 'checked'],
  children: 'childListItems',
};

const toValue = (item: FlatItem): FlatListItem => ({
  value: { text: { text: item.text }, checked: item.done },
  depth: item.depth,
});

const fromValue = (value: Record<string, unknown>) => {
  const text = value.text as { text?: unknown } | undefined;

  return {
    text: typeof text?.text === 'string' ? text.text : '',
    done: value.checked === true,
  };
};

/**
 * Keep's items paired with the baseline's: `out[k]` is the baseline index of
 * Keep's item `k`, or undefined for an item added in Keep (syncables'
 * `pairItems`).
 */
export const matchKeep = (
  base: FlatItem[],
  keep: FlatItem[],
): (number | undefined)[] =>
  pairItems(KEEP_LIST, base.map(toValue), keep.map(toValue));

/**
 * The merge of one list note (syncables' `mergeUnkeyedList`). `base` is the
 * baseline list (empty for a note that was never a list here), `rows` the
 * drive's item rows of the note, `keep` Keep's items now.
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
  const merge = mergeUnkeyedList({
    spec: KEEP_LIST,
    base: base.map(toValue),
    local: rows.map(row => ({
      id: row.subject,
      value: toValue({ text: row.text, done: row.done, depth: 0 }).value,
      position: row.position,
      ...(row.under ? { under: row.under } : {}),
      ...(row.base === undefined ? {} : { base: row.base }),
    })),
    remote: keep.map(toValue),
  });

  return {
    items: merge.items.map(item => ({
      ...fromValue(item.value),
      depth: item.depth,
      ...(item.id === undefined ? {} : { subject: item.id }),
      ...(item.remote === undefined ? {} : { keep: item.remote }),
    })),
    removed: merge.removed,
    send: merge.send,
    conflicts: merge.conflicts,
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
