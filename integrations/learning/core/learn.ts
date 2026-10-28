// @wc-ignore-file
import type { Mastery, SkillGraph, SkillState } from './types.js';

/** Level at which a skill counts as mastered when it names no threshold. */
export const DEFAULT_THRESHOLD = 0.8;

/**
 * The canonical ids the learner has mastered. A mastery level given for any
 * merged id counts for the whole node (the highest wins); ids the graph does
 * not know are ignored.
 */
export function masteredSet(graph: SkillGraph, mastery: Mastery): Set<string> {
  const level = new Map<string, number>();

  for (const [id, value] of mastery) {
    const node = graph.resolve(id);
    if (node !== undefined)
      level.set(node, Math.max(level.get(node) ?? 0, value));
  }

  const done = new Set<string>();
  for (const [id, value] of level)
    if (value >= (graph.nodes.get(id)!.threshold ?? DEFAULT_THRESHOLD))
      done.add(id);

  return done;
}

/**
 * Advice, not a gate. `locked` only means some prerequisite is not mastered
 * yet; a view must still let the learner open and study the skill. An id the
 * graph does not know is `available`.
 */
export function stateOf(
  graph: SkillGraph,
  mastered: ReadonlySet<string>,
  id: string,
): SkillState {
  const node = graph.nodes.get(graph.resolve(id) ?? id);
  if (!node) return 'available';
  if (mastered.has(node.id)) return 'mastered';

  return node.requires.every(r => mastered.has(r)) ? 'available' : 'locked';
}

/**
 * The outer fringe of the mastered set (knowledge space theory): the skills
 * not yet mastered whose prerequisites all are. In graph order.
 */
export function outerFringe(
  graph: SkillGraph,
  mastered: ReadonlySet<string>,
): string[] {
  return graph.order.filter(id => stateOf(graph, mastered, id) === 'available');
}

/**
 * What to learn to reach `goal`: the goal and its unmastered ancestors,
 * prerequisites first. A mastered skill ends the walk: what lies below it is
 * not needed. Empty when the goal is mastered or unknown.
 */
export function pathTo(
  graph: SkillGraph,
  mastered: ReadonlySet<string>,
  goal: string,
): string[] {
  const start = graph.resolve(goal);
  if (start === undefined || mastered.has(start)) return [];
  const need = new Set<string>([start]);
  const todo = [start];

  for (let id = todo.pop(); id !== undefined; id = todo.pop())
    for (const r of graph.nodes.get(id)!.requires)
      if (!mastered.has(r) && !need.has(r)) {
        need.add(r);
        todo.push(r);
      }

  return graph.order.filter(id => need.has(id));
}

/**
 * The next logical steps: with a goal, the skills on the way to it that can be
 * learned now; without, the whole outer fringe.
 */
export function nextSteps(
  graph: SkillGraph,
  mastered: ReadonlySet<string>,
  goal?: string,
): string[] {
  if (goal === undefined) return outerFringe(graph, mastered);

  return pathTo(graph, mastered, goal).filter(
    id => stateOf(graph, mastered, id) === 'available',
  );
}
