// @wc-ignore-file
/**
 * Produced Classes 0.1.1-draft (`x-produces`,
 * `openapi-extensions/spec/produced-classes/`): the shared classes an object
 * of a CRUD Causality resource can be represented as, each optionally with a
 * lens IRI. Read-only metadata: nothing here fetches a class or a lens, or
 * maps a record. `checkProduces`, `absoluteIri` and `sameSubject` are ports
 * of the spec's `validate.py` (`check_list`, `absolute_uri`,
 * `same_subject`); keep them in step.
 */

/** A Produced Class Object (§4.2), without its `x-*` fields. */
export interface ProducedClass {
  /** The class subject, an absolute IRI. */
  class: string;
  /** A mapping document from this resource's objects to `class`. */
  lens?: string;
  description?: string;
}

/** One CRUD resource's `x-produces`, read or refused. */
export interface ResourceProduction {
  /** The key in `components.crudResources` (or a Swagger 2.0 document's root `x-crudResources`). */
  resource: string;
  /** The declared classes, in order; absent when the declaration does not parse. */
  classes?: ProducedClass[];
  /** Why the declaration was not read (§7 rules 2-6); absent when it was. */
  errors?: string[];
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// §3 (0.1.1): whitespace (Unicode White_Space), control characters (C0,
// DEL, C1) and U+FEFF, and the ASCII characters RFC 3987 excludes; the same
// explicit set as the spec's validate.py (`\s` differs between languages).
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\x00-\x20\x7f-\x9f<>"{}|\\^`\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;
const KNOWN = new Set(['class', 'lens', 'description']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An absolute IRI (§3; RFC 3987, every absolute URI is one): a scheme,
 * something after it, no whitespace or control characters; `http` and
 * `https` need an authority. Non-ASCII characters are allowed.
 */
export function absoluteIri(value: unknown): value is string {
  if (typeof value !== 'string' || FORBIDDEN.test(value)) return false;
  const match = SCHEME.exec(value);
  if (!match || value.length === match[0].length) return false;
  const scheme = match[0].slice(0, -1).toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    const rest = value.slice(match[0].length);
    return (
      rest.startsWith('//') && rest.length > 2 && !'/?#'.includes(rest[2]!)
    );
  }
  return true;
}

/**
 * The comparison form of §3: the scheme and, for an IRI with an authority,
 * the host lower-cased; user info, path, query and fragment exact. Two
 * subjects are the same when their forms are equal.
 */
export function sameSubject(value: string): string {
  const colon = value.indexOf(':');
  const scheme = value.slice(0, colon);
  let rest = value.slice(colon + 1);
  if (rest.startsWith('//')) {
    let end = rest.length;
    for (const stop of '/?#') {
      const found = rest.indexOf(stop, 2);
      if (found !== -1) end = Math.min(end, found);
    }
    const authority = rest.slice(2, end);
    const at = authority.lastIndexOf('@');
    const userinfo = at === -1 ? '' : authority.slice(0, at + 1);
    const host = at === -1 ? authority : authority.slice(at + 1);
    rest = '//' + userinfo + host.toLowerCase() + rest.slice(end);
  }
  return scheme.toLowerCase() + ':' + rest;
}

/** §7 rules 2-6 for one `x-produces` value: every violation, at `where`. */
export function checkProduces(value: unknown, where = 'x-produces'): string[] {
  if (!Array.isArray(value) || !value.length)
    return [`${where}: expected a nonempty array`];
  const errors: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${at}: expected an object`);
      return;
    }
    for (const key of Object.keys(entry))
      if (!KNOWN.has(key) && !key.startsWith('x-'))
        errors.push(`${at}.${key}: unknown field`);
    if (!('class' in entry)) errors.push(`${at}: class is required`);
    for (const key of ['class', 'lens'])
      if (key in entry && !absoluteIri(entry[key]))
        errors.push(`${at}.${key}: expected an absolute IRI`);
    if ('description' in entry && typeof entry['description'] !== 'string')
      errors.push(`${at}.description: expected a string`);
    const subject = entry['class'];
    if (absoluteIri(subject)) {
      const key = sameSubject(subject);
      if (seen.has(key)) errors.push(`${at}.class: ${subject} appears twice`);
      seen.add(key);
    }
  });
  return errors;
}

/**
 * The classes of one `x-produces` value, or undefined when it does not
 * parse (any §7 rule 2-6 violation: nothing is read on a guess). `x-*`
 * fields are left out.
 */
export function parseProduces(value: unknown): ProducedClass[] | undefined {
  if (checkProduces(value).length) return undefined;
  return (value as Record<string, unknown>[]).map((entry) => ({
    class: entry['class'] as string,
    ...(typeof entry['lens'] === 'string' ? { lens: entry['lens'] } : {}),
    ...(typeof entry['description'] === 'string'
      ? { description: entry['description'] }
      : {}),
  }));
}

/** The CRUD Resource Objects of a document, OpenAPI 3 or Swagger 2.0 (§4.1). */
function resourceMaps(
  document: Record<string, unknown>,
): [string, Record<string, unknown>][] {
  const found: [string, Record<string, unknown>][] = [];
  const components = document['components'];
  if (isRecord(components) && isRecord(components['crudResources']))
    found.push(['components.crudResources', components['crudResources']]);
  if (isRecord(document['x-crudResources']))
    found.push(['x-crudResources', document['x-crudResources']]);
  return found;
}

/**
 * Every CRUD resource of the document that declares `x-produces`, in
 * document order, with its classes or, when the declaration does not parse,
 * the errors (located as `<map>.<resource>.x-produces…`). Resources without
 * the field are left out.
 */
export function producedClasses(document: unknown): ResourceProduction[] {
  if (!isRecord(document)) return [];
  const result: ResourceProduction[] = [];
  for (const [location, resources] of resourceMaps(document))
    for (const [resource, definition] of Object.entries(resources)) {
      if (!isRecord(definition) || !('x-produces' in definition)) continue;
      const declared = definition['x-produces'];
      const errors = checkProduces(
        declared,
        `${location}.${resource}.x-produces`,
      );
      const classes = errors.length ? undefined : parseProduces(declared);
      result.push(
        classes ? { resource, classes } : { resource, errors: errors },
      );
    }
  return result;
}

/**
 * The resources whose declaration names `classIri` (the same subject, §3),
 * each with its Produced Class Object: the resources a consumer may offer
 * for a table of that class. A declaration that does not parse offers
 * nothing.
 */
export function resourcesProducing(
  document: unknown,
  classIri: string,
): { resource: string; produced: ProducedClass }[] {
  if (!absoluteIri(classIri)) return [];
  const wanted = sameSubject(classIri);
  const found: { resource: string; produced: ProducedClass }[] = [];
  for (const { resource, classes } of producedClasses(document))
    for (const produced of classes ?? [])
      if (sameSubject(produced.class) === wanted)
        found.push({ resource, produced });
  return found;
}

/**
 * §4.2: whether a lens document the caller fetched itself fits a Produced
 * Class Object of `source`'s resource. A lens that names its target
 * (`target.class`, as ontola/atomic-plugins' catalog lenses do) fits only
 * when that is the entry's class (the same subject); one that names its
 * source fits only when it is this provider's resource
 * (`source.record.provider` and `.resource`). A target or source of another
 * kind (a record target, an `rdf` or class source) does not fit. An entry
 * without a `lens`, or a document that is not an object, does not fit. The
 * caller treats an entry whose lens does not fit as if it had none.
 * `provider` is the openapi-directory provider key (`clockify.me`), as the
 * catalog lenses name it. The lens document's own `@id` is not compared with
 * `produced.lens`: §4.2 names only the target and the source, and a copy
 * served from elsewhere keeps the catalog's `@id`.
 */
export function lensFits(
  produced: ProducedClass,
  lens: unknown,
  source: { provider: string; resource: string },
): boolean {
  if (!produced.lens || !isRecord(lens)) return false;
  if ('target' in lens) {
    const target = lens['target'];
    const subject = isRecord(target) ? target['class'] : undefined;
    if (
      !absoluteIri(subject) ||
      sameSubject(subject) !== sameSubject(produced.class)
    )
      return false;
  }
  if ('source' in lens) {
    const from = lens['source'];
    const record = isRecord(from) ? from['record'] : undefined;
    if (
      !isRecord(record) ||
      record['provider'] !== source.provider ||
      record['resource'] !== source.resource
    )
      return false;
  }
  return true;
}
