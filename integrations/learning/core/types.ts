// @wc-ignore-file
/**
 * The vocabulary of the learning core. Plain data and promises: nothing here
 * knows about Atomic, the DOM or any provider. An adapter turns its own
 * records (Atomic rows, ESCO, CASE, xAPI) into these shapes.
 */

/** One unit of knowledge. Ids are opaque strings; the core only compares them. */
export interface SkillNode {
  id: string;
  name: string;
  description?: string;
  /** Hard prerequisites. Advisory: a view may dim a skill, never refuse it. */
  requires: string[];
  /** Soft hints, never needed. */
  recommends: string[];
  /** The same skill under other ids (another tree, another source). */
  equivalentTo: string[];
  /** Mastery level (0..1) that counts as mastered; `DEFAULT_THRESHOLD` if absent. */
  threshold?: number;
  /** Rough difficulty, for layout and filters only. */
  level?: number;
}

/** Where a tree comes from. One call returns every node the source knows. */
export interface SkillSource {
  readSkills(): Promise<SkillNode[]>;
}

/** What a learner has shown, as a level from 0 to 1 per skill id. */
export type Mastery = ReadonlyMap<string, number>;

/** Where a learner's mastery comes from. */
export interface MasterySource {
  readMastery(): Promise<Mastery>;
}

/** Mastered, ready to learn, or advice-only "not yet": locked never blocks anything. */
export type SkillState = 'mastered' | 'available' | 'locked';

/** A merged skill: one or more source ids that count as the same knowledge. */
export interface GraphNode {
  /** Canonical id: the smallest member id. */
  id: string;
  name: string;
  description?: string;
  /** Every source id merged into this node, sorted. */
  ids: string[];
  /** Canonical ids, sorted, without cycles, missing nodes or self references. */
  requires: string[];
  recommends: string[];
  threshold?: number;
  level?: number;
}

/** A `requires` edge that closed a cycle. It is left out of the graph. */
export interface IgnoredEdge {
  from: string;
  to: string;
  /** The nodes on the cycle, starting and ending at `to`. */
  cycle: string[];
}

/** A reference to an id no source knows. The reference is left out. */
export interface MissingRef {
  from: string;
  to: string;
  kind: 'requires' | 'recommends' | 'equivalentTo';
}

export interface SkillGraph {
  nodes: ReadonlyMap<string, GraphNode>;
  /** Canonical ids, prerequisites before the skills that need them. */
  order: string[];
  /** Skills that list this one in `requires`, per canonical id. */
  dependents: ReadonlyMap<string, string[]>;
  /** Problems found while building. Reported, never thrown. */
  ignored: IgnoredEdge[];
  missing: MissingRef[];
  /** Canonical id for any known source id, or undefined for an unknown one. */
  resolve(id: string): string | undefined;
}
