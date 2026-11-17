# Leerboom (learning tree)

A learning tree as an Atomic drive app: a graph of skills with the skills they
need, the lessons for each, and a per-learner answer to "what next?", worked
out from the learner's own mastery rows. Phases 1 and 2 of the design in
`leerboom/proposal.md`. Nothing here lives in `ontola/atomic-server`: the
classes are in the shared ontology, the code is a drive app.

Status: **declared, not verified.** Unit-tested against a fake host store and
jsdom. The host E2E (`e2e/learning.spec.ts`) is written but has not been run:
it needs an atomic-server build and network access to `ontola.github.io`. The
catalog entry is `enabled: false` and `experimental: true`.

## The layers

```
core/      pure TypeScript, no imports from Atomic or the DOM
  types.ts   SkillNode, SkillSource, MasterySource, SkillGraph, SkillState
  graph.ts   buildGraph (equivalence merge, cycles, missing), depths, layers
  learn.ts   masteredSet, stateOf, outerFringe, pathTo, nextSteps
app/       the Atomic side
  adapter.ts   rows of skill-v1 / lesson-v1 / mastery-v1 <-> core types
  controller.ts, view.ts, main.ts   state, plain DOM and SVG, view({root, store})
data/      wiskunde-natuurkunde.json: the starter tree (30 skills, 62 lessons)
e2e/       the host spec
```

The core knows ids and numbers. It never learns where a tree came from, so the
same functions serve an Atomic table, an ESCO import or a test fixture.

### What the core does

- `buildGraph(nodes)` merges nodes joined by `equivalentTo` (either direction,
  transitively) into one node whose id is the smallest member id. Edges are the
  union of the members' edges and the threshold is the strictest one given.
  Result: `nodes`, `order` (prerequisites first), `dependents`, `ignored`,
  `missing`, `resolve(id)`.
- Cycles in `requires` are **reported, never thrown**: the back edge found
  depth first in id order is dropped and listed in `ignored` with its cycle, so
  the result does not depend on input order. References to unknown ids are
  dropped and listed in `missing`. `recommends` never enters the hard graph.
- `masteredSet(graph, mastery)`: a skill is mastered at level >= its threshold
  (default 0.8). A level given for any merged id counts for the node.
- `stateOf` is `mastered | available | locked`. **Advisory only**: locked means
  "some prerequisite is not mastered yet". Nothing in the core or the view
  refuses to open or learn a locked skill.
- `outerFringe` (knowledge space theory): unmastered skills whose prerequisites
  are all mastered. `pathTo(goal)`: the goal and its unmastered ancestors in
  topological order; a mastered skill ends the walk. `nextSteps(goal?)`: the
  fringe, or the part of the path that can be learned now.

### The app

Add it as a view to any table of class `skill-v1` ("+ Add view"), or open it
on its own: the first open turns the app's own table into a `skill-v1` table
and adds the class to the App's `renders` (the same two steps as the Money
app). It makes two more tables under itself: `Lessons` (`lesson-v1`) and
`Mastery` (`mastery-v1`).

- **Tree**: layered left to right, prerequisites first, plain DOM buttons and
  one SVG for the edges. Mastered is green with a tick, available has a solid
  border, locked is dimmed with a dashed border. Every node is a button.
- **Detail panel**: description, state, the unmastered prerequisites as links
  ("Eerst aan te raden"), recommendations, lessons with an icon per format and
  their minutes, "Ik beheers dit" (and its undo), "Pad naar dit doel".
- **Next steps bar**: the outer fringe, or, with a goal, the steps toward it.
- **Laad startboom**: creates the starter skills (prerequisites first, so each
  `requires` is a subject) and lessons. Safe to press twice: a skill with the
  same name in the table is reused. On a skill table the app did not make it
  first asks for the host's "Allow editing" and writes nothing if refused.
- Strings are Dutch when the browser language starts with `nl`, otherwise
  English (`app/strings.ts`). No em-dashes in the Dutch text.

Mastery is one row per skill in the app's own `Mastery` table
(`mastery-skill`, `mastery-level` 0 or 1, `mastery-source` `self`,
`mastery-updated-at`). A drive app can only write under itself, so this needs
no grant. The table inherits the App's rights, so **install the app in a drive
that is yours**: private by default means "as private as that drive", and the
app does not set rights of its own.

## Plugging in another source

A source is anything that can answer `SkillSource.readSkills()`; a learner
record is anything that can answer `MasterySource.readMastery()` (a
`Map<skillId, level 0..1>`). Write an adapter that maps its own records and
hand the result to `buildGraph`:

```ts
const nodes = await mySource.readSkills(); // SkillNode[]
const graph = buildGraph(nodes); // the same call for every source
const done = masteredSet(graph, await myMastery.readMastery());
nextSteps(graph, done, goalId);
```

- **ESCO** (skills, occupations, `broaderSkill`, `essentialSkill`): ids are
  concept URIs; `essentialSkill`/`optionalSkill` map to `requires`/
  `recommends`; a skill listed under two pillars is connected with
  `equivalentTo`.
- **CASE (1EdTech)**: `CFItem` is a `SkillNode`; association types
  `isChildOf`/`precedes` map to `requires`, `isRelatedTo` to `recommends`,
  `exactMatchOf` to `equivalentTo`.
- **xAPI**: statements by the learner with a result score on an object that
  is a skill id are a `MasterySource` (take the latest or best `scaled`
  score). The core never stores xAPI; it only needs the levels.

Trees from different sources combine by listing them together and linking
equal skills with `equivalentTo`: there is no single canonical tree.

## Ontology

Release v2 of `ontology-kit/source.json` (`terms-v2.mjs`): `skill-v1`,
`lesson-v1`, `mastery-v1`. The property mapping to schema.org LRMI is in
[`ontology-kit/README.md`](../../ontology-kit/README.md#release-v2-learning-trees).
`lesson-format` and `mastery-source` are strings with a documented list of
values, because the kit has no enum constraint.

## Starter data

`data/wiskunde-natuurkunde.json`: 30 skills (15 mathematics, 15 physics) with Dutch descriptions in "you can" terms, real
`requires` and softer `recommends` (energy recommends integrals; Newton's laws
require algebra and vectors), and 62 placeholder lessons. **Every lesson's
`content` is null: a TODO.** No link was added that could not be verified as a
stable public resource. `data/data.test.ts` builds the tree with the core and
fails on a cycle, a missing reference or a dash in the text.

## Deliberately not done

- Assessments: questions, forms, attempts. A later ontology release.
- Credentials, attestation, Open Badges, xAPI export: mastery is self-reported
  and nobody vouches for it.
- Forgetting, uncertain mastery, spaced repetition (the core's mastery is a
  plain level).
- Suggest-for-non-writers (forks) and cross-drive trees beyond reading any
  skill table the person can open.
- An OR-prerequisite: model it with an intermediate skill and `equivalentTo`.
- A generic dependency-graph view for other classes.
- Real lesson material for the starter tree.

## Checks

```sh
node integrations/tooling/link-atomic-server.mjs
node integrations/tooling/run-lane.mjs learning --tier typecheck
node integrations/tooling/run-lane.mjs learning --tier unit
node integrations/tooling/run-lane.mjs learning --tier e2e   # needs the atomic-server build and network
node integrations/tooling/apps.mjs check --published origin/main
```
