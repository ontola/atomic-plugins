// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { checkLensLaws } from 'devonian/lenses';
import { githubIssueLens } from './algebra.js';
import { project, STATUSES, type Issue } from './index.js';

describe('GitHub issue lens algebra prototype', () => {
  it('preserves null body, workflow label metadata and all other fields on a title edit', () => {
    const source = {
      number: 42,
      title: 'Before',
      body: null,
      state: 'open' as const,
      labels: ['bug', { name: 'ATOMIC:DOING', color: 'ff0000' }],
      assignees: [{ login: 'invented-user' }],
    };
    const updated = githubIssueLens.put(
      { ...project(source), title: 'After' },
      source,
    );
    expect(updated).toEqual({ ...source, title: 'After' });
    expect(source.title).toBe('Before');
  });

  it('round trips every supported status across raw bodies and workflow representations', () => {
    for (const state of ['open', 'closed'] as const)
      for (const body of [null, '', 'Text'])
        for (const labels of [
          [],
          ['bug'],
          [{ name: 'ATOMIC:DOING' }],
          ['atomic:blocked', 'atomic:doing', 'bug'],
        ]) {
          const source: Issue = {
            number: 42,
            title: 'Before',
            body,
            state,
            labels,
          };
          expect(githubIssueLens.get(source)).toEqual(project(source));

          for (const status of STATUSES) {
            const desired = { title: 'After', body: 'Edited', status };
            expect(checkLensLaws(githubIssueLens, source, desired)).toEqual({
              getPut: true,
              putGet: true,
              stablePut: true,
            });
            const updated = githubIssueLens.put(desired, source);
            expect(updated.number).toBe(42);
            expect(
              updated.labels.filter(
                l => (typeof l === 'string' ? l : l.name) === 'bug',
              ),
            ).toEqual(
              labels.filter(
                l => (typeof l === 'string' ? l : l.name) === 'bug',
              ),
            );
          }
        }
  });

  it('refuses unsupported edits', () => {
    const source: Issue = {
      number: 1,
      title: 'Before',
      body: '',
      state: 'open',
      labels: [],
    };
    expect(() =>
      githubIssueLens.put({ ...project(source), title: ' ' }, source),
    ).toThrow('Cards require');
  });
});
