// @wc-ignore-file
// The catalog entry ontology/lenses/raindrop-bookmark-v1 is a declarative
// subset of this code lens (ontology-kit/LENSES.md): on every example the
// catalog publishes, the code lens must give the same rows.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IS_A, type AtomicResource } from 'devonian/atomic';
import {
  bookmarkTerms as t,
  raindropFromAtomic,
  raindropToAtomic,
  type RaindropRecord,
} from './index.js';

interface Example {
  source: RaindropRecord;
  target: Record<string, unknown>;
  edits?: { target: Record<string, unknown>; source?: RaindropRecord }[];
}
const lens = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../ontology/lenses/raindrop-bookmark-v1',
      import.meta.url,
    ),
    'utf8',
  ),
) as { target: { class: string }; examples: Example[] };
const resource = (row: Record<string, unknown>) =>
  ({
    '@id': 'https://atomic.example/bookmarks/one',
    [IS_A]: [t.class],
    ...row,
  }) as AtomicResource;

describe('catalog lens raindrop-bookmark-v1 agrees with the code lens', () => {
  it('targets the class the code lens writes', () => {
    expect(lens.target.class).toBe(t.class);
  });

  it.each(lens.examples.map((e, i) => [i + 1, e] as const))(
    'example %i',
    (_, example) => {
      const { [IS_A]: _isA, ...set } = raindropToAtomic(example.source).set!;
      expect(set).toEqual(example.target);

      for (const edit of example.edits ?? [])
        if (edit.source)
          expect(
            raindropFromAtomic(resource(edit.target), example.source),
          ).toEqual(edit.source);
    },
  );
});
