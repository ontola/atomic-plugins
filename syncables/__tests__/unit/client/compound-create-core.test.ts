// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  followUpRequest,
  missingValue,
  NOTHING_MISSING,
  parseFollowUps,
  withoutOmitted,
  type FollowUp,
} from '../../../src/client/compound-create.js';
import { compoundDocument } from '../../fixtures/compound-create.js';

// The pure parts of CRUD Causality 0.5.0 §4.7.2, after the reference
// `missing_value`, `follow_up_request` and rules 20-24 in the spec's
// validate.py.

const CREATE = '/repos/{owner}/{repo}/issues';

function followUps(raw?: unknown[]): FollowUp[] {
  const doc = compoundDocument(raw);
  const crud = (doc.paths[CREATE]!.post as Record<string, unknown>)[
    'x-crud'
  ] as Record<string, unknown>;
  return parseFollowUps(doc, crud, CREATE)!;
}

const [labels, assignees] = followUps();

describe('parseFollowUps', () => {
  it('resolves each follow-up operation to its path and method', () => {
    expect(labels).toMatchObject({
      field: 'labels',
      create: 'include',
      itemKey: 'name',
      operation: 'issues-add-labels',
      path: '/repos/{owner}/{repo}/issues/{issue_number}/labels',
      method: 'POST',
    });
    expect(assignees!.create).toBe('omit');
  });

  it.each([
    [[], /nonempty/],
    [
      [{ create: 'include', operation: 'issues-add-labels', bind: {} }],
      /field/,
    ],
    [
      [
        {
          field: 'labels',
          create: 'later',
          operation: 'issues-add-labels',
          bind: {},
        },
      ],
      /include nor omit/,
    ],
    [
      [
        {
          field: 'labels',
          create: 'include',
          operation: 'issues-get',
          bind: {},
        },
      ],
      /names 0 operations|is not an update/,
    ],
    [
      [
        {
          field: 'labels',
          create: 'include',
          operation: 'issues-update',
          bind: {},
        },
      ],
      /neither bound nor carried/,
    ],
    [
      [
        {
          field: 'labels',
          create: 'include',
          operation: 'issues-add-labels',
          bind: {
            'path.issue_number': { from: 'created', field: 'number' },
            'body.labels': { from: 'missing', field: 'title' },
          },
        },
      ],
      /from missing needs the follow-up's own field/,
    ],
    [
      [
        {
          field: 'labels',
          create: 'include',
          operation: 'issues-add-labels',
          bind: {
            'path.issue_number': { from: 'created', field: 'number' },
            cookie: { from: 'planned', field: 'labels' },
          },
        },
      ],
      /not a key this client fills/,
    ],
  ])('refuses %j', (raw, message) => {
    expect(() => followUps(raw as unknown[])).toThrow(message);
  });
});

describe('missingValue (missing_value)', () => {
  it('compares array items through itemKey', () => {
    expect(
      missingValue(
        labels!,
        { labels: ['bug', 'ui'] },
        { labels: [{ name: 'bug' }] },
      ),
    ).toEqual(['ui']);
    expect(
      missingValue(labels!, { labels: ['bug'] }, { labels: [{ name: 'bug' }] }),
    ).toBe(NOTHING_MISSING);
  });

  it('is nothing when the planned object has no value at the field', () => {
    expect(missingValue(labels!, { title: 'x' }, undefined)).toBe(
      NOTHING_MISSING,
    );
  });

  it('is the whole planned value before anything was created', () => {
    expect(missingValue(labels!, { labels: ['bug'] }, undefined)).toEqual([
      'bug',
    ]);
  });

  it('compares a scalar by JSON equality', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { itemKey, ...rest } = labels!;
    const milestone: FollowUp = { ...rest, field: 'milestone' };
    expect(missingValue(milestone, { milestone: 3 }, { milestone: 3 })).toBe(
      NOTHING_MISSING,
    );
    expect(missingValue(milestone, { milestone: 3 }, { milestone: null })).toBe(
      3,
    );
  });
});

describe('followUpRequest (follow_up_request)', () => {
  it('fills path parameters from the create context and bind, and the body', () => {
    expect(
      followUpRequest(labels!, { labels: ['bug'] }, { number: 7 }, ['bug'], {
        owner: 'o',
        repo: 'r',
      }),
    ).toEqual({
      path: { owner: 'o', repo: 'r', issue_number: '7' },
      query: {},
      header: {},
      body: { labels: ['bug'] },
    });
  });

  it('is undefined when a bound value resolves to nothing', () => {
    expect(
      followUpRequest(labels!, { labels: ['bug'] }, {}, ['bug'], {}),
    ).toBeUndefined();
  });
});

describe('withoutOmitted', () => {
  it('drops omit fields only, without touching the planned object', () => {
    const planned = { title: 'Bug', labels: ['bug'], assignees: ['ada'] };
    expect(withoutOmitted([labels!, assignees!], planned)).toEqual({
      title: 'Bug',
      labels: ['bug'],
    });
    expect(planned.assignees).toEqual(['ada']);
  });
});
