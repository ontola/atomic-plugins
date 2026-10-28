// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph, pathTo, type SkillNode } from '../core/index.js';
import type { StarterTree } from '../app/starter.js';

const raw = readFileSync(
  new URL('./wiskunde-natuurkunde.json', import.meta.url),
  'utf8',
);
const tree = JSON.parse(raw) as StarterTree;
const nodes: SkillNode[] = tree.skills.map(s => ({
  id: s.key,
  equivalentTo: [],
  ...s,
}));

describe('starter tree: wiskunde en natuurkunde', () => {
  const graph = buildGraph(nodes);

  it('has no cycles and no references to missing skills', () => {
    expect(graph.ignored).toEqual([]);
    expect(graph.missing).toEqual([]);
    expect(graph.order).toHaveLength(tree.skills.length);
  });

  it('has about 30 uniquely keyed skills with a description each', () => {
    expect(tree.skills.length).toBeGreaterThanOrEqual(28);
    expect(new Set(tree.skills.map(s => s.key)).size).toBe(tree.skills.length);
    for (const s of tree.skills)
      expect(s.description.length).toBeGreaterThan(20);
  });

  it('covers the required mathematics and physics topics', () => {
    const keys = new Set(tree.skills.map(s => s.key));
    for (const key of [
      'rekenen',
      'breuken',
      'procenten',
      'algebra-basis',
      'vergelijkingen',
      'functies',
      'meetkunde',
      'trigonometrie',
      'exponenten-logaritmen',
      'afgeleiden',
      'integralen',
      'vectoren',
      'lineaire-algebra',
      'kans-statistiek',
      'eenheden-meten',
      'kinematica',
      'krachten-newton',
      'energie-arbeid',
      'impuls',
      'cirkelbeweging',
      'gravitatie',
      'trillingen-golven',
      'elektriciteit',
      'magnetisme',
      'thermodynamica',
      'optica',
      'quantum-intro',
      'relativiteit-intro',
    ])
      expect(keys.has(key), key).toBe(true);
  });

  it('uses requires for hard prerequisites and recommends for soft ones', () => {
    const byKey = new Map(tree.skills.map(s => [s.key, s]));
    expect(byKey.get('krachten-newton')!.requires).toEqual(
      expect.arrayContaining(['algebra-basis', 'vectoren']),
    );
    expect(byKey.get('energie-arbeid')!.requires).not.toContain('integralen');
    expect(byKey.get('energie-arbeid')!.recommends).toContain('integralen');
  });

  it('makes physics reachable from the first skill and plans a path to relativity', () => {
    const path = pathTo(graph, new Set(), 'relativiteit-intro');
    expect(path[0]).toBe('rekenen');
    expect(path.at(-1)).toBe('relativiteit-intro');
    expect(path).toContain('krachten-newton');
    expect(path).not.toContain('optica');
  });

  it('gives every skill one or two or three lessons that point at a known skill', () => {
    const keys = new Set(tree.skills.map(s => s.key));
    for (const l of tree.lessons) expect(keys.has(l.skill), l.skill).toBe(true);

    for (const key of keys) {
      const n = tree.lessons.filter(l => l.skill === key).length;
      expect(n, key).toBeGreaterThanOrEqual(1);
      expect(n, key).toBeLessThanOrEqual(3);
    }

    for (const l of tree.lessons)
      expect([
        'video',
        'text',
        'interactive',
        'exercise',
        'live',
        'tour',
      ]).toContain(l.format);
  });

  it('has no real lesson material yet: every content is an open TODO', () => {
    expect(tree.lessons.every(l => l.content === null)).toBe(true);
  });

  it('contains no em-dashes or en-dashes', () => {
    expect(raw).not.toMatch(/[–—]/);
  });
});
