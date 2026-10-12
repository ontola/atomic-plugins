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
});
