// @wc-ignore-file
// The catalog entries ontology/lenses/todoist-task-issue-v<N> are
// declarative subsets of this code lens (ontology-kit/LENSES.md): on every
// example the catalog publishes, the code lens must give the same rows, and
// refuse what the catalog refuses.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IS_A, type AtomicResource } from 'devonian/atomic';
import {
  issueTerms as t,
  todoistFromAtomic,
  todoistToAtomic,
  type TodoistTask,
} from './index.js';

type Row = Record<string, unknown>;
interface Example {
  source: TodoistTask;
  target?: Row;
  error?: string;
  edits?: {
    direction?: 'backward';
    target?: Row;
    source?: TodoistTask;
    error?: string;
  }[];
}
const LENSES = ['todoist-task-issue-v1', 'todoist-task-issue-v2'];
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../../ontology/lenses/${name}`, import.meta.url),
      'utf8',
    ),
  ) as { target: { class: string }; examples: Example[] };
/**
 * The code lens's message for each refusal code the catalog entries'
 * examples use. A code not listed here fails the test, so a new refusal in
 * the catalog needs a matching one in the code lens.
 */
const refusals: Record<string, RegExp> = {
  'read-only': /^This lens is read-only$/,
  // Two of the code lens's checks back the catalog's two guards.
  'out-of-domain':
    /^(?:Deleted tasks require a deletion event, not a projection|Expected nonempty task content and a string description)$/,
};

const refused = (code: string, run: () => unknown) => {
  expect(Object.keys(refusals)).toContain(code);
  expect(run).toThrow(refusals[code]);
};

const resource = (row: Row) =>
  ({
    '@id': 'https://atomic.example/tasks/one',
    [IS_A]: [t.class],
    ...row,
  }) as AtomicResource;
/** The table row the code lens writes from a task, onto a previous row. */

function written(task: TodoistTask, previous: Row): Row {
  const patch = todoistToAtomic(task);
  const { [IS_A]: _isA, ...set } = patch.set!;
  const row: Row = { ...previous, ...set };
  for (const key of patch.unset ?? []) delete row[key];

  return row;
}

describe.each(LENSES)('catalog lens %s agrees with the code lens', name => {
  const lens = load(name);

  it('targets the shared class the code lens writes', () => {
    expect(lens.target.class).toBe(t.class);
  });

  it.each(lens.examples.map((e, i) => [i + 1, e] as const))(
    'example %i',
    (_, example) => {
      if (example.error !== undefined) {
        refused(example.error, () => todoistToAtomic(example.source));

        return;
      }

      expect(written(example.source, {})).toEqual(example.target);

      for (const edit of example.edits ?? []) {
        if (edit.direction === 'backward') {
          if (edit.error === undefined)
            expect(written(edit.source!, example.target!)).toEqual(edit.target);
          else refused(edit.error, () => todoistToAtomic(edit.source!));
          continue;
        }

        // The code lens takes a whole row: fill in what the edit leaves out.
        const row = resource({ ...example.target, ...edit.target });

        if (edit.error === undefined)
          expect(todoistFromAtomic(row, example.source)).toEqual(edit.source);
        else refused(edit.error, () => todoistFromAtomic(row, example.source));
      }
    },
  );
});
