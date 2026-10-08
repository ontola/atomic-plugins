// @wc-ignore-file
// The catalog entry ontology/lenses/solid-bookmark-v1 is a declarative
// subset of this code lens (ontology-kit/LENSES.md): on every example the
// catalog publishes, the code lens must give the same rows.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IS_A, type AtomicResource } from 'devonian/atomic';
import {
  solidBookmarkTerms as t,
  solidBookmarkFromAtomic,
  solidBookmarkToAtomic,
  type ExpandedNode,
} from './index.js';

interface Example {
  source: ExpandedNode;
  target: Record<string, unknown>;
  edits?: {
    target: Record<string, unknown>;
    source?: ExpandedNode;
    error?: string;
  }[];
}
const lens = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../ontology/lenses/solid-bookmark-v1',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  source: { rdf: string };
  target: { class: string };
  examples: Example[];
};
/**
 * The code lens's message for each refusal code this catalog entry's
 * examples use. An edit with an error code not listed here fails the test,
 * so a new refusal in the catalog needs a matching one in the code lens.
 */
const refusals: Record<string, RegExp> = {};
const resource = (row: Record<string, unknown>) =>
  ({
    '@id': 'https://atomic.example/bookmarks/one',
    [IS_A]: [t.class],
    ...row,
  }) as AtomicResource;

describe('catalog lens solid-bookmark-v1 agrees with the code lens', () => {
  it('connects classes the code lens supports', () => {
    expect(t.rdfClasses).toContain(lens.source.rdf);
    expect(lens.target.class).toBe(t.class);
  });

  it.each(lens.examples.map((e, i) => [i + 1, e] as const))(
    'example %i',
    (_, example) => {
      const { [IS_A]: _isA, ...set } = solidBookmarkToAtomic(
        example.source,
      ).set!;
      expect(set).toEqual(example.target);

      for (const edit of example.edits ?? []) {
        const row = resource({ ...example.target, ...edit.target });

        if (edit.error === undefined)
          expect(solidBookmarkFromAtomic(row, example.source)).toEqual(
            edit.source,
          );
        else {
          expect(Object.keys(refusals)).toContain(edit.error);
          expect(() => solidBookmarkFromAtomic(row, example.source)).toThrow(
            refusals[edit.error],
          );
        }
      }
    },
  );
});
