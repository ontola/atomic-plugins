import { describe, expect, it } from 'vitest';
import {
  checkLensLaws,
  composeLenses,
  customLens,
  fieldLens,
  lensEqual,
  readOnlyLens,
  recordLens,
} from '../../src/lenses/index.js';

interface Source {
  title: string;
  body: string | null;
  hidden: { labels: string[] };
  optional?: string;
}
const original: Source = {
  title: 'Before',
  body: null,
  hidden: { labels: ['private'] },
};
const body = customLens<Source, string>({
  reads: ['body'],
  writes: ['body'],
  get: (s) => s.body ?? '',
  put: (value) => ({ set: { body: value } }),
});
const lens = recordLens<Source, { name: string; body: string }>({
  name: fieldLens<Source, 'title'>('title'),
  body,
});

describe('value lens algebra', () => {
  it('preserves hidden data and null representation while editing another field', () => {
    const updated = lens.put({ name: 'After', body: '' }, original);
    expect(updated).toEqual({ ...original, title: 'After' });
    expect(lens.put(lens.get(original), original)).toEqual(original);
    expect(
      checkLensLaws(lens, original, { name: 'After', body: 'Text' }),
    ).toEqual({
      getPut: true,
      putGet: true,
      stablePut: true,
    });
  });

  it('isolates inputs and returned values even when a custom callback mutates', () => {
    const mutating = customLens<Source, string[]>({
      reads: ['hidden'],
      writes: ['hidden'],
      get: (s) => s.hidden.labels,
      put: (labels, source) => {
        labels.push('inside');
        source.hidden.labels.push('inside');
        return { set: { hidden: { labels } } };
      },
    });
    const source = structuredClone(original);
    const desired = ['new'];
    mutating.get(source).push('outside');
    const result = mutating.put(desired, source);
    result.hidden.labels.push('outside');
    expect(source).toEqual(original);
    expect(desired).toEqual(['new']);
  });

  it('distinguishes explicit removal, absent fields and fields set to undefined', () => {
    const optional = customLens<Source, string | undefined>({
      reads: ['optional'],
      writes: ['optional'],
      get: (s) => s.optional,
      put: (value) =>
        value === undefined
          ? { unset: ['optional'] }
          : { set: { optional: value } },
    });
    expect(optional.put(undefined, { ...original, optional: 'old' })).toEqual(
      original,
    );
    expect(optional.put(undefined, original)).not.toHaveProperty('optional');
    expect(lensEqual({}, { key: undefined })).toBe(false);
    expect(lensEqual({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(lensEqual([1, 2], [2, 1])).toBe(false);
    expect(lensEqual(new Array(1), [undefined])).toBe(false);
  });

  it('rejects writes outside ownership and conflicting set/unset patches', () => {
    const invalid = customLens<Source, string>({
      reads: ['title'],
      writes: ['title'],
      get: (s) => s.title,
      put: () => ({ set: { body: 'oops' } }),
    });
    expect(() => invalid.put('After', original)).toThrow(
      'does not own field body',
    );
    const contradictory = customLens<Source, string>({
      reads: ['title'],
      writes: ['title'],
      get: (s) => s.title,
      put: () => ({ set: { title: 'After' }, unset: ['title'] }),
    });
    expect(() => contradictory.put('After', original)).toThrow(
      'both sets and removes',
    );
    expect(original.title).toBe('Before');
  });

  it('rejects overlapping ownership rather than depend on binding order', () => {
    expect(() =>
      recordLens<Source, { first: string; second: string }>({
        first: fieldLens<Source, 'title'>('title'),
        second: fieldLens<Source, 'title'>('title'),
      }),
    ).toThrow('owned by both first and second');
  });

  it('rejects unsupported view fields and missing fields', () => {
    expect(() =>
      lens.put({ name: 'After' } as { name: string; body: string }, original),
    ).toThrow('exactly the declared');
    const extra = { ...lens.get(original), extra: 1 };
    expect(() => lens.put(extra, original)).toThrow('exactly the declared');
  });

  it('allows unchanged read-only values but refuses changing them', () => {
    const partial = recordLens<Source, { name: string; labels: string[] }>({
      name: fieldLens<Source, 'title'>('title'),
      labels: readOnlyLens<Source, string[]>(
        ['hidden'],
        (s) => s.hidden.labels,
      ),
    });
    expect(
      partial.put({ name: 'After', labels: ['private'] }, original).title,
    ).toBe('After');
    expect(() => partial.put({ name: 'After', labels: [] }, original)).toThrow(
      'read-only',
    );
  });

  it('checks whole-view constraints before exposing changes', () => {
    const constrained = recordLens<Source, { name: string; body: string }>(
      {
        name: fieldLens<Source, 'title'>('title'),
        body,
      },
      (view) => {
        if (!view.name.trim()) throw new Error('Title required');
      },
    );
    expect(() =>
      constrained.put({ name: '', body: 'After' }, original),
    ).toThrow('Title required');
    expect(original).toEqual({
      title: 'Before',
      body: null,
      hidden: { labels: ['private'] },
    });
  });

  it('composes schemas and keeps hidden information at both layers', () => {
    interface Middle {
      name: string;
      body: string;
    }
    const renamed = recordLens<Middle, { heading: string }>({
      heading: fieldLens<Middle, 'name'>('name'),
    });
    const composed = composeLenses(lens, renamed);
    expect(composed.put({ heading: 'After' }, original)).toEqual({
      ...original,
      title: 'After',
    });
    expect(checkLensLaws(composed, original, { heading: 'After' })).toEqual({
      getPut: true,
      putGet: true,
      stablePut: true,
    });
  });

  it('reports an unlawful custom codec and propagates unsupported edits', () => {
    const lossy = customLens<Source, string>({
      reads: ['title'],
      writes: ['title'],
      get: (s) => s.title,
      put: (value) => ({ set: { title: value.toLowerCase() } }),
    });
    expect(checkLensLaws(lossy, original, 'AFTER').putGet).toBe(false);
    const readonly = readOnlyLens<Source, string>(['title'], (s) => s.title);
    expect(() => checkLensLaws(readonly, original, 'After')).toThrow(
      'read-only',
    );
  });
});
