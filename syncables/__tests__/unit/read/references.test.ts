// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  resolveReference,
  type OpenApiDocument,
} from '../../../src/browser.js';

// CRUD Causality §4.1.3 Reference Objects, on the spec's §7.6 example: a
// time entry carries the bare id of its project; the reference fills the
// project's identity.urlTemplate from that field, and {workspaceId}, which
// it does not bind, from the request the time entry was read through.

function document(reference: Record<string, unknown> = {}): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Time', version: '1' },
    paths: {},
    components: {
      crudResources: {
        project: {
          identity: {
            urlTemplate: '/workspaces/{workspaceId}/projects/{projectId}',
            bindings: { projectId: { field: 'id' } },
          },
          collections: {
            projects: { urlTemplate: '/workspaces/{workspaceId}/projects' },
          },
        },
        timeEntry: {
          identity: {
            urlTemplate: '/workspaces/{workspaceId}/time-entries/{timeEntryId}',
            bindings: { timeEntryId: { field: 'id' } },
          },
          references: {
            project: {
              resource: 'project',
              required: false,
              bindings: { projectId: { field: 'projectId' } },
              ...reference,
            },
          },
          collections: {
            timeEntries: {
              urlTemplate: '/workspaces/{workspaceId}/time-entries',
            },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const entry = { id: 'te-1', description: 'Spec review', projectId: 'p-9' };

describe('resolveReference', () => {
  it('resolves the spec’s §7.6 example', () => {
    expect(
      resolveReference(document(), 'timeEntry', 'project', entry, {
        workspaceId: '42',
      }),
    ).toEqual({
      resource: 'project',
      path: '/workspaces/42/projects/p-9',
      values: { workspaceId: '42', projectId: 'p-9' },
    });
  });

  it('reads a dot-path, an integer in decimal, and percent-encodes', () => {
    const doc = document({
      bindings: { projectId: { field: 'project.id' } },
    });
    expect(
      resolveReference(
        doc,
        'timeEntry',
        'project',
        { project: { id: 9 } },
        {
          workspaceId: 'a b',
        },
      )?.path,
    ).toBe('/workspaces/a%20b/projects/9');
  });

  it('identifies no object when an optional reference’s field is absent or null', () => {
    for (const projectId of [undefined, null])
      expect(
        resolveReference(
          document(),
          'timeEntry',
          'project',
          { id: 'te-2', projectId },
          { workspaceId: '42' },
        ),
      ).toBeUndefined();
  });

  it.each([
    [
      'a required reference whose field is absent',
      document({ required: true }),
      { id: 'te-2' },
      { workspaceId: '42' },
      /required field projectId is absent/,
    ],
    [
      'an unbound variable missing from the context',
      document(),
      entry,
      {},
      /\{workspaceId\} is not bound and not in the request context/,
    ],
    [
      'a value that is neither a string nor an integer',
      document(),
      { projectId: 1.5 },
      { workspaceId: '42' },
      /not a string or an integer/,
    ],
    [
      'an empty string',
      document({ required: true }),
      { projectId: '' },
      { workspaceId: '42' },
      /projectId is "", empty$/,
    ],
    [
      'an empty string under required: false, which is a value, not an absence',
      document(),
      { projectId: '' },
      { workspaceId: '42' },
      /projectId is "", empty$/,
    ],
    [
      'an integer beyond Number.MAX_SAFE_INTEGER',
      document(),
      // 9007199254740993 in the API's JSON, which parses to ...992.
      { projectId: 2 ** 53 + 1 },
      { workspaceId: '42' },
      /projectId is 9007199254740992, not a safe integer/,
    ],
    [
      '1e21, which would bind as 1e%2B21',
      document(),
      { projectId: 1e21 },
      { workspaceId: '42' },
      /projectId is 1e\+21, not a safe integer/,
    ],
    [
      'NaN',
      document(),
      { projectId: NaN },
      { workspaceId: '42' },
      /projectId is NaN, not a string or an integer/,
    ],
    [
      'a value containing NUL',
      document(),
      { projectId: 'p\u00009' },
      { workspaceId: '42' },
      /contains NUL$/,
    ],
    [
      'a lone surrogate',
      document(),
      { projectId: 'p-\ud800' },
      { workspaceId: '42' },
      /projectId is ".*", not well-formed Unicode \(a lone surrogate\)$/,
    ],
    [
      'a lone surrogate from the context',
      document(),
      entry,
      { workspaceId: '\udc00' },
      /\{workspaceId\} from the request context is ".*", not well-formed Unicode/,
    ],
    [
      'a target without an identity',
      document({ resource: 'nothing' }),
      entry,
      { workspaceId: '42' },
      /names no resource with an identity\.urlTemplate/,
    ],
    [
      'a binding without a field',
      document({ bindings: { projectId: {} } }),
      entry,
      { workspaceId: '42' },
      /bindings\.projectId\.field is required/,
    ],
  ])('throws on %s', (_label, doc, object, context, message) => {
    expect(() =>
      resolveReference(doc, 'timeEntry', 'project', object, context),
    ).toThrow(message);
  });

  // `.` and `..` survive percent-encoding, and `/projects/..` normalises
  // to `/`: a value that moved the path would name another resource.
  it.each(['.', '..', ' p-9', 'p-9 ', '\tp-9', 'p-9\n', ' '])(
    'refuses the bound value %j',
    (projectId) => {
      expect(() =>
        resolveReference(
          document(),
          'timeEntry',
          'project',
          { projectId },
          { workspaceId: '42' },
        ),
      ).toThrow(/projectId is ".*", (a dot segment|padded with whitespace)$/);
    },
  );

  it.each(['.', '..', ' 42', '42 '])(
    'refuses the context value %j',
    (workspaceId) => {
      expect(() =>
        resolveReference(document(), 'timeEntry', 'project', entry, {
          workspaceId,
        }),
      ).toThrow(
        /\{workspaceId\} from the request context is ".*", (a dot segment|padded with whitespace)$/,
      );
    },
  );

  it('keeps dots and inner spaces that are not a whole segment', () => {
    expect(
      resolveReference(
        document(),
        'timeEntry',
        'project',
        { projectId: '...' },
        { workspaceId: 'a.b c' },
      )?.path,
    ).toBe('/workspaces/a.b%20c/projects/...');
  });

  it('identifies no object when an optional field is null, whatever the variable order', () => {
    // {workspaceId} comes first in the template and is missing from the
    // context; the null projectId still decides.
    expect(
      resolveReference(document(), 'timeEntry', 'project', {
        id: 'te-2',
        projectId: null,
      }),
    ).toBeUndefined();
    expect(() =>
      resolveReference(document({ required: true }), 'timeEntry', 'project', {
        id: 'te-2',
        projectId: null,
      }),
    ).toThrow(/required field projectId is absent/);
  });

  it('binds the largest safe integer and a negative one', () => {
    for (const projectId of [Number.MAX_SAFE_INTEGER, -7])
      expect(
        resolveReference(
          document(),
          'timeEntry',
          'project',
          { projectId },
          { workspaceId: '42' },
        )?.path,
      ).toBe(`/workspaces/42/projects/${String(projectId)}`);
  });

  it('percent-encodes /, ?, # and an already encoded %2e%2e', () => {
    const path = (projectId: string): string | undefined =>
      resolveReference(
        document(),
        'timeEntry',
        'project',
        { projectId },
        { workspaceId: '42' },
      )?.path;
    expect(path('a/b')).toBe('/workspaces/42/projects/a%2Fb');
    expect(path('a?b')).toBe('/workspaces/42/projects/a%3Fb');
    expect(path('a#b')).toBe('/workspaces/42/projects/a%23b');
    expect(path('../x')).toBe('/workspaces/42/projects/..%2Fx');
    // The % is encoded again, so the segment stays literal `%2e%2e`, not `..`.
    expect(path('%2e%2e')).toBe('/workspaces/42/projects/%252e%252e');
  });

  it.each([
    'https://api.example.com/projects/{projectId}',
    '{host}/projects/{projectId}',
    'projects/{projectId}',
    '//evil.example/projects/{projectId}',
    '/\\evil.example/projects/{projectId}',
    '/workspaces\\{workspaceId}/projects/{projectId}',
    '/\t/evil.example/{projectId}',
    '/\n/evil.example/{projectId}',
    '/\r/evil.example/{projectId}',
    '/projects/{projectId}\u0000',
    '/projects /{projectId}',
    '/projects/\u007f{projectId}',
  ])('refuses the identity.urlTemplate %j', (urlTemplate) => {
    const doc = document();
    const crud = (
      doc.components as {
        crudResources: { project: { identity: { urlTemplate: string } } };
      }
    ).crudResources;
    crud.project.identity.urlTemplate = urlTemplate;
    expect(() =>
      resolveReference(doc, 'timeEntry', 'project', entry, {
        workspaceId: '42',
        host: 'h',
      }),
    ).toThrow(/is not a path starting with one \/, without a backslash/);
  });

  it('reads /\\host as that host, which is why a backslash is refused', () => {
    expect(new URL('/\\evil.example/p', 'https://api.example.com').host).toBe(
      'evil.example',
    );
  });

  it.each([
    [10n, /projectId is 10n, not a string or an integer/],
    [{ id: 1n }, /projectId is an object, not a string or an integer/],
    [Symbol('p'), /projectId is a symbol, not a string or an integer/],
  ])(
    'names the value %s in its error without throwing a TypeError',
    (projectId, message) => {
      expect(() =>
        resolveReference(
          document(),
          'timeEntry',
          'project',
          { projectId },
          { workspaceId: '42' },
        ),
      ).toThrow(message);
    },
  );

  it('reads /<tab>/host as that host, which is why control characters are refused', () => {
    expect(new URL('/\t/evil.example/p', 'https://api.example.com').host).toBe(
      'evil.example',
    );
  });

  it('names a cyclic value by its type', () => {
    const projectId: Record<string, unknown> = {};
    projectId['self'] = projectId;
    expect(() =>
      resolveReference(
        document(),
        'timeEntry',
        'project',
        { projectId },
        { workspaceId: '42' },
      ),
    ).toThrow(/projectId is an object, not a string or an integer/);
  });

  it('cuts a long value at 200 characters', () => {
    const projectId = ['x'.repeat(500)];
    let message = '';
    try {
      resolveReference(
        document(),
        'timeEntry',
        'project',
        { projectId },
        { workspaceId: '42' },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`projectId is ["${'x'.repeat(198)}…, not`);
    expect(message.length).toBeLessThan(300);
  });

  it('throws for an unknown resource or reference', () => {
    expect(() =>
      resolveReference(document(), 'nothing', 'project', entry),
    ).toThrow(/not a crudResources key/);
    expect(() =>
      resolveReference(document(), 'timeEntry', 'client', entry),
    ).toThrow(/references\.client is not declared/);
  });
});
