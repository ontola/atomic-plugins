// @wc-ignore-file
// The catalog entries ontology/lenses/clockify-time-entry-v<N> are
// declarative subsets of this code lens (ontology-kit/LENSES.md): on every example the
// catalog publishes, the code lens must read the same values, write the same
// record, and refuse the edits the catalog refuses.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classes, properties } from '../../../../../ontology-kit/terms.mjs';
import { clockifyEntryLens } from './algebra.js';
import type { ClockifyTimeEntry } from './writeBack.js';

interface Example {
  source: ClockifyTimeEntry;
  target?: Record<string, unknown>;
  error?: string;
  edits?: {
    direction?: 'backward';
    target?: Record<string, unknown>;
    source?: ClockifyTimeEntry;
    error?: string;
  }[];
}
const LENSES = ['clockify-time-entry-v1', 'clockify-time-entry-v2'];
const load = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../../ontology/lenses/${name}`, import.meta.url),
      'utf8',
    ),
  ) as { target: { class: string }; examples: Example[] };
const NAME = 'https://atomicdata.dev/properties/name';
const START = properties['work-start'].subject;
const END = properties['work-end'].subject;
const BILLABLE = properties['work-billable'].subject;
/**
 * The code lens's message for each refusal code the catalog entries'
 * examples use. A code not listed here fails the test, so a new refusal in
 * the catalog needs a matching one in the code lens.
 */
const refusals: Record<string, RegExp> = {
  precision: /^Changed Clockify times require whole seconds$/,
  'out-of-domain': /^Lens requires a completed REGULAR entry$/,
};

const refused = (code: string, run: () => unknown) => {
  expect(Object.keys(refusals)).toContain(code);
  expect(run).toThrow(refusals[code]);
};

const code = clockifyEntryLens({
  now: Date.parse('2026-10-08T12:00:00Z'),
  projects: [{ id: 'project-1', name: 'One' }],
});

/** The code lens's view as a row of the catalog's mapped fields. */
function row(source: ClockifyTimeEntry) {
  const view = code.get(source);

  return {
    [NAME]: view.name,
    [START]: view.interval.start,
    [END]: view.interval.end,
    [BILLABLE]: view.billable,
  };
}

describe.each(LENSES)('catalog lens %s agrees with the code lens', name => {
  const lens = load(name);

  it('targets time-entry-v1', () => {
    expect(lens.target.class).toBe(classes['time-entry-v1'].subject);
  });

  it.each(lens.examples.map((e, i) => [i + 1, e] as const))(
    'example %i',
    (_, example) => {
      if (example.error !== undefined) {
        refused(example.error, () => code.get(example.source));

        return;
      }

      expect(row(example.source)).toEqual(example.target);

      for (const edit of example.edits ?? []) {
        // Backward: the table row written from a provider record is the
        // code lens's view of that record.
        if (edit.direction === 'backward') {
          if (edit.error === undefined)
            expect(row(edit.source!)).toEqual(edit.target);
          else refused(edit.error, () => code.get(edit.source!));
          continue;
        }

        const wanted = { ...example.target, ...edit.target };
        const view = {
          ...code.get(example.source),
          name: wanted[NAME] as string,
          interval: {
            start: wanted[START] as number,
            end: wanted[END] as number,
          },
          billable: wanted[BILLABLE] as boolean,
        };

        if (edit.error === undefined)
          expect(code.put(view, example.source)).toEqual(edit.source);
        else refused(edit.error, () => code.put(view, example.source));
      }
    },
  );
});
