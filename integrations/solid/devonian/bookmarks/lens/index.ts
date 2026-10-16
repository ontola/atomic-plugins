// @wc-ignore-file
/** A bounded expanded JSON-LD lens, not a JSON-LD processor or Pod client. */
import { customLens, type ValueLens } from 'devonian/lenses';
import {
  AtomicSchema,
  Datatype,
  IS_A,
  type AtomicPatch,
  type AtomicResource,
} from 'devonian/atomic';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const BOOKMARK = 'http://www.w3.org/2002/01/bookmark#';
const AS = 'https://www.w3.org/ns/activitystreams#';

export const solidBookmarkTerms = {
  rdfClasses: [BOOKMARK + 'Bookmark', BOOKMARK + 'BookMark', AS + 'Note'],
  titles: [
    'http://purl.org/dc/terms/title',
    'http://www.w3.org/2000/01/rdf-schema#label',
    AS + 'name',
  ],
  links: [BOOKMARK + 'recalls', AS + 'url'],
  class: 'https://atomicdata.dev/class/Bookmark',
  name: 'https://atomicdata.dev/properties/name',
  url: 'https://atomicdata.dev/property/url',
} as const;
export interface ExpandedNode {
  '@id': string;
  '@type': string[];
  [predicate: string]: unknown;
}
export interface SolidBookmarkView {
  name: string;
  url: string;
}
export type RdfObject = Record<string, unknown> &
  ({ '@id': string } | { '@value': string });

function httpUrl(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    /\s/u.test(value) ||
    [...value].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    !/^https?:\/\//u.test(value)
  )
    throw new Error('Expected an absolute HTTP(S) URL');
  new URL(value);
}

function selected(node: ExpandedNode, candidates: readonly string[]) {
  const present = candidates.filter(predicate =>
    Object.hasOwn(node, predicate),
  );
  if (present.length !== 1)
    throw new Error(
      'Expected exactly one supported predicate; aliases are ambiguous',
    );
  const predicate = present[0];
  const values = node[predicate];
  if (
    !Array.isArray(values) ||
    values.length !== 1 ||
    !values[0] ||
    typeof values[0] !== 'object' ||
    Array.isArray(values[0])
  )
    throw new Error('Expected exactly one RDF object');

  return { predicate, object: values[0] as RdfObject };
}

function literal(object: RdfObject, languageAllowed: boolean): string {
  if (
    Object.keys(object).some(
      key => !['@value', '@language', '@type'].includes(key),
    )
  )
    throw new Error('Unsupported RDF literal fields');
  if (Object.hasOwn(object, '@id') || typeof object['@value'] !== 'string')
    throw new Error('Expected an RDF string literal');
  const language = object['@language'];
  const type = object['@type'];
  if (
    language !== undefined &&
    (!languageAllowed || typeof language !== 'string' || !language)
  )
    throw new Error('Unsupported literal language');
  if (
    type !== undefined &&
    type !== XSD + 'string' &&
    !(language !== undefined && type === RDF + 'langString')
  )
    throw new Error('Unsupported literal datatype');
  if (language !== undefined && type === XSD + 'string')
    throw new Error('Conflicting language and datatype');

  return object['@value'];
}

function read(node: ExpandedNode): SolidBookmarkView {
  httpUrl(node['@id']);
  if (
    !Array.isArray(node['@type']) ||
    !node['@type'].every(type => typeof type === 'string') ||
    !node['@type'].some(type => solidBookmarkTerms.rdfClasses.includes(type))
  )
    throw new Error('Expected a supported RDF bookmark type');
  const name = literal(selected(node, solidBookmarkTerms.titles).object, true);
  const object = selected(node, solidBookmarkTerms.links).object;
  let url: string;
  if (Object.hasOwn(object, '@id')) {
    if (Object.keys(object).length !== 1)
      throw new Error('Expected a named RDF link without embedded node fields');
    if (
      Object.hasOwn(object, '@value') ||
      Object.hasOwn(object, '@language') ||
      Object.hasOwn(object, '@type')
    )
      throw new Error('Conflicting RDF link encoding');
    url = object['@id'] as string;
  } else url = literal(object, false);
  httpUrl(url);

  return { name, url };
}

const mapping = customLens<ExpandedNode, SolidBookmarkView>({
  reads: [
    '@id',
    '@type',
    ...solidBookmarkTerms.titles,
    ...solidBookmarkTerms.links,
  ],
  writes: [...solidBookmarkTerms.titles, ...solidBookmarkTerms.links],
  get: read,
  put: (view, previous) => {
    const before = read(previous);
    const set: Partial<ExpandedNode> = {};

    if (view.name !== before.name) {
      const { predicate, object } = selected(
        previous,
        solidBookmarkTerms.titles,
      );
      set[predicate] = [{ ...object, '@value': view.name }];
    }

    if (view.url !== before.url) {
      const { predicate, object } = selected(
        previous,
        solidBookmarkTerms.links,
      );
      set[predicate] = [
        {
          ...object,
          [Object.hasOwn(object, '@id') ? '@id' : '@value']: view.url,
        },
      ];
    }

    return { set };
  },
});

export const solidBookmarkLens: ValueLens<ExpandedNode, SolidBookmarkView> =
  Object.freeze({
    ...mapping,
    put(view: SolidBookmarkView, previous: ExpandedNode) {
      read(previous);
      if (
        Object.keys(view).length !== 2 ||
        !Object.hasOwn(view, 'name') ||
        !Object.hasOwn(view, 'url')
      )
        throw new Error('Expected exactly name and url view fields');
      if (typeof view.name !== 'string')
        throw new Error('Expected a bookmark name');
      httpUrl(view.url);

      return mapping.put(view, previous);
    },
  });
export function solidBookmarkSchema(): AtomicSchema {
  return new AtomicSchema()
    .property(solidBookmarkTerms.name, Datatype.STRING)
    .property(solidBookmarkTerms.url, Datatype.STRING);
}
/** Never owns description, topics, timestamps, external authors or CRDT data. */
export function solidBookmarkToAtomic(node: ExpandedNode): AtomicPatch {
  const view = solidBookmarkLens.get(node);

  return {
    set: {
      [IS_A]: [solidBookmarkTerms.class],
      [solidBookmarkTerms.name]: view.name,
      [solidBookmarkTerms.url]: view.url,
    },
  };
}
export function solidBookmarkFromAtomic(
  resource: AtomicResource,
  previous: ExpandedNode,
): ExpandedNode {
  const classes = resource[IS_A];
  if (!Array.isArray(classes) || !classes.includes(solidBookmarkTerms.class))
    throw new Error('Expected an Atomic Bookmark');

  return solidBookmarkLens.put(
    {
      name: resource[solidBookmarkTerms.name] as string,
      url: resource[solidBookmarkTerms.url] as string,
    },
    previous,
  );
}
export interface RdfTriple {
  subject: string;
  predicate: string;
  object: RdfObject;
}
/** Semantic triple delta only. An RDF/Pod host must preserve the entire dataset,
 * apply concurrency checks and, where present, honor its CRDT protocol. */
export function solidBookmarkUpdatePlan(
  resource: AtomicResource,
  previous: ExpandedNode,
) {
  const next = solidBookmarkFromAtomic(resource, previous);
  const deletes: RdfTriple[] = [];
  const inserts: RdfTriple[] = [];

  for (const candidates of [
    solidBookmarkTerms.titles,
    solidBookmarkTerms.links,
  ]) {
    const before = selected(previous, candidates);
    const after = selected(next, candidates);
    if (JSON.stringify(before.object) === JSON.stringify(after.object))
      continue;
    deletes.push({
      subject: previous['@id'],
      predicate: before.predicate,
      object: structuredClone(before.object),
    });
    inserts.push({
      subject: previous['@id'],
      predicate: after.predicate,
      object: structuredClone(after.object),
    });
  }

  return { subject: previous['@id'], deletes, inserts };
}
