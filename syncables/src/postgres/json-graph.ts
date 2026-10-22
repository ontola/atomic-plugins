import { createHash } from 'node:crypto';

/** Version 1: compact JSON tuples, UTF-16 key order, number lexemes retained. */
export type GraphValue =
  | ['null']
  | ['boolean', boolean]
  | ['string', string]
  | ['number', string]
  | ['ref', string];
export type GraphNode = [
  'syncables-json-node',
  1,
  'object' | 'array' | 'scalar',
  [string, GraphValue][] | GraphValue[] | GraphValue,
];
export interface JsonGraph {
  root: string;
  nodes: Map<string, string>;
}
export interface GraphLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}
export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 100_000,
};

export function nodeHash(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** Parses JSON before Number coercion; duplicate keys are refused explicitly. */
export function indexJson(
  source: string,
  limits: Partial<GraphLimits> = {},
): JsonGraph {
  const bound = { ...DEFAULT_GRAPH_LIMITS, ...limits };
  for (const value of Object.values(bound))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('Invalid JSON graph limits');
  if (Buffer.byteLength(source, 'utf8') > bound.maxBytes)
    throw new Error('JSON graph exceeds byte limit');
  let at = 0;
  let count = 0;
  const nodes = new Map<string, string>();
  const fail = (): never => {
    throw new Error('Invalid or duplicate-key JSON for graph indexing');
  };
  const space = (): void => {
    while (/[\x20\t\r\n]/.test(source[at] ?? '') && at < source.length) at++;
  };
  const string = (): string => {
    const start = at;
    if (source[at++] !== '"') return fail();
    while (at < source.length) {
      const c = source[at++];
      if (c === '\\') at++;
      else if (c === '"') {
        try {
          return JSON.parse(source.slice(start, at)) as string;
        } catch {
          return fail();
        }
      }
    }
    return fail();
  };
  const save = (kind: GraphNode[2], content: GraphNode[3]): GraphValue => {
    const bytes = JSON.stringify(['syncables-json-node', 1, kind, content]);
    const hash = nodeHash(bytes);
    nodes.set(hash, bytes);
    return ['ref', hash];
  };
  const value = (depth: number): GraphValue => {
    if (depth > bound.maxDepth || ++count > bound.maxNodes)
      throw new Error('JSON graph exceeds depth or value limit');
    space();
    const c = source[at];
    if (c === '"') return ['string', string()];
    if (c === '{' || c === '[') {
      at++;
      space();
      const object = c === '{';
      const end = object ? '}' : ']';
      const entries: [string, GraphValue][] = [];
      const items: GraphValue[] = [];
      const keys = new Set<string>();
      if (source[at] !== end)
        for (;;) {
          space();
          if (object) {
            const key = string();
            if (keys.has(key)) return fail();
            keys.add(key);
            space();
            if (source[at++] !== ':') return fail();
            entries.push([key, value(depth + 1)]);
          } else items.push(value(depth + 1));
          space();
          if (source[at] === end) break;
          if (source[at++] !== ',') return fail();
        }
      at++;
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return save(object ? 'object' : 'array', object ? entries : items);
    }
    for (const [literal, result] of [
      ['null', ['null']],
      ['true', ['boolean', true]],
      ['false', ['boolean', false]],
    ] as [string, GraphValue][])
      if (source.startsWith(literal, at)) {
        at += literal.length;
        return result;
      }
    const number = source
      .slice(at)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) return fail();
    at += number[0].length;
    return ['number', number[0]];
  };
  const root = value(0);
  space();
  if (at !== source.length) return fail();
  const ref = root[0] === 'ref' ? root : save('scalar', root);
  return { root: ref[1] as string, nodes };
}

/** Reconstructs equivalent JSON text, retaining numbers outside JS precision. */
export async function renderJson(
  root: string,
  load: (hash: string) => Promise<string>,
  limits: Partial<GraphLimits> = {},
): Promise<string> {
  const bound = { ...DEFAULT_GRAPH_LIMITS, ...limits };
  let count = 0;
  let bytes = 0;
  const piece = (text: string): string => {
    bytes += Buffer.byteLength(text);
    if (bytes > bound.maxBytes)
      throw new Error('Expanded JSON exceeds byte limit');
    return text;
  };
  const render = async (value: GraphValue, depth: number): Promise<string> => {
    if (depth > bound.maxDepth || ++count > bound.maxNodes)
      throw new Error('Expanded JSON exceeds depth or value limit');
    if (value[0] === 'ref') {
      const hash = value[1];
      if (!/^[a-f0-9]{64}$/.test(hash))
        throw new Error('Invalid graph reference');
      const stored = await load(hash);
      if (
        Buffer.byteLength(stored) > bound.maxBytes ||
        nodeHash(stored) !== hash
      )
        throw new Error('JSON node checksum or size mismatch');
      const node = JSON.parse(stored) as GraphNode;
      if (node[0] !== 'syncables-json-node' || node[1] !== 1)
        throw new Error('Unsupported JSON graph encoding');
      if (node[2] === 'scalar') return render(node[3] as GraphValue, depth + 1);
      const parts: string[] = [];
      if (node[2] === 'object') {
        piece('{');
        for (const [key, child] of node[3] as [string, GraphValue][]) {
          if (parts.length) piece(',');
          const prefix = piece(JSON.stringify(key) + ':');
          parts.push(prefix + (await render(child, depth + 1)));
        }
        piece('}');
        return '{' + parts.join(',') + '}';
      }
      if (node[2] !== 'array') throw new Error('Invalid graph node kind');
      piece('[');
      for (const child of node[3] as GraphValue[]) {
        if (parts.length) piece(',');
        parts.push(await render(child, depth + 1));
      }
      piece(']');
      return '[' + parts.join(',') + ']';
    }
    if (value[0] === 'null') return piece('null');
    if (value[0] === 'boolean' || value[0] === 'string')
      return piece(JSON.stringify(value[1]));
    if (
      value[0] === 'number' &&
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value[1])
    )
      return piece(value[1]);
    throw new Error('Invalid graph scalar');
  };
  return render(['ref', root], 0);
}
