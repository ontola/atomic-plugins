import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { fingerprint } from '../../../src/client/fingerprint.js';
import { replaceBlock, replaceOf } from '../../../src/client/replace.js';
import type { OpenApiDocument } from '../../../src/browser.js';

// CRUD Causality 0.7.0 §4.8, on the spec's own §7.8 example; after the
// reference `replace_block` and rule 28 in the spec's validate.py.

const example = load(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../openapi-extensions/spec/crud-causality/examples/replaced-notes.yaml',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as OpenApiDocument;

const withReplace = (replace: unknown): OpenApiDocument =>
  ({
    openapi: '3.0.3',
    paths: {},
    components: { crudResources: { note: { replace } } },
  }) as unknown as OpenApiDocument;

describe('replaceOf', () => {
  it('reads the spec example', () => {
    const replace = replaceOf(example, 'note');
    expect(replace).toMatchObject({
      blockedBy: [
        { field: 'attachments', when: 'nonEmpty' },
        { field: 'permissions', moreThan: 1, except: { deleted: true } },
      ],
    });
  });

  it('is undefined without a declaration', () => {
    expect(replaceOf(example, 'other')).toBeUndefined();
  });

  it('refuses what rule 28 refuses', () => {
    for (const replace of [
      [],
      { blockedBy: {} },
      { blockedBy: [{}] },
      { blockedBy: [{ field: 'a', when: 'many' }] },
      { blockedBy: [{ field: 'a', moreThan: -1 }] },
      { blockedBy: [{ field: 'a', moreThan: 1.5 }] },
      { blockedBy: [{ field: 'a', moreThan: 1, when: 'present' }] },
      { blockedBy: [{ field: 'a', except: {} }] },
    ])
      expect(replaceOf(withReplace(replace), 'note')).toHaveProperty('refused');
  });
});

describe('replaceBlock', () => {
  const replace = replaceOf(example, 'note') as Exclude<
    ReturnType<typeof replaceOf>,
    { refused: string }
  >;
  const owner = { role: 'OWNER', email: 'a@example.com' };

  it('lets a plain note be replaced', () => {
    expect(replaceBlock(replace, { name: 'notes/1' })).toBeUndefined();
    expect(replaceBlock(replace, { attachments: [] })).toBeUndefined();
    expect(replaceBlock(replace, { permissions: [owner] })).toBeUndefined();
    expect(replaceBlock(undefined, { attachments: [{}] })).toBeUndefined();
  });

  it('blocks a note with an attachment', () => {
    expect(replaceBlock(replace, { attachments: [{}] })?.field).toBe(
      'attachments',
    );
  });

  it('blocks a shared note, not counting removed collaborators', () => {
    expect(
      replaceBlock(replace, {
        permissions: [owner, { role: 'WRITER', deleted: true }],
      }),
    ).toBeUndefined();
    expect(
      replaceBlock(replace, { permissions: [owner, { role: 'WRITER' }] })
        ?.description,
    ).toBe('A new note would lose its collaborators.');
  });

  it('reads present on nested fields, null as absent', () => {
    const declared = { blockedBy: [{ field: 'a.b' }] };
    expect(replaceBlock(declared, { a: { b: 0 } })?.field).toBe('a.b');
    expect(replaceBlock(declared, { a: { b: null } })).toBeUndefined();
    expect(replaceBlock(declared, { a: {} })).toBeUndefined();
  });
});

describe('fingerprint', () => {
  it('is stable, 14 hex characters, and ignores key order', () => {
    const a = fingerprint({ title: 'Packing', body: 'x' });
    expect(a).toMatch(/^[0-9a-f]{14}$/);
    expect(fingerprint({ body: 'x', title: 'Packing' })).toBe(a);
    expect(fingerprint({ title: 'Packing', body: 'y' })).not.toBe(a);
  });
});
