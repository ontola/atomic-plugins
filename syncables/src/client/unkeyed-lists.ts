/**
 * CRUD Causality 0.7.0 §4.9: lists whose items have no identity
 * (`unkeyedLists` on the CRUD Resource Object), and a three-way merge of
 * such a list. Pure: the consumer keeps the baseline (the list as both
 * sides had it at the last sync), its own items with their ids, and reads
 * the remote list; `mergeUnkeyedList` says what the list becomes.
 *
 * Three versions of the list meet:
 *
 * - the **baseline**, as both sides had it at the last sync;
 * - the **local** items, which carry their own ids and the index of the
 *   baseline item each was at the last sync (none for an item added here);
 * - the **remote** items now, which carry no id. `pairItems` pairs them
 *   with the baseline's on the declared `match` fields and by position
 *   (§4.9.2; a port of the spec's `pair_items`, keep them in step).
 *
 * Then every item is merged field by field, and the order as moves:
 *
 * - a field changed on one side takes that side's value;
 * - a field changed on both sides to different values keeps the local
 *   value, and is counted in `conflicts`;
 * - an item deleted on one side and edited on the other stays;
 * - an item moved on one side keeps the position that side gave it;
 * - an item added on either side is added, after the item it followed.
 *
 * So an item moved remotely and ticked locally comes out moved and
 * ticked. Nesting is one level, as `children` says (§4.9.1).
 */
import type { OpenApiDocument } from '../openapi/types.js';
import { splitPath } from '../pagination/response-parser.js';
import { sameJson, valueAt, wellFormed } from './replace.js';

export interface UnkeyedList {
  /** Dot-paths into an item, most telling first. */
  match: string[];
  /** Dot-path into an item to its child items, one level. */
  children?: string;
}

/** An item in list order, without its children; `depth` 1 is under the nearest depth-0 item before it. */
export interface FlatListItem {
  value: Record<string, unknown>;
  depth: 0 | 1;
}

/** A local item: its own id, its value, the item it is under, its position. */
export interface LocalListItem {
  id: string;
  value: Record<string, unknown>;
  /** The local item this one is under, if any. */
  under?: string;
  position: number;
  /** The index of the baseline item (flattened) this one was at the last sync. */
  base?: number;
}

export interface MergedListItem extends FlatListItem {
  /** The local item's id, or none for an item to create locally. */
  id?: string;
  /** The index of its remote counterpart now (flattened), if it has one. */
  remote?: number;
}

export interface UnkeyedListMerge {
  /** The merged list, in order. */
  items: MergedListItem[];
  /** Local items whose item is gone from the merged list. */
  removed: string[];
  /** Whether the merged list differs from the remote one: it must be sent. */
  send: boolean;
  /** Fields changed on both sides to different values (the local value kept). */
  conflicts: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A resource's `unkeyedLists`, by the list field's dot-path; empty when it
 * declares none, `{ refused }` naming the first rule-29 problem.
 */
export function unkeyedListsOf(
  document: OpenApiDocument,
  resource: string,
): Record<string, UnkeyedList> | { refused: string } {
  const resources = document.components?.['crudResources'];
  const declared = isRecord(resources) ? resources[resource] : undefined;
  if (!isRecord(declared) || !('unkeyedLists' in declared)) return {};
  const lists = declared['unkeyedLists'];
  if (!isRecord(lists))
    return { refused: 'unkeyedLists: expected an object (rule 29)' };
  const out: Record<string, UnkeyedList> = {};

  for (const [key, spec] of Object.entries(lists)) {
    const at = `unkeyedLists.${key}`;
    if (!wellFormed(key))
      return { refused: `${at}: the key is not a dot-path (rule 29)` };
    if (!isRecord(spec))
      return { refused: `${at}: expected an object (rule 29)` };
    const match = spec['match'];
    if (
      !Array.isArray(match) ||
      !match.length ||
      !match.every((m) => typeof m === 'string' && wellFormed(m)) ||
      new Set(match).size !== match.length
    )
      return {
        refused: `${at}.match: expected a nonempty array of distinct dot-paths (rule 29)`,
      };
    const children = spec['children'];
    if (
      children !== undefined &&
      (typeof children !== 'string' ||
        !wellFormed(children) ||
        match.includes(children))
    )
      return {
        refused: `${at}.children: expected a dot-path that is not a match field (rule 29)`,
      };
    out[key] = {
      match: match as string[],
      ...(children === undefined ? {} : { children }),
    };
  }

  return out;
}

/** A copy of `value` without the field at `path`. */
function without(
  value: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const [head, ...rest] = splitPath(path);
  if (head === undefined || !(head in value)) return value;
  const copy = { ...value };
  const inner = copy[head];
  if (rest.length && isRecord(inner))
    copy[head] = without(inner, rest.join('.'));
  else delete copy[head];

  return copy;
}

/** A copy of `value` with `field` at `path`. */
function withField(
  value: Record<string, unknown>,
  path: string,
  field: unknown,
): Record<string, unknown> {
  const [head, ...rest] = splitPath(path);
  if (head === undefined) return value;
  const inner = value[head];

  return {
    ...value,
    [head]: rest.length
      ? withField(isRecord(inner) ? inner : {}, rest.join('.'), field)
      : field,
  };
}

/** A list as the API has it, flattened: each child right after its parent. */
export function flattenList(items: unknown, spec: UnkeyedList): FlatListItem[] {
  const out: FlatListItem[] = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (!isRecord(item)) continue;
    const value = spec.children ? without(item, spec.children) : item;
    out.push({ value, depth: 0 });
    const children = spec.children ? valueAt(item, spec.children) : undefined;

    for (const child of Array.isArray(children) ? children : [])
      if (isRecord(child))
        out.push({
          value: spec.children ? without(child, spec.children) : child,
          depth: 1,
        });
  }

  return out;
}

/** A flat list back as the API nests it; a child with no item above it becomes a top item. */
export function nestList(
  items: FlatListItem[],
  spec: UnkeyedList,
): Record<string, unknown>[] {
  const tops: { value: Record<string, unknown>; children: unknown[] }[] = [];

  for (const item of items) {
    const parent = tops.at(-1);
    if (item.depth === 1 && parent && spec.children)
      parent.children.push(item.value);
    else tops.push({ value: item.value, children: [] });
  }

  return tops.map(({ value, children }) =>
    spec.children && children.length
      ? withField(value, spec.children, children)
      : value,
  );
}

/** Each item's parent index (top items: -1). */
const parents = (items: FlatListItem[]): number[] => {
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
 * §4.9.2: for each remote item, the index of the baseline item it is, or
 * undefined for an item added remotely. Equal on every `match` field
 * first, then on the first (among equal candidates the nearest index
 * wins), then by position: an unpaired item between two paired neighbours
 * takes the first unpaired baseline item between theirs.
 */
export function pairItems(
  spec: UnkeyedList,
  base: FlatListItem[],
  remote: FlatListItem[],
): (number | undefined)[] {
  const out: (number | undefined)[] = remote.map(() => undefined);
  const taken = new Set<number>();
  const equalOn =
    (fields: string[]) =>
    (b: FlatListItem, r: FlatListItem): boolean =>
      fields.every((f) => sameJson(valueAt(b.value, f), valueAt(r.value, f)));

  for (const same of [equalOn(spec.match), equalOn(spec.match.slice(0, 1))])
    remote.forEach((r, ri) => {
      if (out[ri] !== undefined) return;
      let best: number | undefined;

      base.forEach((b, bi) => {
        if (taken.has(bi) || !same(b, r)) return;
        if (best === undefined || Math.abs(bi - ri) < Math.abs(best - ri))
          best = bi;
      });

      if (best !== undefined) {
        out[ri] = best;
        taken.add(best);
      }
    });

  remote.forEach((_, ri) => {
    if (out[ri] !== undefined) return;
    let before = -1;
    let after = base.length;

    for (let p = ri - 1; p >= 0; p--) {
      const paired = out[p];
      if (paired !== undefined) {
        before = paired;
        break;
      }
    }

    for (let n = ri + 1; n < remote.length; n++) {
      const paired = out[n];
      if (paired !== undefined) {
        after = paired;
        break;
      }
    }

    for (let bi = before + 1; bi < after; bi++)
      if (!taken.has(bi)) {
        out[ri] = bi;
        taken.add(bi);
        break;
      }
  });

  return out;
}

/** The ids of `seq` on a longest common subsequence with `other`. */
function stayed(seq: string[], other: string[]): Set<string> {
  const common = new Set(other);
  const a = seq.filter((id) => common.has(id));
  const inA = new Set(a);
  const b = other.filter((id) => inA.has(id));
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  const cell = (i: number, j: number): number => table[i]?.[j] ?? 0;

  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] =
        a[i] === b[j]
          ? cell(i + 1, j + 1) + 1
          : Math.max(cell(i + 1, j), cell(i, j + 1));

  const out = new Set<string>();
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.add(a[i]!);
      i++;
      j++;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) i++;
    else j++;
  }

  return out;
}

interface Entry {
  key: string;
  id?: string;
  value: Record<string, unknown>;
  /** The entry this one is under, by key. */
  under?: string;
  remote?: number;
}

/** Three-way on one value: the side that changed wins; both changed, the local one. */
function pick<T>(base: T, mine: T, theirs: T, conflict: () => void): T {
  if (sameJson(mine, base)) return theirs;
  if (sameJson(theirs, base) || sameJson(theirs, mine)) return mine;
  conflict();

  return mine;
}

/** Three-way per top-level field of an item's value. */
function mergeValue(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
  conflict: () => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.keys(base),
    ...Object.keys(mine),
    ...Object.keys(theirs),
  ]);

  for (const key of keys) {
    const value = pick(base[key], mine[key], theirs[key], conflict);
    if (value !== undefined) out[key] = value;
  }

  return out;
}

const byPosition = (a: LocalListItem, b: LocalListItem): number =>
  a.position - b.position || a.id.localeCompare(b.id);

/**
 * The merge of one list. `base` is the baseline (empty for a list never
 * synced), `local` the local items, `remote` the list now; `base` and
 * `remote` flattened with `flattenList`.
 */
export function mergeUnkeyedList({
  spec,
  base,
  local,
  remote,
}: {
  spec: UnkeyedList;
  base: FlatListItem[];
  local: LocalListItem[];
  remote: FlatListItem[];
}): UnkeyedListMerge {
  let conflicts = 0;
  const conflict = (): void => {
    conflicts++;
  };

  // Local items by baseline index; one whose index is out of range or
  // claimed twice counts as added here.
  const sorted = [...local].sort(byPosition);
  const known = new Map<number, LocalListItem>();
  const added: LocalListItem[] = [];

  for (const item of sorted) {
    if (
      item.base !== undefined &&
      Number.isInteger(item.base) &&
      item.base >= 0 &&
      item.base < base.length &&
      !known.has(item.base)
    )
      known.set(item.base, item);
    else added.push(item);
  }

  const paired = pairItems(spec, base, remote);
  const remoteOf = new Map<number, number>();
  paired.forEach((bi, ri) => {
    if (bi !== undefined) remoteOf.set(bi, ri);
  });

  const baseParent = parents(base);
  const remoteParent = parents(remote);
  const keyOfBase = (bi: number): string => `b${bi}`;
  const keyOfRemote = (ri: number): string => {
    const bi = paired[ri];

    return bi === undefined ? `r${ri}` : keyOfBase(bi);
  };
  const keyOfLocal = new Map<string, string>();
  for (const [bi, item] of known) keyOfLocal.set(item.id, keyOfBase(bi));
  for (const item of added) keyOfLocal.set(item.id, `l${item.id}`);

  const entries = new Map<string, Entry>();

  base.forEach((b, bi) => {
    const mine = known.get(bi);
    const ri = remoteOf.get(bi);
    const theirs = ri === undefined ? undefined : remote[ri];
    const baseUnder =
      baseParent[bi] === -1 ? undefined : keyOfBase(baseParent[bi]!);
    const mineUnder = mine?.under ? keyOfLocal.get(mine.under) : undefined;
    const theirUnder =
      ri === undefined || remoteParent[ri] === -1
        ? undefined
        : keyOfRemote(remoteParent[ri]!);
    const key = keyOfBase(bi);

    if (!mine && !theirs) return;

    if (!mine) {
      // Deleted here: gone, unless changed remotely meanwhile.
      if (sameJson(theirs!.value, b.value)) return;
      entries.set(key, {
        key,
        value: theirs!.value,
        ...(theirUnder ? { under: theirUnder } : {}),
        ...(ri === undefined ? {} : { remote: ri }),
      });

      return;
    }

    if (!theirs) {
      // Deleted remotely: gone, unless changed here meanwhile.
      if (sameJson(mine.value, b.value)) return;
      entries.set(key, {
        key,
        id: mine.id,
        value: mine.value,
        ...(mineUnder ? { under: mineUnder } : {}),
      });

      return;
    }

    const under = pick(baseUnder, mineUnder, theirUnder, conflict);
    entries.set(key, {
      key,
      id: mine.id,
      value: mergeValue(b.value, mine.value, theirs.value, conflict),
      ...(under ? { under } : {}),
      ...(ri === undefined ? {} : { remote: ri }),
    });
  });

  for (const item of added) {
    const key = `l${item.id}`;
    const under = item.under ? keyOfLocal.get(item.under) : undefined;
    entries.set(key, {
      key,
      id: item.id,
      value: item.value,
      ...(under ? { under } : {}),
    });
  }

  remote.forEach((r, ri) => {
    if (paired[ri] !== undefined) return;
    const key = `r${ri}`;
    const under =
      remoteParent[ri] === -1 ? undefined : keyOfRemote(remoteParent[ri]!);
    entries.set(key, {
      key,
      value: r.value,
      ...(under ? { under } : {}),
      remote: ri,
    });
  });

  // Order: the local one, with the remote moves and additions put in after
  // the item they follow remotely.
  const baseSeq = base.map((_, bi) => keyOfBase(bi));
  const localSeq = sorted.map((item) => keyOfLocal.get(item.id)!);
  const remoteSeq = remote.map((_, ri) => keyOfRemote(ri));
  const remoteStayed = stayed(
    baseSeq.filter((key) => remoteSeq.includes(key)),
    remoteSeq,
  );
  const localStayed = stayed(
    baseSeq.filter((key) => localSeq.includes(key)),
    localSeq,
  );
  const movedRemotely = (key: string): boolean =>
    key.startsWith('r') ||
    !localSeq.includes(key) ||
    (!remoteStayed.has(key) && localStayed.has(key));

  const order = localSeq.filter((key) => entries.has(key));

  for (const [at, key] of remoteSeq.entries()) {
    if (!entries.has(key) || !movedRemotely(key)) continue;
    const was = order.indexOf(key);
    if (was !== -1) order.splice(was, 1);
    let after = -1;

    for (let p = at - 1; p >= 0; p--) {
      const found = order.indexOf(remoteSeq[p]!);

      if (found !== -1) {
        after = found;
        break;
      }
    }

    order.splice(after + 1, 0, key);
  }

  for (const key of entries.keys()) if (!order.includes(key)) order.push(key);

  // Nesting: one level, a child right after its parent's other children.
  const isTop = (key: string): boolean => {
    const under = entries.get(key)!.under;

    return (
      !spec.children ||
      !under ||
      !entries.has(under) ||
      entries.get(under)!.under !== undefined
    );
  };
  const tops = order.filter(isTop);
  const flat: Entry[] = [];

  for (const key of tops) {
    flat.push(entries.get(key)!);

    for (const child of order)
      if (!isTop(child) && entries.get(child)!.under === key)
        flat.push(entries.get(child)!);
  }

  const items: MergedListItem[] = flat.map((e) => ({
    value: e.value,
    depth: isTop(e.key) ? 0 : 1,
    ...(e.id === undefined ? {} : { id: e.id }),
    ...(e.remote === undefined ? {} : { remote: e.remote }),
  }));
  const kept = new Set(items.map((i) => i.id).filter(Boolean));
  const send =
    items.length !== remote.length ||
    items.some(
      (item, i) =>
        !sameJson(item.value, remote[i]!.value) ||
        item.depth !== remote[i]!.depth,
    );

  return {
    items,
    removed: local.map((item) => item.id).filter((id) => !kept.has(id)),
    send,
    conflicts,
  };
}
