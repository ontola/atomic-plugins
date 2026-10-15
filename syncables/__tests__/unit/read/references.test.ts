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
      document(),
      { projectId: '' },
      { workspaceId: '42' },
      /not a string or an integer/,
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

  it('throws for an unknown resource or reference', () => {
    expect(() =>
      resolveReference(document(), 'nothing', 'project', entry),
    ).toThrow(/not a crudResources key/);
    expect(() =>
      resolveReference(document(), 'timeEntry', 'client', entry),
    ).toThrow(/references\.client is not declared/);
  });
});
