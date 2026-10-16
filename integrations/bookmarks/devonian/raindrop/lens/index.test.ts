// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { checkLensLaws } from 'devonian/lenses';
import { AtomicIdentityMap, AtomicStore, Datatype } from 'devonian/atomic';
import {
  bookmarkTerms as t,
  raindropBookmarkLens as lens,
  raindropBookmarkSchema,
  raindropToAtomic,
  raindropFromAtomic,
  raindropUpdatePlan,
  type RaindropRecord,
} from './index.js';

const source: RaindropRecord = {
  _id: 41,
  title: 'A bookmark',
  link: 'https://example.org/article',
  tags: ['invented'],
  note: 'Provider-only note',
  collection: { $id: 7 },
  created: '2026-10-01T12:00:00+02:00',
  future: { retained: true },
};
const subject = 'https://atomic.example/bookmarks/one';

function native(record = source) {
  return new AtomicStore(raindropBookmarkSchema()).patch(
    subject,
    raindropToAtomic(record),
  );
}

describe('Raindrop → Atomic Bookmark', () => {
  it.each([undefined, '', 'Notes'])(
    'satisfies laws and retains representation for excerpt %s',
    excerpt => {
      const previous = {
        ...source,
        ...(excerpt === undefined ? {} : { excerpt }),
      };
      expect(
        checkLensLaws(lens, previous, {
          name: 'Changed',
          url: 'https://example.org/next',
          description: 'Edited',
        }),
      ).toEqual({ getPut: true, putGet: true, stablePut: true });
      expect(
        lens.put({ ...lens.get(previous), name: 'Changed' }, previous),
      ).toEqual({ ...previous, title: 'Changed' });
      expect(raindropFromAtomic(native(previous), previous)).toEqual(previous);
    },
  );
  it('plans only changed, writable fields and does not mutate source or native data', () => {
    const resource = native();
    resource[t.name] = 'Changed';
    expect(raindropUpdatePlan(resource, source)).toEqual({
      id: 41,
      body: { title: 'Changed' },
    });
    expect(raindropUpdatePlan(native(), source)).toEqual({ id: 41, body: {} });
    expect(source.title).toBe('A bookmark');
    const result = raindropFromAtomic(resource, source);
    (result.future as { retained: boolean }).retained = false;
    expect(source.future).toEqual({ retained: true });
  });
  it('removes stale descriptions explicitly and preserves human native properties', () => {
    const note = 'https://atomic.example/property/human-note';
    const store = new AtomicStore(
      raindropBookmarkSchema().property(note, Datatype.STRING),
    );
    store.patch(subject, raindropToAtomic({ ...source, excerpt: 'Old' }));
    store.patch(subject, { set: { [note]: 'Keep' } });
    const resource = store.patch(subject, raindropToAtomic(source));
    expect(resource[t.description]).toBeUndefined();
    expect(resource[note]).toBe('Keep');
    expect(raindropUpdatePlan(resource, { ...source, excerpt: 'Old' })).toEqual(
      { id: 41, body: { excerpt: '' } },
    );
  });
  it('uses account-scoped numeric identity, never the destination URL', () => {
    const store = new AtomicStore(raindropBookmarkSchema());
    const identities = new AtomicIdentityMap(store, 'https://atomic.example');
    const scope = {
      scope: 'https://atomic.example/connections/a',
      entity: 'raindrop',
    };
    const a = identities.subjectFor(scope, 41);
    identities.bind(scope, 41, a);
    expect(identities.subjectFor(scope, 42)).not.toBe(a);
    expect(
      identities.subjectFor(
        { ...scope, scope: 'https://atomic.example/connections/b' },
        41,
      ),
    ).not.toBe(a);
    const restored = new AtomicStore(store.schema);
    restored.loadJSONAD(store.toJSONAD());
    expect(
      new AtomicIdentityMap(restored, 'https://atomic.example').lookup(
        scope,
        41,
      ),
    ).toBe(a);
    expect(identities.lookup(scope, '41')).toBeUndefined();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '41'])(
    'rejects invalid ID %s',
    id => {
      expect(() =>
        lens.get({ ...source, _id: id } as RaindropRecord),
      ).toThrow();
    },
  );
  it.each([
    'javascript:alert(1)',
    '/relative',
    'https://exa mple.org',
    'https://',
  ])('rejects invalid URL %s', link => {
    expect(() => lens.get({ ...source, link })).toThrow();
  });
  it('rejects wrong classes, missing required values and oversized edits', () => {
    expect(() => raindropFromAtomic({ '@id': subject }, source)).toThrow(
      'Bookmark',
    );
    const resource = native();
    delete resource[t.url];
    expect(() => raindropFromAtomic(resource, source)).toThrow();
    expect(() =>
      lens.put({ ...lens.get(source), name: 'x'.repeat(1001) }, source),
    ).toThrow('1000');
    expect(() =>
      lens.put({ ...lens.get(source), description: 'x'.repeat(10001) }, source),
    ).toThrow('10000');
  });
});
