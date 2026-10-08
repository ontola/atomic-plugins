// @wc-ignore-file
// The catalog entry ontology/lenses/todoist-task-issue-v1 is a declarative
// subset of this code lens (ontology-kit/LENSES.md): on every example the
// catalog publishes, the code lens must give the same rows, and refuse the
// edits the catalog refuses.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IS_A, type AtomicResource } from 'devonian/atomic';
import {
  issueTerms as t,
  todoistFromAtomic,
  todoistToAtomic,
  type TodoistTask,
} from './index.js';

interface Example {
  source: TodoistTask;
  target: Record<string, unknown>;
  edits?: {
    target: Record<string, unknown>;
    source?: TodoistTask;
    error?: string;
  }[];
}
const lens = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../ontology/lenses/todoist-task-issue-v1',
      import.meta.url,
    ),
    'utf8',
  ),
) as { target: { class: string }; examples: Example[] };
/**
 * The code lens's message for each refusal code this catalog entry's
 * examples use. An edit with an error code not listed here fails the test,
 * so a new refusal in the catalog needs a matching one in the code lens.
 */
const refusals: Record<string, RegExp> = {
  'read-only': /^This lens is read-only$/,
};
const resource = (row: Record<string, unknown>) =>
  ({
    '@id': 'https://atomic.example/tasks/one',
    [IS_A]: [t.class],
    ...row,
  }) as AtomicResource;

describe('catalog lens todoist-task-issue-v1 agrees with the code lens', () => {
  it('targets the shared class the code lens writes', () => {
    expect(lens.target.class).toBe(t.class);
  });

  it.each(lens.examples.map((e, i) => [i + 1, e] as const))(
    'example %i',
    (_, example) => {
      const { [IS_A]: _isA, ...set } = todoistToAtomic(example.source).set!;
      expect(set).toEqual(example.target);

      for (const edit of example.edits ?? []) {
        // The code lens takes a whole row: fill in what the edit leaves out.
        const row = resource({ ...example.target, ...edit.target });

        if (edit.error === undefined)
          expect(todoistFromAtomic(row, example.source)).toEqual(edit.source);
        else {
          expect(Object.keys(refusals)).toContain(edit.error);
          expect(() => todoistFromAtomic(row, example.source)).toThrow(
            refusals[edit.error],
          );
        }
      }
    },
  );
});
