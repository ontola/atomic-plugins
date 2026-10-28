// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  depths,
  layers,
  masteredSet,
  nextSteps,
  outerFringe,
  pathTo,
  stateOf,
  type Mastery,
  type SkillNode,
} from './index.js';

const skill = (
  id: string,
  requires: string[] = [],
  extra: Partial<SkillNode> = {},
): SkillNode => ({
  id,
  name: id.toUpperCase(),
  requires,
  recommends: [],
  equivalentTo: [],
  ...extra,
});

const known = (...ids: string[]): Mastery => new Map(ids.map(id => [id, 1]));

describe('buildGraph', () => {
  it('orders prerequisites before the skills that need them', () => {
    const g = buildGraph([skill('c', ['b']), skill('b', ['a']), skill('a')]);
    expect(g.order).toEqual(['a', 'b', 'c']);
    expect(g.dependents.get('a')).toEqual(['b']);
    expect(g.ignored).toEqual([]);
    expect(g.missing).toEqual([]);
  });

  it('handles a diamond: the shared root is listed once and comes first', () => {
    const g = buildGraph([
      skill('d', ['b', 'c']),
      skill('b', ['a']),
      skill('c', ['a']),
      skill('a'),
    ]);
    expect(g.order[0]).toBe('a');
    expect(g.order.at(-1)).toBe('d');
    expect(g.order).toHaveLength(4);
    expect(depths(g).get('d')).toBe(2);
    expect(layers(g)).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('reports a cycle and ignores the back edge instead of throwing', () => {
    const g = buildGraph([
      skill('a', ['c']),
      skill('b', ['a']),
      skill('c', ['b']),
    ]);
    expect(g.ignored).toHaveLength(1);
    expect(g.ignored[0]!.cycle[0]).toBe(g.ignored[0]!.cycle.at(-1));
    expect(g.order).toHaveLength(3);
    const edges = [...g.nodes.values()].reduce(
      (n, node) => n + node.requires.length,
      0,
    );
    expect(edges).toBe(2);
  });

  it('gives the same result whatever the input order', () => {
    const input = [skill('a', ['c']), skill('b', ['a']), skill('c', ['b'])];
    const a = buildGraph(input);
    const b = buildGraph([...input].reverse());
    expect(b.ignored).toEqual(a.ignored);
    expect(b.order).toEqual(a.order);
  });

  it('reports a self reference as a cycle', () => {
    const g = buildGraph([skill('a', ['a'])]);
    expect(g.ignored).toEqual([{ from: 'a', to: 'a', cycle: ['a', 'a'] }]);
    expect(g.nodes.get('a')!.requires).toEqual([]);
  });

  it('drops references to missing skills and lists them', () => {
    const g = buildGraph([
      skill('a', ['ghost'], {
        recommends: ['phantom'],
        equivalentTo: ['nobody'],
      }),
    ]);
    expect(g.missing).toEqual([
      { from: 'a', to: 'nobody', kind: 'equivalentTo' },
      { from: 'a', to: 'ghost', kind: 'requires' },
      { from: 'a', to: 'phantom', kind: 'recommends' },
    ]);
    expect(g.nodes.get('a')!.requires).toEqual([]);
    expect(stateOf(g, new Set(), 'a')).toBe('available');
  });

  it('merges equivalent skills across trees, in either direction', () => {
    const g = buildGraph([
      skill('wis/breuken', ['wis/delen']),
      skill('wis/delen'),
      skill('nat/breuken', ['nat/getallen'], { equivalentTo: ['wis/breuken'] }),
      skill('nat/getallen'),
      skill('nat/rekenen', ['nat/breuken']),
    ]);
    expect(g.nodes.size).toBe(4);
    expect(g.resolve('nat/breuken')).toBe('nat/breuken');
    expect(g.resolve('wis/breuken')).toBe('nat/breuken');
    expect(g.nodes.get('nat/breuken')!.ids).toEqual([
      'nat/breuken',
      'wis/breuken',
    ]);
    expect(g.nodes.get('nat/breuken')!.requires).toEqual([
      'nat/getallen',
      'wis/delen',
    ]);
    expect(g.nodes.get('nat/rekenen')!.requires).toEqual(['nat/breuken']);
  });

  it('merges equivalence transitively and takes the strictest threshold', () => {
    const g = buildGraph([
      skill('x', [], { equivalentTo: ['y'], threshold: 0.7 }),
      skill('y', [], { equivalentTo: ['z'], threshold: 0.9 }),
      skill('z'),
    ]);
    expect(g.nodes.size).toBe(1);
    expect(g.nodes.get('x')!.ids).toEqual(['x', 'y', 'z']);
    expect(g.nodes.get('x')!.threshold).toBe(0.9);
  });

  it('reports a cycle that only appears after merging', () => {
    const g = buildGraph([
      skill('a', ['b']),
      skill('b', [], { equivalentTo: ['c'] }),
      skill('c', ['a']),
    ]);
    expect(g.ignored.length).toBeGreaterThan(0);
    expect(g.order).toHaveLength(2);
  });

  it('keeps the first record of a duplicated id', () => {
    const g = buildGraph([
      skill('a', [], { name: 'First' }),
      skill('a', [], { name: 'Second' }),
    ]);
    expect(g.nodes.get('a')!.name).toBe('First');
  });

  it('keeps recommends out of the hard graph', () => {
    const g = buildGraph([
      skill('a', [], { recommends: ['b', 'a'] }),
      skill('b', [], { recommends: ['a'] }),
    ]);
    expect(g.ignored).toEqual([]);
    expect(g.nodes.get('a')!.recommends).toEqual(['b']);
    expect(stateOf(g, new Set(), 'a')).toBe('available');
  });
});

describe('state, fringe, paths', () => {
  // a -> b -> d, a -> c -> d, d -> e ; f stands alone
  const g = buildGraph([
    skill('a'),
    skill('b', ['a']),
    skill('c', ['a']),
    skill('d', ['b', 'c']),
    skill('e', ['d']),
    skill('f'),
  ]);

  it('is available for roots, locked behind unmastered requirements', () => {
    const none = new Set<string>();
    expect(stateOf(g, none, 'a')).toBe('available');
    expect(stateOf(g, none, 'b')).toBe('locked');
    expect(stateOf(g, none, 'nope')).toBe('available');
  });

  it('is mastered at the default threshold of 0.8, or the skill own', () => {
    expect(masteredSet(g, new Map([['a', 0.79]])).size).toBe(0);
    expect(masteredSet(g, new Map([['a', 0.8]])).has('a')).toBe(true);
    const strict = buildGraph([skill('s', [], { threshold: 0.95 })]);
    expect(masteredSet(strict, new Map([['s', 0.9]])).size).toBe(0);
    expect(masteredSet(g, new Map([['ghost', 1]])).size).toBe(0);
  });

  it('counts mastery of any merged id for the whole node', () => {
    const merged = buildGraph([
      skill('x', [], { equivalentTo: ['y'] }),
      skill('y'),
      skill('z', ['x']),
    ]);
    const done = masteredSet(merged, known('y'));
    expect(done.has('x')).toBe(true);
    expect(stateOf(merged, done, 'z')).toBe('available');
  });

  it('computes the outer fringe', () => {
    expect(outerFringe(g, new Set())).toEqual(
      expect.arrayContaining(['a', 'f']),
    );
    expect(outerFringe(g, new Set())).toHaveLength(2);
    expect(outerFringe(g, masteredSet(g, known('a')))).toEqual(
      expect.arrayContaining(['b', 'c', 'f']),
    );
    expect(outerFringe(g, masteredSet(g, known('a', 'b')))).not.toContain('d');
    expect(outerFringe(g, masteredSet(g, known('a', 'b', 'c')))).toContain('d');
  });

  it('plans a path of unmastered ancestors in topological order', () => {
    const path = pathTo(g, new Set(), 'e');
    expect(path).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e']));
    expect(path).toHaveLength(5);
    expect(path.indexOf('a')).toBeLessThan(path.indexOf('b'));
    expect(path.indexOf('b')).toBeLessThan(path.indexOf('d'));
    expect(path.indexOf('c')).toBeLessThan(path.indexOf('d'));
    expect(path.at(-1)).toBe('e');
    expect(path).not.toContain('f');
  });

  it('stops the path at mastered skills and is empty for a mastered goal', () => {
    const done = masteredSet(g, known('b', 'e'));
    // b is mastered, so d needs c and c needs a; b itself is not planned.
    expect(pathTo(g, done, 'd')).toEqual(['a', 'c', 'd']);
    expect(pathTo(g, done, 'e')).toEqual([]);
    expect(pathTo(g, done, 'ghost')).toEqual([]);
  });

  it('suggests only learnable steps on the way to a goal', () => {
    expect(nextSteps(g, new Set(), 'e')).toEqual(['a']);
    expect(nextSteps(g, masteredSet(g, known('a')), 'e').sort()).toEqual([
      'b',
      'c',
    ]);
    expect(nextSteps(g, new Set(), 'e')).not.toContain('f');
    expect(nextSteps(g, new Set()).sort()).toEqual(['a', 'f']);
  });

  it('is never blocked: a locked goal still has a path and steps', () => {
    expect(stateOf(g, new Set(), 'e')).toBe('locked');
    expect(pathTo(g, new Set(), 'e').length).toBeGreaterThan(0);
  });

  it('plans through equivalent skills of another tree', () => {
    const web = buildGraph([
      skill('wis/optellen'),
      skill('nat/rekenen', [], { equivalentTo: ['wis/optellen'] }),
      skill('nat/krachten', ['nat/rekenen']),
    ]);
    const done = masteredSet(web, known('wis/optellen'));
    expect(pathTo(web, done, 'nat/krachten')).toEqual(['nat/krachten']);
    expect(nextSteps(web, done, 'nat/krachten')).toEqual(['nat/krachten']);
  });
});

describe('sources', () => {
  it('lets an adapter feed the core through the two interfaces', async () => {
    const skills = { readSkills: async () => [skill('a'), skill('b', ['a'])] };
    const learner = { readMastery: async () => known('a') };
    const g = buildGraph(await skills.readSkills());
    const done = masteredSet(g, await learner.readMastery());
    expect(nextSteps(g, done)).toEqual(['b']);
  });
});
