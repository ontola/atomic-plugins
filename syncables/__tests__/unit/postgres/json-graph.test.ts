import { describe, expect, it } from 'vitest';
import {
  indexJson,
  renderJson,
  nodeHash,
} from '../../../src/postgres/json-graph.js';

const render = async (source: string): Promise<string> => {
  const graph = indexJson(source);
  return renderJson(graph.root, async (hash) => graph.nodes.get(hash)!);
};

describe('version-1 nested JSON graph', () => {
  it('shares every unchanged nested object across pages and key order', () => {
    const first = indexJson('{"b":{"name":"same"},"a":[{"name":"same"}]}');
    const reordered = indexJson(
      ' { "a": [{"name":"same"}], "b": {"name":"same"} } ',
    );
    expect(first.root).toBe(reordered.root);
    expect(first.nodes.size).toBe(3);
    const changed = indexJson('{"a":[{"name":"same"}],"b":{"name":"new"}}');
    expect(changed.root).not.toBe(first.root);
    expect(
      [...changed.nodes.keys()].filter((hash) => first.nodes.has(hash)),
    ).toHaveLength(2);
  });
  it('retains large and lexical numbers without Number coercion', async () => {
    const source = '[9007199254740993,1e400,-0,1.0,1e0]';
    expect(await render(source)).toBe(source);
    expect(indexJson('1').root).not.toBe(indexJson('1.0').root);
    expect(indexJson('[1,2]').root).not.toBe(indexJson('[2,1]').root);
  });
  it('separates literal $ref, null, strings, booleans and scalar roots', async () => {
    for (const source of [
      'null',
      'true',
      'false',
      '"null"',
      '{}',
      '[]',
      '{"$ref":"literal","__proto__":null}',
    ])
      expect(JSON.parse(await render(source))).toEqual(JSON.parse(source));
    expect(indexJson('null').root).not.toBe(indexJson('"null"').root);
  });
  it('rejects duplicate decoded keys and malformed JSON explicitly', () => {
    for (const source of [
      '{"x":1,"x":2}',
      '{"x":1,"\\u0078":2}',
      '[1,]',
      '{"a":1,}',
      '01',
      '1e',
      'NaN',
      'true false',
      '{"x":"\\x"}',
    ])
      expect(() => indexJson(source)).toThrow('JSON');
  });
  it('uses deterministic escaping, including lone surrogates', async () => {
    expect(indexJson('"a"').root).toBe(indexJson('"\\u0061"').root);
    const source = String.raw`{"\ud800":"\udfff","\n":"\"\\"}`;
    expect(JSON.parse(await render(source))).toEqual(JSON.parse(source));
  });
  it('bounds input, nesting, expansion, and validates node checksums', async () => {
    expect(() => indexJson('[[]]', { maxDepth: 1 })).not.toThrow();
    expect(() => indexJson('[[[]]]', { maxDepth: 1 })).toThrow('depth');
    expect(() => indexJson('[1,2]', { maxNodes: 2 })).toThrow('value limit');
    expect(() => indexJson('"abcd"', { maxBytes: 2 })).toThrow('byte limit');
    const graph = indexJson('[{"x":"big"},{"x":"big"}]');
    await expect(
      renderJson(graph.root, async (hash) => graph.nodes.get(hash)!, {
        maxNodes: 2,
      }),
    ).rejects.toThrow('value limit');
    await expect(renderJson(graph.root, async () => '[]')).rejects.toThrow(
      'checksum',
    );
  });
  it('freezes the tuple bytes for an empty object', () => {
    const graph = indexJson('{}');
    expect(graph.nodes.get(graph.root)).toBe(
      '["syncables-json-node",1,"object",[]]',
    );
    expect(graph.root).toBe(nodeHash('["syncables-json-node",1,"object",[]]'));
  });
});
