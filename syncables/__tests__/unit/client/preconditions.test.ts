// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  maySend,
  parsePrecondition,
  resolveUnknown,
  writeAnswer,
  type Precondition,
} from '../../../src/client/preconditions.js';

// Write Preconditions 0.1.0-draft: the spec's ClientTests
// (openapi-extensions/spec/write-preconditions/test_validate.py), case by
// case, against the TypeScript port of its reference functions.

function p(declared: Record<string, unknown>): Precondition {
  const parsed = parsePrecondition(declared);
  if (!parsed || 'refused' in parsed) throw new Error('unusable declaration');
  return parsed;
}

const IF_MATCH = { kind: 'ifMatch', version: { in: 'body', name: 'etag' } };
const VERIFY = {
  kind: 'readVerify',
  refuseWhen: [{ field: 'in_trash', values: [true] }],
};

const read = (
  body: unknown,
  status = 200,
): { status: number; body: unknown } => ({ status, body });

type Doc = {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components?: Record<string, unknown>;
};

/** The spec's examples/conditional-writes.yaml, as far as the rules read it. */
function example(): Doc {
  return {
    paths: {
      '/events/{eventId}': {
        get: {},
        patch: {
          'x-write-precondition': {
            kind: 'ifMatch',
            version: { in: 'body', name: 'etag' },
            conflictStatus: [412],
          },
        },
        delete: {
          'x-write-precondition': {
            kind: 'ifMatch',
            version: { in: 'body', name: 'etag' },
          },
        },
      },
      '/pages/{pageId}': {
        get: {},
        patch: {
          'x-write-precondition': {
            kind: 'readVerify',
            refuseWhen: [
              {
                field: 'in_trash',
                values: [true],
                description: 'The owner trashed the page.',
              },
            ],
          },
        },
      },
      '/notes/{noteId}': {
        put: { 'x-write-precondition': { kind: 'none' } },
      },
    },
  };
}

/** `validate()` of the spec, through `parsePrecondition` with its place. */
function validate(document: Doc): string[] {
  const refused: string[] = [];
  for (const [path, item] of Object.entries(document.paths))
    for (const [method, operation] of Object.entries(item)) {
      if (!('x-write-precondition' in operation)) continue;
      const parsed = parsePrecondition(operation['x-write-precondition'], {
        method,
        operation,
        document,
        path,
      });
      if (parsed && 'refused' in parsed) refused.push(parsed.refused);
    }
  return refused;
}

function decl(
  document: Doc,
  path: string,
  method: string,
): Record<string, unknown> {
  return document.paths[path]![method]!['x-write-precondition'] as Record<
    string,
    unknown
  >;
}

/** Mutates the example and expects a refusal containing `fragment`. */
function invalid(mutate: (d: Doc) => void, fragment: string): void {
  const document = example();
  mutate(document);
  const refused = validate(document);
  expect(refused.join('\n')).toContain(fragment);
}

describe('parsePrecondition', () => {
  it('applies the defaults', () => {
    expect(p(IF_MATCH)).toEqual({
      kind: 'ifMatch',
      version: { in: 'body', name: 'etag' },
      header: 'If-Match',
      conflictStatus: [412],
      refuseWhen: [],
    });
    expect(p({ kind: 'none', idempotent: true }).idempotent).toBe(true);
    expect(parsePrecondition(undefined)).toBeUndefined();
  });

  it('refuses a declaration it cannot read, rather than writing unconditionally', () => {
    for (const bad of [
      { kind: 'ifNoneMatch' },
      { kind: 'ifMatch' },
      { kind: 'ifMatch', version: { in: 'cookie', name: 'v' } },
      { kind: 'none', refuseWhen: [{ field: 'x' }] },
      { kind: 'none', refuseWhen: [{ field: 'x', present: false }] },
      {
        kind: 'none',
        refuseWhen: [{ field: 'x', present: true, values: [1] }],
      },
      {
        kind: 'none',
        refuseWhen: [{ field: 'x', present: true, when: { field: 'y' } }],
      },
      { kind: 'none', refuseWhen: [{ field: 'x', present: true, source: {} }] },
      'ifMatch',
    ])
      expect(parsePrecondition(bad)).toHaveProperty('refused');
  });
});

describe('the spec ValidationTests', () => {
  it('the example is valid', () => {
    expect(validate(example())).toEqual([]);
  });

  it('kind and its fields', () => {
    const events = (d: Doc): Record<string, unknown> =>
      decl(d, '/events/{eventId}', 'patch');
    invalid((d) => (events(d)['kind'] = 'etag'), 'kind');
    invalid((d) => delete events(d)['version'], 'version');
    invalid(
      (d) => (events(d)['version'] = { in: 'query', name: 'v' }),
      'version',
    );
    invalid(
      (d) => (events(d)['version'] = { in: 'body', name: '' }),
      'version',
    );
    invalid(
      (d) => (events(d)['version'] = { in: 'body', name: 'etag', where: 'x' }),
      'version',
    );
    invalid(
      (d) =>
        (decl(d, '/pages/{pageId}', 'patch')['version'] = {
          in: 'body',
          name: 'etag',
        }),
      'only for kind ifMatch',
    );
    invalid(
      (d) => (decl(d, '/notes/{noteId}', 'put')['header'] = 'If-Match'),
      'only for kind ifMatch',
    );
    invalid((d) => (events(d)['header'] = ''), 'header');
    invalid((d) => (events(d)['header'] = 7), 'header');
    for (const statuses of [[], [500], [412, 412], ['412'], [true], 412])
      invalid(
        (d) => (events(d)['conflictStatus'] = statuses),
        'conflictStatus',
      );
    invalid((d) => (events(d)['extra'] = 1), 'unknown fields');
    const document = example();
    events(document)['x-note'] = 'an extension field is allowed';
    expect(validate(document)).toEqual([]);
  });

  it('refusals and idempotent', () => {
    const page = (d: Doc): Record<string, unknown> =>
      decl(d, '/pages/{pageId}', 'patch');
    const refusals = (d: Doc): unknown[] => page(d)['refuseWhen'] as unknown[];
    invalid((d) => (page(d)['refuseWhen'] = { field: 'x' }), 'not an array');
    invalid((d) => refusals(d).push({ field: '', values: [1] }), 'field');
    invalid((d) => refusals(d).push({ field: 'x', values: [] }), 'values');
    invalid(
      (d) => refusals(d).push({ field: 'x', values: [{ a: 1 }] }),
      'values',
    );
    invalid(
      (d) => refusals(d).push({ field: 'x', values: [1], other: 1 }),
      'unknown fields',
    );
    // Not read as false or true: a resend must never rest on a guess.
    for (const bad of ['yes', 'false', 0, null])
      invalid((d) => (page(d)['idempotent'] = bad), 'idempotent');
    const document = example();
    page(document)['idempotent'] = true;
    refusals(document).push({ field: 'archived', values: [true, null] });
    expect(validate(document)).toEqual([]);
  });

  it('placement', () => {
    expect.assertions(2);
    invalid(
      (d) =>
        (d.paths['/pages/{pageId}']!['get']!['x-write-precondition'] = {
          kind: 'none',
        }),
      'only on PUT, PATCH, POST or DELETE',
    );
    invalid(
      (d) =>
        (d.paths['/pages/{pageId}']!['patch']!['x-crud'] = {
          action: 'read',
          resource: 'p',
        }),
      'x-crud action is not update or delete',
    );
  });
});

describe('the spec ClientTests', () => {
  it('ifMatch sends the version read', () => {
    const current = { id: 'e1', etag: '"3181161784712000"', summary: 'Old' };
    expect(
      maySend(p(IF_MATCH), { summary: 'Old' }, ['summary'], current),
    ).toEqual({
      result: 'send',
      headers: { 'If-Match': '"3181161784712000"' },
    });
    expect(
      maySend(
        p({ ...IF_MATCH, header: 'X-If-Match' }),
        {},
        ['summary'],
        current,
      ),
    ).toEqual({
      result: 'send',
      headers: { 'X-If-Match': '"3181161784712000"' },
    });
    expect(maySend(p(IF_MATCH), {}, ['summary'], { id: 'e1' })).toEqual({
      result: 'read-first',
    });
    expect(maySend(p(IF_MATCH), {}, ['summary'], undefined)).toEqual({
      result: 'read-first',
    });
  });

  it('readVerify compares only the written fields', () => {
    const baseline = { title: 'A', status: 'open' };
    const current: Record<string, unknown> = {
      title: 'A',
      status: 'open',
      notes: 'changed by someone else',
    };
    expect(maySend(p(VERIFY), baseline, ['title'], current).result).toBe(
      'send',
    );
    current['status'] = 'done';
    expect(maySend(p(VERIFY), baseline, ['title'], current).result).toBe(
      'send',
    );
    expect(maySend(p(VERIFY), baseline, ['title', 'status'], current)).toEqual({
      result: 'conflict',
      fields: ['status'],
    });
    expect(maySend(p(VERIFY), { n: 1 }, ['n'], { n: 1.0 }).result).toBe('send');
    expect(maySend(p(VERIFY), { n: 1 }, ['n'], { n: '1' })).toEqual({
      result: 'conflict',
      fields: ['n'],
    });
    expect(maySend(p(VERIFY), baseline, ['title'], undefined)).toEqual({
      result: 'read-first',
    });
  });

  it('a refusal wins over everything', () => {
    expect(
      maySend(p(VERIFY), { title: 'A' }, ['title'], {
        title: 'A',
        in_trash: true,
      }).result,
    ).toBe('refused');
    expect(
      maySend(p(VERIFY), { title: 'A' }, ['title'], {
        title: 'A',
        in_trash: false,
      }).result,
    ).toBe('send');
    expect(
      maySend(p(VERIFY), { title: 'A' }, ['title'], {
        title: 'A',
        in_trash: 'true',
      }).result,
    ).toBe('send');
    const nested = p({
      kind: 'none',
      refuseWhen: [{ field: 'state.phase', values: ['archived'] }],
    });
    expect(
      maySend(nested, {}, ['x'], { state: { phase: 'archived' } }).result,
    ).toBe('refused');
    expect(maySend(p({ kind: 'none' }), {}, ['x'], undefined)).toEqual({
      result: 'send',
      headers: {},
    });
  });

  it('whether an unknown outcome is read first', () => {
    const baseline = { title: 'A' };
    const written = { title: 'B' };
    expect(resolveUnknown(p(VERIFY), 'PATCH', baseline, written)).toBe(
      'read-first',
    );
    // Under readVerify, idempotent never skips the read and comparison.
    expect(
      resolveUnknown(
        p({ ...VERIFY, idempotent: true }),
        'PATCH',
        baseline,
        written,
      ),
    ).toBe('read-first');
    expect(
      resolveUnknown(
        p({ ...VERIFY, idempotent: true }),
        'PUT',
        baseline,
        written,
      ),
    ).toBe('read-first');
    expect(
      resolveUnknown(
        p({ ...IF_MATCH, idempotent: true }),
        'PATCH',
        baseline,
        written,
      ),
    ).toBe('resend');
    expect(resolveUnknown(p({ kind: 'none' }), 'PUT', baseline, written)).toBe(
      'resend',
    );
    expect(
      resolveUnknown(
        p({ kind: 'none', idempotent: false }),
        'PUT',
        baseline,
        written,
      ),
    ).toBe('read-first');
  });

  it('an unknown update resolved by a read', () => {
    const baseline = { title: 'A' };
    const written = { title: 'B' };
    const v = p(VERIFY);
    expect(
      resolveUnknown(v, 'PATCH', baseline, written, read({ title: 'B' })),
    ).toBe('applied');
    expect(
      resolveUnknown(v, 'PATCH', baseline, written, read({ title: 'A' })),
    ).toBe('not-applied');
    expect(
      resolveUnknown(v, 'PATCH', baseline, written, read({ title: 'C' })),
    ).toBe('conflict');
    expect(resolveUnknown(v, 'PATCH', baseline, written, read(null, 500))).toBe(
      'unknown',
    );
    expect(resolveUnknown(v, 'PATCH', baseline, {}, read({ title: 'A' }))).toBe(
      'unknown',
    );
    const sent = '"v1"';
    const m = p(IF_MATCH);
    expect(
      resolveUnknown(
        m,
        'PATCH',
        baseline,
        written,
        read({ title: 'A', etag: sent }),
        sent,
      ),
    ).toBe('not-applied');
    expect(
      resolveUnknown(
        m,
        'PATCH',
        baseline,
        written,
        read({ title: 'B', etag: '"v2"' }),
        sent,
      ),
    ).toBe('applied');
    expect(
      resolveUnknown(
        m,
        'PATCH',
        baseline,
        written,
        read({ title: 'C', etag: '"v2"' }),
        sent,
      ),
    ).toBe('conflict');
    expect(
      resolveUnknown(
        m,
        'PATCH',
        baseline,
        written,
        read({ title: 'A', etag: '"v2"' }),
        sent,
      ),
    ).toBe('conflict');
    expect(
      resolveUnknown(
        v,
        'PATCH',
        baseline,
        written,
        read({ title: 'A', in_trash: true }),
      ),
    ).toBe('refused');
    const header = p({
      kind: 'ifMatch',
      version: { in: 'header', name: 'ETag' },
    });
    expect(
      resolveUnknown(
        header,
        'PATCH',
        baseline,
        written,
        { status: 200, body: { title: 'A' }, headers: { etag: sent } },
        sent,
      ),
    ).toBe('not-applied');
  });

  it('absent equals null', () => {
    expect(
      resolveUnknown(
        p(VERIFY),
        'PATCH',
        { note: 'x' },
        { note: null },
        read({ title: 'A' }),
      ),
    ).toBe('applied');
    expect(
      maySend(p(VERIFY), { note: null }, ['note'], { title: 'A' }).result,
    ).toBe('send');
    expect(maySend(p(VERIFY), { note: null }, ['note'], { note: 'y' })).toEqual(
      {
        result: 'conflict',
        fields: ['note'],
      },
    );
  });

  it('an unknown delete', () => {
    const baseline = { title: 'A', etag: '"v1"' };
    const v = p(VERIFY);
    for (const status of [404, 410]) {
      expect(
        resolveUnknown(v, 'DELETE', baseline, {}, read(null, status)),
      ).toBe('gone-unconfirmed');
      expect(
        resolveUnknown(
          v,
          'DELETE',
          baseline,
          {},
          read(null, status),
          undefined,
          undefined,
          true,
        ),
      ).toBe('applied');
    }
    const tombstone = { field: 'deleted', values: [true] };
    expect(
      resolveUnknown(
        v,
        'DELETE',
        baseline,
        {},
        read({ title: 'A', deleted: true, etag: '"v9"' }),
        undefined,
        undefined,
        false,
        tombstone,
      ),
    ).toBe('applied');
    expect(
      resolveUnknown(
        v,
        'POST',
        baseline,
        {},
        read(null, 404),
        undefined,
        'delete',
        true,
      ),
    ).toBe('applied');
    expect(
      resolveUnknown(
        v,
        'DELETE',
        { title: 'A' },
        { title: 'B' },
        read({ title: 'B' }),
        undefined,
        'update',
      ),
    ).toBe('applied');
    expect(
      resolveUnknown(
        v,
        'DELETE',
        baseline,
        {},
        read({ title: 'A', etag: '"v1"' }),
      ),
    ).toBe('not-applied');
    expect(
      resolveUnknown(
        v,
        'DELETE',
        baseline,
        {},
        read({ title: 'C', etag: '"v2"' }),
      ),
    ).toBe('conflict');
    const m = p(IF_MATCH);
    expect(
      resolveUnknown(
        m,
        'DELETE',
        baseline,
        {},
        read({ title: 'C', etag: '"v1"' }),
        '"v1"',
      ),
    ).toBe('not-applied');
    expect(
      resolveUnknown(
        m,
        'DELETE',
        baseline,
        {},
        read({ title: 'A', etag: '"v2"' }),
        '"v1"',
      ),
    ).toBe('conflict');
    expect(resolveUnknown(v, 'DELETE', baseline, {}, read(null, 500))).toBe(
      'unknown',
    );
    expect(resolveUnknown(p({ kind: 'none' }), 'DELETE', baseline, {})).toBe(
      'resend',
    );
  });

  it('the resolution order and gone objects', () => {
    const tombstone = { field: 'in_trash', values: [true] };
    const v = p(VERIFY);
    expect(
      resolveUnknown(
        v,
        'PATCH',
        { in_trash: false },
        { in_trash: true },
        read({ in_trash: true }),
      ),
    ).toBe('applied');
    expect(
      resolveUnknown(
        v,
        'DELETE',
        { title: 'A' },
        {},
        read({ title: 'A', in_trash: true }),
        undefined,
        undefined,
        false,
        tombstone,
      ),
    ).toBe('applied');
    for (const status of [404, 410])
      expect(
        resolveUnknown(
          v,
          'PUT',
          { title: 'A' },
          { title: 'B' },
          read(null, status),
        ),
      ).toBe('gone');
    expect(
      resolveUnknown(
        v,
        'PATCH',
        { title: 'A' },
        { title: 'B' },
        read({ title: 'A', in_trash: true }),
        undefined,
        undefined,
        false,
        tombstone,
      ),
    ).toBe('gone');
  });

  it('possible creates are never resent', () => {
    const noneIdempotent = p({ kind: 'none', idempotent: true });
    expect(resolveUnknown(noneIdempotent, 'POST', {}, { title: 'B' })).toBe(
      'unknown',
    );
    expect(
      resolveUnknown(
        noneIdempotent,
        'POST',
        {},
        { title: 'B' },
        read({ title: 'A' }),
      ),
    ).toBe('unknown');
    expect(
      resolveUnknown(
        noneIdempotent,
        'PUT',
        {},
        { title: 'B' },
        undefined,
        undefined,
        'create',
      ),
    ).toBe('unknown');
    expect(
      resolveUnknown(
        p(VERIFY),
        'POST',
        { title: 'A' },
        { title: 'B' },
        read({ title: 'B' }),
        undefined,
        'update',
      ),
    ).toBe('applied');
  });

  it('rule 6 needs a baseline for every compared field', () => {
    const r = read({ title: 'A', notes: 'n' });
    const v = p(VERIFY);
    expect(resolveUnknown(v, 'PATCH', {}, { title: 'B' }, r)).toBe('unknown');
    expect(
      resolveUnknown(v, 'PATCH', { title: 'A' }, { title: 'B', notes: 'm' }, r),
    ).toBe('unknown');
    expect(resolveUnknown(v, 'DELETE', {}, {}, r)).toBe('unknown');
  });

  it('gone: deleted confirms a 410 only', () => {
    const v = p(VERIFY);
    const gone = (
      status: number,
      confirmed: boolean,
      stated?: 'deleted' | 'unavailable',
    ): string =>
      resolveUnknown(
        v,
        'DELETE',
        { title: 'A' },
        {},
        read(null, status),
        undefined,
        undefined,
        confirmed,
        undefined,
        stated,
      );
    expect(gone(410, false, 'deleted')).toBe('applied');
    expect(gone(404, false, 'deleted')).toBe('gone-unconfirmed');
    expect(gone(410, false)).toBe('gone-unconfirmed');
    expect(gone(410, true, 'unavailable')).toBe('gone-unconfirmed');
    expect(gone(410, true)).toBe('applied');
    expect(writeAnswer('delete', 410, false, 'deleted')).toBe('applied');
    expect(writeAnswer('delete', 404, false, 'deleted')).toBe(
      'gone-unconfirmed',
    );
    expect(writeAnswer('update', 410, false, 'deleted')).toBe('gone');
  });

  it("the write's own answer", () => {
    expect(writeAnswer('delete', 404)).toBe('gone-unconfirmed');
    expect(writeAnswer('delete', 410, true)).toBe('applied');
    expect(writeAnswer('update', 404)).toBe('gone');
    expect(writeAnswer('delete', 204)).toBeUndefined();
    expect(writeAnswer('update', 412)).toBeUndefined();
  });

  it('a readVerify delete compares every baseline field', () => {
    const baseline = { title: 'A', notes: 'n' };
    expect(
      maySend(
        p(VERIFY),
        baseline,
        [],
        { title: 'A', notes: 'n' },
        undefined,
        undefined,
        undefined,
        'delete',
      ).result,
    ).toBe('send');
    expect(
      maySend(
        p(VERIFY),
        baseline,
        [],
        { title: 'A', notes: 'changed' },
        undefined,
        undefined,
        undefined,
        'delete',
      ),
    ).toEqual({ result: 'conflict', fields: ['notes'] });
  });

  it('a present refusal', () => {
    const recurring = p({
      ...IF_MATCH,
      refuseWhen: [{ field: 'recurrence', present: true }],
    });
    expect(
      maySend(recurring, {}, ['summary'], {
        etag: '"v"',
        recurrence: ['RRULE:FREQ=WEEKLY'],
      }).result,
    ).toBe('refused');
    expect(
      maySend(recurring, {}, ['summary'], { etag: '"v"', recurrence: [] })
        .result,
    ).toBe('refused');
    expect(maySend(recurring, {}, ['summary'], { etag: '"v"' }).result).toBe(
      'send',
    );
    expect(
      maySend(recurring, {}, ['summary'], { etag: '"v"', recurrence: null })
        .result,
    ).toBe('send');
    const document = example();
    (
      decl(document, '/pages/{pageId}', 'patch')['refuseWhen'] as unknown[]
    ).push({ field: 'recurrence', present: true });
    expect(validate(document)).toEqual([]);
    for (const bad of [
      { field: 'x', present: false },
      { field: 'x', present: true, values: [1] },
      { field: 'x' },
    ]) {
      const document = example();
      (
        decl(document, '/pages/{pageId}', 'patch')['refuseWhen'] as unknown[]
      ).push(bad);
      expect(validate(document)).toHaveLength(1);
    }
  });

  it('source and when validation', () => {
    const documentWith = (refusal: Record<string, unknown>): Doc => {
      const document = example();
      document.components = {
        crudResources: {
          workspace: {
            identity: {
              urlTemplate: '/workspaces/{workspaceId}',
              bindings: { workspaceId: { field: 'id' } },
            },
            collections: { workspaces: { urlTemplate: '/workspaces' } },
          },
        },
      };
      document.paths['/workspaces/{workspaceId}/entries/{entryId}'] = {
        put: {
          'x-write-precondition': { kind: 'none', refuseWhen: [refusal] },
        },
      };
      return document;
    };
    const good = {
      source: { resource: 'workspace' },
      field: 'settings.forceProjects',
      values: [true],
      when: { field: 'projectId', values: [null] },
    };
    expect(validate(documentWith(good))).toEqual([]);
    for (const [bad, fragment] of [
      [{ ...good, source: { resource: 'nope' } }, 'not a crudResources key'],
      [
        { ...good, when: { field: 'projectId' } },
        'exactly one of values and present',
      ],
      [{ ...good, when: { field: '', present: true } }, 'when.field'],
      [
        { ...good, when: { field: 'p', present: true, x: 1 } },
        'when has unknown fields',
      ],
      [{ ...good, when: 'projectId' }, 'when is not an object'],
    ] as const)
      expect(validate(documentWith(bad)).join('\n')).toContain(fragment);
    const document = documentWith(good);
    (
      document.components!['crudResources'] as Record<
        string,
        Record<string, Record<string, unknown>>
      >
    )['workspace']!['identity']!['urlTemplate'] =
      '/orgs/{orgId}/workspaces/{workspaceId}';
    expect(validate(document).join('\n')).toContain(
      'identity variables orgId are not path parameters',
    );
  });

  it('creates take only source refusals', () => {
    const documentWith = (declaration: Record<string, unknown>): Doc => {
      const document = example();
      document.components = {
        crudResources: {
          workspace: {
            identity: {
              urlTemplate: '/workspaces/{workspaceId}',
              bindings: { workspaceId: { field: 'id' } },
            },
          },
        },
      };
      document.paths['/workspaces/{workspaceId}/entries'] = {
        post: {
          'x-crud': {
            action: 'create',
            resource: 'entry',
            url: { source: 'template' },
          },
          'x-write-precondition': declaration,
        },
      };
      return document;
    };
    const source = {
      source: { resource: 'workspace' },
      field: 'settings.forceProjects',
      values: [true],
      when: { field: 'projectId', values: [null] },
    };
    expect(
      validate(documentWith({ kind: 'none', refuseWhen: [source] })),
    ).toEqual([]);
    expect(
      validate(
        documentWith({ kind: 'none', refuseWhen: [source], idempotent: true }),
      ).join('\n'),
    ).toContain('idempotent is not for a create');
    for (const bad of [
      { kind: 'none' },
      { kind: 'readVerify', refuseWhen: [source] },
      {
        kind: 'none',
        refuseWhen: [source, { field: 'in_trash', values: [true] }],
      },
    ])
      expect(validate(documentWith(bad)).join('\n')).toContain(
        'on a create takes only kind none with source refusals',
      );
  });

  it('a source refusal fails closed', () => {
    const force = p({
      kind: 'none',
      refuseWhen: [
        {
          source: { resource: 'workspace' },
          field: 'settings.forceProjects',
          values: [true],
          when: { field: 'projectId', values: [null] },
        },
      ],
    });
    const forced = {
      workspace: { id: 'w1', settings: { forceProjects: true } },
    };
    const relaxed = {
      workspace: { id: 'w1', settings: { forceProjects: false } },
    };
    const noProject = { description: 'x' };
    const withProject = { description: 'x', projectId: 'p1' };
    const send = (body: unknown, sources?: Record<string, unknown>): string =>
      maySend(force, {}, ['description'], undefined, undefined, body, sources)
        .result;
    expect(send(noProject, forced)).toBe('refused');
    expect(send(withProject, forced)).toBe('send');
    expect(send(noProject, relaxed)).toBe('send');
    expect(send(noProject, { workspace: null })).toBe('source-unknown');
    expect(send(noProject)).toBe('source-unknown');
    expect(send(withProject, {})).toBe('send');
    const unconditional = p({
      kind: 'none',
      refuseWhen: [
        { source: { resource: 'workspace' }, field: 'locked', values: [true] },
      ],
    });
    expect(
      maySend(unconditional, {}, ['x'], undefined, undefined, {}, {}).result,
    ).toBe('source-unknown');
    expect(
      resolveUnknown(
        force,
        'PUT',
        { description: 'a' },
        { description: 'x' },
        read({ description: 'x' }),
      ),
    ).toBe('applied');
  });

  it('refusals need a read, and header versions are supported', () => {
    const refusing = p({
      kind: 'none',
      refuseWhen: [{ field: 'in_trash', values: [true] }],
    });
    expect(maySend(refusing, {}, ['x'], undefined)).toEqual({
      result: 'read-first',
    });
    const header = p({
      kind: 'ifMatch',
      version: { in: 'header', name: 'ETag' },
    });
    expect(maySend(header, {}, ['x'], { x: 1 }, { etag: '"1"' })).toEqual({
      result: 'send',
      headers: { 'If-Match': '"1"' },
    });
    expect(maySend(header, {}, ['x'], { x: 1 }, {})).toEqual({
      result: 'read-first',
    });
  });

  it('an object version is refused, never sent as text', () => {
    const declaration = p(IF_MATCH);
    for (const etag of [{ v: 1 }, ['v'], true, Number.NaN])
      expect(maySend(declaration, {}, ['summary'], { etag }).result).toBe(
        'unusable-version',
      );
    expect(maySend(declaration, {}, ['summary'], { etag: 7 })).toEqual({
      result: 'send',
      headers: { 'If-Match': '7' },
    });
  });

  it('an object passed as null was not read: read first, never compared', () => {
    expect(maySend(p(IF_MATCH), {}, ['summary'], null).result).toBe(
      'read-first',
    );
    expect(
      maySend(p({ kind: 'readVerify' }), { summary: null }, ['summary'], null)
        .result,
    ).toBe('read-first');
  });
});
