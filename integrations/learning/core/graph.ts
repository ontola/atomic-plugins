// @wc-ignore-file
import type {
  GraphNode,
  IgnoredEdge,
  MissingRef,
  SkillGraph,
  SkillNode,
} from './types.js';

const sorted = (values: Iterable<string>) => [...values].sort();

/**
 * Builds the graph of several trees at once.
 *
 * - `equivalentTo` (in either direction, and transitively) merges nodes into
 *   one whose id is the smallest member id. A node's edges are the union of
 *   its members' edges. Its threshold is the strictest one given.
 * - A reference to an unknown id is dropped and listed in `missing`.
 * - A `requires` edge that closes a cycle (found depth first, in id order,
 *   so the result does not depend on input order) is dropped and listed in
 *   `ignored`. Nothing is thrown: a bad tree still renders.
 * - A skill listed twice keeps its first record.
 */
export function buildGraph(input: readonly SkillNode[]): SkillGraph {
  const records = new Map<string, SkillNode>();
  for (const node of input)
    if (!records.has(node.id)) records.set(node.id, node);

  const missing: MissingRef[] = [];
  const known = (from: string, kind: MissingRef['kind'], ids: string[]) =>
    ids.filter(to => {
      if (records.has(to)) return true;
      missing.push({ from, to, kind });

      return false;
    });

  // Union-find over equivalence, rooted at the smallest id.
  const parent = new Map<string, string>(
    [...records.keys()].map(id => [id, id]),
  );

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);

    return root;
  };

  const union = (a: string, b: string) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };

  for (const id of sorted(records.keys()))
    for (const other of known(
      id,
      'equivalentTo',
      records.get(id)!.equivalentTo,
    ))
      union(id, other);

  // Merge members into canonical nodes.
  const members = new Map<string, string[]>();

  for (const id of sorted(records.keys())) {
    const root = find(id);
    members.set(root, [...(members.get(root) ?? []), id]);
  }

  const edges = new Map<
    string,
    { requires: Set<string>; recommends: Set<string> }
  >();
  const nodes = new Map<string, GraphNode>();

  for (const [id, ids] of members) {
    const records_ = ids.map(m => records.get(m)!);
    const requires = new Set<string>();
    const recommends = new Set<string>();

    for (const record of records_) {
      for (const to of known(record.id, 'requires', record.requires))
        requires.add(find(to));
      for (const to of known(record.id, 'recommends', record.recommends))
        recommends.add(find(to));
    }

    const thresholds = records_.flatMap(r =>
      r.threshold === undefined ? [] : [r.threshold],
    );
    const first = records_[0]!;
    nodes.set(id, {
      id,
      ids,
      name: first.name,
      ...(records_.find(r => r.description)?.description
        ? { description: records_.find(r => r.description)!.description }
        : {}),
      requires: [],
      recommends: [],
      ...(thresholds.length ? { threshold: Math.max(...thresholds) } : {}),
      ...(first.level === undefined ? {} : { level: first.level }),
    });
    edges.set(id, { requires, recommends });
  }

  // Cycle detection on `requires`, iterative so a long chain cannot overflow.
  const ignored: IgnoredEdge[] = [];
  const order: string[] = [];
  const state = new Map<string, 'open' | 'done'>();
  const kept = new Map<string, string[]>();

  for (const start of sorted(nodes.keys())) {
    if (state.has(start)) continue;
    const path: string[] = [start];
    const todo: string[][] = [sorted(edges.get(start)!.requires)];
    state.set(start, 'open');
    kept.set(start, []);

    while (path.length) {
      const pending = todo[todo.length - 1]!;
      const at = path[path.length - 1]!;
      const next = pending.shift();

      if (next === undefined) {
        state.set(at, 'done');
        order.push(at);
        path.pop();
        todo.pop();
        continue;
      }

      if (state.get(next) === 'open') {
        ignored.push({
          from: at,
          to: next,
          cycle: [...path.slice(path.indexOf(next)), next],
        });
        continue;
      }

      kept.get(at)!.push(next);
      if (state.get(next) === 'done') continue;
      state.set(next, 'open');
      kept.set(next, []);
      path.push(next);
      todo.push(sorted(edges.get(next)!.requires));
    }
  }

  const dependents = new Map<string, string[]>(
    [...nodes.keys()].map(id => [id, []]),
  );

  for (const [id, node] of nodes) {
    node.requires = sorted(kept.get(id)!);
    node.recommends = sorted(edges.get(id)!.recommends).filter(
      to => to !== id && !node.requires.includes(to),
    );
    for (const to of node.requires) dependents.get(to)!.push(id);
  }

  for (const list of dependents.values()) list.sort();

  return {
    nodes,
    order,
    dependents,
    ignored,
    missing,
    resolve: id => (records.has(id) ? find(id) : undefined),
  };
}

/** Longest `requires` chain below each skill: roots are 0. For layering a drawing. */
export function depths(graph: SkillGraph): Map<string, number> {
  const depth = new Map<string, number>();
  for (const id of graph.order)
    depth.set(
      id,
      Math.max(-1, ...graph.nodes.get(id)!.requires.map(r => depth.get(r)!)) +
        1,
    );

  return depth;
}

/**
 * Skills grouped by depth, each layer ordered to keep edges short (one
 * barycenter sweep from the left, ties by name). Layout only: it says nothing
 * about what to learn.
 */
export function layers(graph: SkillGraph): string[][] {
  const depth = depths(graph);
  const out: string[][] = [];
  for (const id of graph.order) (out[depth.get(id)!] ??= []).push(id);
  const slot = new Map<string, number>();
  const name = (id: string) => graph.nodes.get(id)!.name;

  out.forEach((layer, index) => {
    const key = (id: string) => {
      const rs = graph.nodes.get(id)!.requires.map(r => slot.get(r)!);

      return rs.length
        ? rs.reduce((a, b) => a + b, 0) / rs.length
        : Number.MAX_SAFE_INTEGER;
    };

    if (index === 0) layer.sort((a, b) => name(a).localeCompare(name(b)));
    else
      layer.sort((a, b) => key(a) - key(b) || name(a).localeCompare(name(b)));
    layer.forEach((id, i) => slot.set(id, i));
  });

  return out.map(layer => layer ?? []);
}
