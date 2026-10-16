// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { checkLensLaws } from 'devonian/lenses';
import { AtomicStore, Datatype } from 'devonian/atomic';
import {
  solidBookmarkTerms as t,
  solidBookmarkLens as lens,
  solidBookmarkSchema,
  solidBookmarkToAtomic,
  solidBookmarkFromAtomic,
  solidBookmarkUpdatePlan,
  type ExpandedNode,
} from './index.js';

const id = 'https://pod.example/bookmarks/index.ttl#one';
const topic = 'http://www.w3.org/2002/01/bookmark#hasTopic';
const source: ExpandedNode = {
  '@id': id,
  '@type': [t.rdfClasses[0]],
  [t.titles[1]]: [{ '@value': 'Original', '@language': 'nl' }],
  [t.links[0]]: [{ '@id': 'https://example.org/article' }],
  [topic]: [{ '@value': 'Invented topic' }],
  'http://purl.org/dc/terms/created': [
    {
      '@value': '2026-10-08T12:00:00+02:00',
      '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
    },
  ],
};

function native(node = source) {
  return new AtomicStore(solidBookmarkSchema()).patch(
    'https://atomic.example/bookmarks/one',
    solidBookmarkToAtomic(node),
  );
}

describe('Solid RDF bookmark → Atomic Bookmark', () => {
  it.each(t.rdfClasses)('maps supported class %s', type => {
    const node = { ...source, '@type': [type] };
    expect(solidBookmarkFromAtomic(native(node), node)).toEqual(node);
  });
  it('preserves original predicates, language, topics and provenance through edits', () => {
    const view = { name: 'Changed', url: 'https://example.org/next' };
    expect(checkLensLaws(lens, source, view)).toEqual({
      getPut: true,
      putGet: true,
      stablePut: true,
    });
    const next = lens.put(view, source);
    expect(next).toEqual({
      ...source,
      [t.titles[1]]: [{ '@value': 'Changed', '@language': 'nl' }],
      [t.links[0]]: [{ '@id': 'https://example.org/next' }],
    });
    expect(source[t.titles[1]]).toEqual([
      { '@value': 'Original', '@language': 'nl' },
    ]);
  });
  it.each([
    { '@id': 'https://example.org/article' },
    { '@value': 'https://example.org/article' },
    {
      '@value': 'https://example.org/article',
      '@type': 'http://www.w3.org/2001/XMLSchema#string',
    },
  ])('preserves URL term encoding %s', object => {
    const node = { ...source, [t.links[0]]: [object] };
    const next = lens.put(
      { name: 'Original', url: 'https://example.org/next' },
      node,
    );
    expect(next[t.links[0]]).toEqual([
      {
        ...object,
        [Object.hasOwn(object, '@id') ? '@id' : '@value']:
          'https://example.org/next',
      },
    ]);
    expect(
      checkLensLaws(lens, node, {
        name: 'Edited',
        url: 'https://example.org/next',
      }).getPut,
    ).toBe(true);
  });
  it('supports ActivityStreams names and URLs without changing their vocabulary', () => {
    const node: ExpandedNode = {
      '@id': id,
      '@type': [t.rdfClasses[2]],
      [t.titles[2]]: [{ '@value': 'Original' }],
      [t.links[1]]: [{ '@id': 'https://example.org/article' }],
    };
    const resource = native(node);
    resource[t.name] = 'Changed';
    expect(solidBookmarkUpdatePlan(resource, node)).toEqual({
      subject: id,
      deletes: [
        {
          subject: id,
          predicate: t.titles[2],
          object: { '@value': 'Original' },
        },
      ],
      inserts: [
        {
          subject: id,
          predicate: t.titles[2],
          object: { '@value': 'Changed' },
        },
      ],
    });
  });
  it('emits no changes for a no-op and never includes unrelated graph triples', () => {
    expect(solidBookmarkUpdatePlan(native(), source)).toEqual({
      subject: id,
      deletes: [],
      inserts: [],
    });
    const resource = native();
    resource[t.url] = 'https://example.org/next';
    const plan = solidBookmarkUpdatePlan(resource, source);
    expect(plan.deletes).toHaveLength(1);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.deletes[0].predicate).toBe(t.links[0]);
    expect(JSON.stringify(plan)).not.toContain(topic);
  });
  it('does not own native descriptions and other human properties', () => {
    const description = 'https://atomicdata.dev/properties/description';
    const store = new AtomicStore(
      solidBookmarkSchema().property(description, Datatype.MARKDOWN),
    );
    const resource = store.patch('https://atomic.example/bookmarks/one', {
      set: { [description]: 'Keep' },
    });
    expect(
      store.patch(resource['@id'], solidBookmarkToAtomic(source))[description],
    ).toBe('Keep');
  });
  it.each([
    { [t.titles[0]]: [{ '@value': 'Conflicting alias' }] },
    { [t.titles[1]]: [{ '@value': 'One' }, { '@value': 'Two' }] },
    { [t.links[0]]: [{ '@value': '/relative' }] },
    { [t.links[0]]: [{ '@value': 'https://example.org', '@language': 'en' }] },
    {
      [t.links[0]]: [{ '@id': 'https://example.org', '@value': 'Conflicting' }],
    },
    {
      [t.titles[1]]: [
        {
          '@value': 'Original',
          '@type': 'http://www.w3.org/2001/XMLSchema#date',
        },
      ],
    },
    { '@type': ['https://schema.org/Movie'] },
    { '@id': '_:blank' },
  ])('rejects ambiguous or unsupported RDF %s', patch => {
    expect(() => lens.get({ ...source, ...patch })).toThrow();
  });
  it('rejects generic Notes without a bookmark URL, contexts and wrong native types', () => {
    const node = structuredClone(source);
    delete node[t.links[0]];
    expect(() => lens.get(node)).toThrow();
    expect(() =>
      lens.get({
        '@id': id,
        '@type': [t.rdfClasses[0]],
        name: 'Unexpanded',
        url: 'https://example.org',
      }),
    ).toThrow();
    const resource = native();
    resource[t.name] = 3;
    expect(() => solidBookmarkFromAtomic(resource, source)).toThrow('name');
  });
  it('refuses embedded link nodes, directional literals and extra editable view fields', () => {
    expect(() =>
      lens.get({
        ...source,
        [t.links[0]]: [
          {
            '@id': 'https://example.org',
            'https://schema.org/name': [{ '@value': 'Embedded' }],
          },
        ],
      }),
    ).toThrow('embedded');
    expect(() =>
      lens.get({
        ...source,
        [t.titles[1]]: [{ '@value': 'Original', '@direction': 'rtl' }],
      }),
    ).toThrow('literal fields');
    expect(() =>
      lens.put(
        { ...lens.get(source), other: 'Unowned' } as ReturnType<
          typeof lens.get
        >,
        source,
      ),
    ).toThrow('exactly');
  });
});
