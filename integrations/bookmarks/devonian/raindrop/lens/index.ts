// @wc-ignore-file
/** Passive existing-record prototype. No transport or app adoption. */
import {
  customLens,
  fieldLens,
  recordLens,
  type ValueLens,
} from 'devonian/lenses';
import {
  AtomicSchema,
  Datatype,
  IS_A,
  type AtomicPatch,
  type AtomicResource,
} from 'devonian/atomic';

export const bookmarkTerms = {
  class: 'https://atomicdata.dev/class/Bookmark',
  name: 'https://atomicdata.dev/properties/name',
  url: 'https://atomicdata.dev/property/url',
  description: 'https://atomicdata.dev/properties/description',
} as const;

export interface RaindropRecord {
  _id: number;
  title: string;
  link: string;
  excerpt?: string;
  [field: string]: unknown;
}
export interface BookmarkView {
  name: string;
  url: string;
  description: string;
}

function validateView(view: BookmarkView): void {
  if (typeof view.name !== 'string' || view.name.length > 1000)
    throw new Error(
      'Raindrop title must be a string of at most 1000 UTF-16 code units',
    );
  if (typeof view.description !== 'string' || view.description.length > 10000)
    throw new Error(
      'Raindrop excerpt must be a string of at most 10000 UTF-16 code units',
    );
  if (
    typeof view.url !== 'string' ||
    /\s/u.test(view.url) ||
    [...view.url].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    !/^https?:\/\//u.test(view.url)
  )
    throw new Error('Expected an absolute HTTP(S) bookmark URL');
  new URL(view.url);
}

function validateSource(source: RaindropRecord): void {
  if (!Number.isSafeInteger(source._id) || source._id <= 0)
    throw new Error('Raindrop requires a positive safe integer ID');
  if (source.excerpt !== undefined && typeof source.excerpt !== 'string')
    throw new Error('Raindrop excerpt must be a string when present');
  validateView({
    name: source.title,
    url: source.link,
    description: source.excerpt ?? '',
  });
}

const mapping = recordLens<RaindropRecord, BookmarkView>({
  name: fieldLens<RaindropRecord, 'title'>('title'),
  url: fieldLens<RaindropRecord, 'link'>('link'),
  description: customLens({
    reads: ['excerpt'],
    writes: ['excerpt'],
    get: (source: RaindropRecord) => source.excerpt ?? '',
    put: (excerpt: string) => ({ set: { excerpt } }),
  }),
});

export const raindropBookmarkLens: ValueLens<RaindropRecord, BookmarkView> =
  Object.freeze({
    ...mapping,
    get(source: RaindropRecord) {
      validateSource(source);

      return mapping.get(source);
    },
    put(view: BookmarkView, previous: RaindropRecord) {
      validateSource(previous);
      validateView(view);

      return mapping.put(view, previous);
    },
  });

export function raindropBookmarkSchema(): AtomicSchema {
  return new AtomicSchema()
    .property(bookmarkTerms.name, Datatype.STRING)
    .property(bookmarkTerms.url, Datatype.STRING)
    .property(bookmarkTerms.description, Datatype.MARKDOWN);
}
/** Managed fields only. Absent excerpt explicitly removes a stale description. */
export function raindropToAtomic(source: RaindropRecord): AtomicPatch {
  const view = raindropBookmarkLens.get(source);

  return {
    set: {
      [IS_A]: [bookmarkTerms.class],
      [bookmarkTerms.name]: view.name,
      [bookmarkTerms.url]: view.url,
      ...(source.excerpt !== undefined
        ? { [bookmarkTerms.description]: view.description }
        : {}),
    },
    unset: source.excerpt === undefined ? [bookmarkTerms.description] : [],
  };
}
export function raindropFromAtomic(
  resource: AtomicResource,
  previous: RaindropRecord,
): RaindropRecord {
  const classes = resource[IS_A];
  if (!Array.isArray(classes) || !classes.includes(bookmarkTerms.class))
    throw new Error('Expected an Atomic Bookmark');

  return raindropBookmarkLens.put(
    {
      name: resource[bookmarkTerms.name] as string,
      url: resource[bookmarkTerms.url] as string,
      // Missing optional description is an explicit clear, never "keep old".
      description: (resource[bookmarkTerms.description] ?? '') as string,
    },
    previous,
  );
}
/** PUT /rest/v1/raindrop/{id}; the host owns credentials and execution. */
export function raindropUpdatePlan(
  resource: AtomicResource,
  previous: RaindropRecord,
) {
  const next = raindropFromAtomic(resource, previous);
  const body: { title?: string; link?: string; excerpt?: string } = {};
  if (next.title !== previous.title) body.title = next.title;
  if (next.link !== previous.link) body.link = next.link;
  if (next.excerpt !== previous.excerpt) body.excerpt = next.excerpt;

  return { id: previous._id, body };
}
