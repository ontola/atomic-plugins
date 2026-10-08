// @wc-ignore-file
// The catalog entries ontology/lenses/raindrop-bookmark-v<N> are declarative
// subsets of this code lens (ontology-kit/LENSES.md): on every example the
// catalog publishes, the code lens must give the same rows, and refuse what
// the catalog refuses.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IS_A, type AtomicResource } from 'devonian/atomic';
import {
  bookmarkTerms as t,
  raindropFromAtomic,
  raindropToAtomic,
  type RaindropRecord,
} from './index.js';

type Row = Record<string, unknown>;
interface Example {
  source: RaindropRecord;
  target?: Row;
  error?: string;
  edits?: {
    direction?: 'backward';
    target: Row;
    source?: RaindropRecord;
    error?: string;
  }[];
}
const LENSES = ['raindrop-bookmark-v1', 'raindrop-bookmark-v2'];
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
  'out-of-domain': /^Raindrop requires a positive safe integer ID$/,
};

const refused = (code: string, run: () => unknown) => {
  expect(Object.keys(refusals)).toContain(code);
  expect(run).toThrow(refusals[code]);
};

const resource = (row: Row) =>
  ({
    '@id': 'https://atomic.example/bookmarks/one',
    [IS_A]: [t.class],
    ...row,
  }) as AtomicResource;
/** The table row the code lens writes from a record, onto a previous row. */

function written(record: RaindropRecord, previous: Row): Row {
  const patch = raindropToAtomic(record);
  const { [IS_A]: _isA, ...set } = patch.set!;
  const row: Row = { ...previous, ...set };
  for (const key of patch.unset ?? []) delete row[key];

  return row;
}

describe.each(LENSES)('catalog lens %s agrees with the code lens', name => {
  const lens = load(name);

  it('targets the class the code lens writes', () => {
    expect(lens.target.class).toBe(t.class);
  });

  it.each(lens.examples.map((e, i) => [i + 1, e] as const))(
    'example %i',
    (_, example) => {
      if (example.error !== undefined) {
        refused(example.error, () => raindropToAtomic(example.source));

        return;
      }

      expect(written(example.source, {})).toEqual(example.target);

      for (const edit of example.edits ?? []) {
        if (edit.direction === 'backward')
          expect(written(edit.source!, example.target!)).toEqual(edit.target);
        else if (edit.error === undefined)
          // A forward edit's target is the whole row; a missing field is a
          // removal, which the code lens reads the same way.
          expect(
            raindropFromAtomic(resource(edit.target), example.source),
          ).toEqual(edit.source);
        else
          refused(edit.error, () =>
            raindropFromAtomic(
              resource({ ...example.target, ...edit.target }),
              example.source,
            ),
          );
      }
    },
  );
});
