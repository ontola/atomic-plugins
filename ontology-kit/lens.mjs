/**
 * The declarative lens interpreter for the shared lens catalog
 * (`ontology-kit/LENSES.md`): one pure, synchronous, browser-safe module that
 * reads a `LensMapping` and runs it both ways. No Node built-ins, no network,
 * no clock, so a plugin or a host can bundle it like `resolver.mjs`.
 *
 * A mapping is data, never code:
 *
 *   { version: 2, fields: [{ source, target, convert?, args?, readOnly? }] }
 *
 * - `source` and `target` are references into a row: an absolute URL is a
 *   top-level key (a property subject, as Atomic rows are keyed); a string
 *   that starts with `/` is a JSON Pointer (RFC 6901) into a nested record,
 *   such as a provider's JSON or an expanded JSON-LD node.
 * - `convert` names one of `CONVERTERS`, with `args` where it takes any.
 *   Only `identity` and `ms-to-iso` existed in v1.
 * - `readOnly: true`: the lens never writes this field's source. A changed
 *   value in a forward `put` throws; an unchanged one is ignored.
 *
 * `version: 1` (ontola/atomic-server#2069's `LensMapping`) is read as the
 * same thing, with every reference a top-level key taken verbatim. The one
 * behavioural difference: `put` writes only the fields whose value changed
 * (Devonian's unchanged-value preservation), where #2069's `lensPut` rewrote
 * every mapped field. The results differ only where a converter would have
 * re-encoded an unchanged value (an ISO string without milliseconds, read and
 * written back through `ms-to-iso`).
 *
 * Laws, checked on each catalog lens's examples: GetPut (`put(get(s), s)`
 * equals `s`), PutGet (`get(put(v, s))` equals `v` on the mapped fields) and
 * stable put. Fields the mapping does not reference keep their value on
 * `put`, so a round trip never loses what the other side cannot see.
 */

export const LENS_MAPPING_VERSIONS = Object.freeze([1, 2]);

/** A lens refused a value or an edit. `code` is stable; the message is not. */
export class LensError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LensError';
    this.code = code;
  }
}

const isPlainObject = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * Structural equality for JSON-like values: key order is ignored, array
 * order is not, a missing key differs from one set to undefined.
 */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;

    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;

  return keys.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

const clone = value =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------- references

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:[^\s]+$/i;

/** The kind of a v2 reference, or undefined when it is neither. */
export function referenceKind(ref) {
  if (typeof ref !== 'string' || !ref) return undefined;
  if (ref.startsWith('/')) return 'pointer';
  if (ABSOLUTE.test(ref)) return 'key';

  return undefined;
}

/** A JSON Pointer's tokens, unescaped (`~1` is `/`, `~0` is `~`). */
export function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/'))
    throw new LensError('bad-reference', `"${pointer}" is not a JSON Pointer`);

  return pointer
    .slice(1)
    .split('/')
    .map(token => {
      if (/~[^01]|~$/.test(token))
        throw new LensError(
          'bad-reference',
          `"${pointer}" has a bad ~ escape (only ~0 and ~1)`,
        );

      return token.replaceAll('~1', '/').replaceAll('~0', '~');
    });
}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/** The tokens a reference addresses: one key, or a pointer's path. */
function tokensOf(ref, version) {
  if (version === 1) return [ref];

  return referenceKind(ref) === 'pointer' ? pointerTokens(ref) : [ref];
}

function readAt(row, tokens) {
  let here = row;

  for (const token of tokens) {
    if (Array.isArray(here)) {
      if (!ARRAY_INDEX.test(token)) return undefined;
      here = here[Number(token)];
    } else if (isPlainObject(here)) {
      if (!Object.hasOwn(here, token)) return undefined;
      here = here[token];
    } else return undefined;
  }

  return here;
}

/**
 * Writes `value` at `tokens` inside `row` (mutating it), creating missing
 * containers: an array when the next token is an index, an object otherwise.
 * Siblings along the path are kept, so `/title/0/@value` keeps `@language`.
 */
function writeAt(row, tokens, value) {
  let here = row;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const last = i === tokens.length - 1;

    if (Array.isArray(here)) {
      if (!ARRAY_INDEX.test(token) || Number(token) > here.length)
        throw new LensError(
          'bad-path',
          `cannot write array index "${token}" of an array of ${here.length}`,
        );
    } else if (!isPlainObject(here))
      throw new LensError('bad-path', `cannot write into a ${typeof here}`);

    if (last) {
      here[Array.isArray(here) ? Number(token) : token] = value;

      return;
    }

    const key = Array.isArray(here) ? Number(token) : token;
    if (here[key] === undefined || here[key] === null)
      here[key] = ARRAY_INDEX.test(tokens[i + 1]) ? [] : {};
    here = here[key];
  }
}

// ---------------------------------------------------------------- converters

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds of an ISO 8601 instant, refusing lost precision. */
function isoToMs(value) {
  if (typeof value !== 'string')
    throw new LensError('bad-value', `expected an ISO 8601 instant string`);
  const m = ISO_INSTANT.exec(value);
  if (!m) throw new LensError('bad-value', `"${value}" is not an ISO instant`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms))
    throw new LensError('bad-value', `"${value}" is not a valid instant`);
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (day.getUTCDate() !== +m[3] || day.getUTCMonth() !== +m[2] - 1)
    throw new LensError('bad-value', `"${value}" is not a calendar date`);
  if (m[7] && /[1-9]/.test(m[7].slice(3)))
    throw new LensError(
      'precision',
      `"${value}" has sub-millisecond digits an Atomic timestamp cannot hold`,
    );

  return ms;
}

function msToIso(value) {
  if (!Number.isSafeInteger(value))
    throw new LensError('bad-value', 'expected integer epoch milliseconds');

  return new Date(value).toISOString();
}

function msToIsoSeconds(value) {
  if (!Number.isSafeInteger(value) || value % 1000 !== 0)
    throw new LensError(
      'precision',
      'this side keeps whole seconds; the value has milliseconds',
    );

  return new Date(value).toISOString().replace(/\.000Z$/, 'Z');
}

const CIVIL_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

function dayOf(value) {
  const m = typeof value === 'string' ? CIVIL_DAY.exec(value) : null;
  if (!m || m[1] === '0000')
    throw new LensError('bad-value', `expected a date or date-time string`);
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (day.getUTCDate() !== +m[3] || day.getUTCMonth() !== +m[2] - 1)
    throw new LensError('bad-value', `"${value}" is not a calendar date`);

  return value.slice(0, 10);
}

function pairsOf(args) {
  const pairs = args?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0)
    throw new LensError('bad-args', 'map needs args.pairs: [[source, target]]');

  for (const pair of pairs)
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new LensError('bad-args', 'every map pair is [source, target]');

  for (const side of [0, 1])
    for (let i = 0; i < pairs.length; i++)
      for (let j = i + 1; j < pairs.length; j++)
        if (deepEqual(pairs[i][side], pairs[j][side]))
          throw new LensError(
            'bad-args',
            `map is not one-to-one: ${JSON.stringify(pairs[i][side])} twice`,
          );

  return pairs;
}

function lookup(pairs, from, to, value) {
  const pair = pairs.find(p => deepEqual(p[from], value));
  if (!pair)
    throw new LensError(
      'unmapped-value',
      `${JSON.stringify(value)} is not in the lens's value map`,
    );

  return clone(pair[to]);
}

/**
 * Named converters. `get` maps a source value to a target value, `put` back.
 * A converter without `put` is one-way and only allowed on a `readOnly`
 * field. Every converter is total on its declared domain and throws a
 * `LensError` outside it: no silent coercion, no lost precision.
 */
export const CONVERTERS = Object.freeze({
  identity: Object.freeze({
    get: value => clone(value),
    put: value => clone(value),
    v1: true,
  }),
  /** Source epoch ms (an Atomic timestamp), target ISO 8601 (#2069). */
  'ms-to-iso': Object.freeze({ get: msToIso, put: isoToMs, v1: true }),
  /** Source ISO 8601 instant, target epoch ms; writes keep milliseconds. */
  'iso-to-ms': Object.freeze({ get: isoToMs, put: msToIso }),
  /** Source ISO 8601 instant in whole seconds, target epoch ms. A put with
   * milliseconds throws instead of truncating; it writes `…:SSZ`. */
  'iso-seconds-to-ms': Object.freeze({ get: isoToMs, put: msToIsoSeconds }),
  /** A one-to-one value table, `args.pairs: [[source, target], …]`. */
  map: Object.freeze({
    get: (value, args) => lookup(pairsOf(args), 0, 1, value),
    put: (value, args) => lookup(pairsOf(args), 1, 0, value),
    takesArgs: true,
  }),
  /** A date or date-time string to its civil day, `YYYY-MM-DD`. One-way. */
  'day-of': Object.freeze({ get: dayOf }),
});

// ---------------------------------------------------------------- mappings

const FIELD_KEYS = new Set(['source', 'target', 'convert', 'args', 'readOnly']);

/** Two references on one side overlap when one is a prefix of the other. */
function overlaps(a, b) {
  const n = Math.min(a.length, b.length);

  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;

  return true;
}

/**
 * Reads a stored mapping (an object, or its JSON text) and returns it frozen
 * with each field's parsed paths, or throws a `LensError` saying why it is
 * not one. Rejects overlapping ownership as #2069 and Devonian's
 * `recordLens` do: two fields reading or writing one place would make `put`
 * order-dependent, and the laws fail.
 */
export function parseMapping(input) {
  let raw = input;

  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new LensError('bad-mapping', 'a lens mapping is JSON');
    }
  }

  if (!isPlainObject(raw) || !LENS_MAPPING_VERSIONS.includes(raw.version))
    throw new LensError(
      'bad-mapping',
      `a lens mapping needs "version": ${LENS_MAPPING_VERSIONS.join(' or ')}`,
    );
  const { version, fields } = raw;
  const extra = Object.keys(raw).filter(
    k => !['version', 'fields'].includes(k),
  );
  if (extra.length)
    throw new LensError('bad-mapping', `unknown keys: ${extra.join(', ')}`);
  if (!Array.isArray(fields) || fields.length === 0)
    throw new LensError(
      'bad-mapping',
      'a lens mapping needs at least one field',
    );

  const parsed = fields.map((field, i) => {
    const at = `field ${i}`;
    if (!isPlainObject(field))
      throw new LensError('bad-mapping', `${at} is not an object`);
    const unknown = Object.keys(field).filter(k => !FIELD_KEYS.has(k));
    if (unknown.length)
      throw new LensError(
        'bad-mapping',
        `${at}: unknown ${unknown.join(', ')}`,
      );

    for (const side of ['source', 'target']) {
      const ref = field[side];
      if (typeof ref !== 'string' || !ref)
        throw new LensError('bad-mapping', `${at} needs a ${side} reference`);
      if (version === 2 && !referenceKind(ref))
        throw new LensError(
          'bad-reference',
          `${at}: ${side} "${ref}" is neither an absolute URL nor a JSON Pointer`,
        );
    }

    const name = field.convert ?? 'identity';
    const converter = Object.hasOwn(CONVERTERS, name)
      ? CONVERTERS[name]
      : undefined;
    if (!converter || (version === 1 && !converter.v1))
      throw new LensError('bad-mapping', `unknown converter: ${name}`);
    if (field.args !== undefined && !converter.takesArgs)
      throw new LensError('bad-mapping', `${at}: ${name} takes no args`);
    if (converter.takesArgs) pairsOf(field.args);
    if (field.readOnly !== undefined && typeof field.readOnly !== 'boolean')
      throw new LensError('bad-mapping', `${at}: readOnly is true or false`);
    if (version === 1 && field.readOnly !== undefined)
      throw new LensError('bad-mapping', `${at}: readOnly needs version 2`);
    if (!converter.put && !field.readOnly)
      throw new LensError(
        'bad-mapping',
        `${at}: ${name} is one-way, so the field must be readOnly`,
      );

    return Object.freeze({
      ...field,
      sourcePath: Object.freeze(tokensOf(field.source, version)),
      targetPath: Object.freeze(tokensOf(field.target, version)),
      converter,
    });
  });

  for (const [side, path] of [
    ['source', 'sourcePath'],
    ['target', 'targetPath'],
  ])
    for (let i = 0; i < parsed.length; i++)
      for (let j = i + 1; j < parsed.length; j++)
        if (overlaps(parsed[i][path], parsed[j][path]))
          throw new LensError(
            'overlap',
            `Two fields ${side === 'source' ? 'read' : 'write'} ${parsed[i][side]}${parsed[i][side] === parsed[j][side] ? '' : ` and ${parsed[j][side]}`}`,
          );

  return Object.freeze({ version, fields: Object.freeze(parsed) });
}

const parsedOf = mapping =>
  mapping?.fields?.[0]?.sourcePath ? mapping : parseMapping(mapping);

/** The mapping as stored: without the parsed paths, keys in a fixed order. */
export function storedMapping(mapping) {
  const { version, fields } = parsedOf(mapping);

  return {
    version,
    fields: fields.map(f => {
      const out = { source: f.source, target: f.target };
      if (f.convert !== undefined) out.convert = f.convert;
      if (f.args !== undefined) out.args = clone(f.args);
      if (f.readOnly !== undefined) out.readOnly = f.readOnly;

      return out;
    }),
  };
}

/**
 * The row as the other side sees it. `forward` reads the source shape and
 * produces the target shape; `backward` the reverse, skipping one-way
 * fields (they have no inverse). Unmapped properties are dropped; a mapped
 * place that is absent in the row is absent in the result.
 */
export function lensGet(mapping, row, direction = 'forward') {
  const { fields } = parsedOf(mapping);
  const out = {};

  for (const field of fields) {
    const forward = direction === 'forward';
    if (!forward && !field.converter.put) continue;
    const value = readAt(row, forward ? field.sourcePath : field.targetPath);
    if (value === undefined) continue;
    const convert = forward ? field.converter.get : field.converter.put;
    writeAt(
      out,
      forward ? field.targetPath : field.sourcePath,
      convert(value, field.args),
    );
  }

  return out;
}

/**
 * A changed view written back onto the row it came from. Only fields whose
 * view value differs from what `get` reads from `previous` are written, so
 * unchanged values keep their exact representation; a field absent from the
 * view is left alone (removal is not expressible in v2). Places the mapping
 * does not reference keep their value. Throws `LensError('read-only')` on a
 * changed read-only field in the forward direction.
 */
export function lensPut(mapping, view, previous, direction = 'forward') {
  const parsed = parsedOf(mapping);
  const current = lensGet(parsed, previous, direction);
  const next = clone(previous) ?? {};

  for (const field of parsed.fields) {
    const forward = direction === 'forward';
    const viewPath = forward ? field.targetPath : field.sourcePath;
    const rowPath = forward ? field.sourcePath : field.targetPath;
    if (!forward && !field.converter.put) continue;
    const wanted = readAt(view, viewPath);
    if (wanted === undefined || deepEqual(wanted, readAt(current, viewPath)))
      continue;
    if (forward && field.readOnly)
      throw new LensError(
        'read-only',
        `${field.target} is read-only through this lens: ${field.source} is never written`,
      );
    const convert = forward ? field.converter.put : field.converter.get;
    writeAt(next, rowPath, convert(wanted, field.args));
  }

  return next;
}

/** Runs `get` along a chain of `{ mapping, direction }` steps (≤ 2 in a host). */
export function getAlongPath(steps, row) {
  return steps.reduce(
    (current, step) => lensGet(step.mapping, current, step.direction),
    row,
  );
}

/**
 * The three example-based laws for one lens and one source row, as a list
 * of failures (empty when all hold): GetPut, PutGet for `desired` (a target
 * view) and stable put. Exceptions propagate.
 */
export function lawProblems(mapping, source, desired) {
  const problems = [];
  const view = lensGet(mapping, source);
  if (!deepEqual(lensPut(mapping, view, source), source))
    problems.push('GetPut: putting the unchanged view changed the source');

  if (desired !== undefined) {
    const updated = lensPut(mapping, desired, source);
    const got = lensGet(mapping, updated);

    for (const field of parsedOf(mapping).fields) {
      const want = readAt(desired, field.targetPath);
      if (want !== undefined && !deepEqual(readAt(got, field.targetPath), want))
        problems.push(`PutGet: ${field.target} did not read back as written`);
    }

    if (!deepEqual(lensPut(mapping, desired, updated), updated))
      problems.push('stable put: putting the same view twice changed it');
  }

  return problems;
}

// ---------------------------------------------------------------- catalog

/**
 * The string a lens endpoint is known by in an offer search (#2069's
 * `source`/`target`): a class's subject, or for a provider record or an RDF
 * node, a provisional key until the produced-class declaration (pieces.md
 * I1, O8) gives derived classes a subject. LENSES.md, "Endpoints".
 */
export function endpointKey(endpoint) {
  if (typeof endpoint?.class === 'string') return endpoint.class;
  const r = endpoint?.record;
  if (r) return `record:${r.openapi ?? r.provider}#${r.resource}`;
  if (typeof endpoint?.rdf === 'string') return `rdf:${endpoint.rdf}`;
  throw new LensError('bad-endpoint', 'an endpoint is a class, record or rdf');
}

/**
 * A published catalog lens in the shape #2069's `loadLensCatalog()` returns
 * (`CatalogLens`), plus `mappingVersion` so a v1-only host can skip what it
 * cannot run instead of failing.
 */
export function catalogLensInfo(lens) {
  return {
    subject: lens['@id'],
    name: lens.name,
    source: endpointKey(lens.source),
    target: endpointKey(lens.target),
    mapping: lens.mapping,
    mappingVersion: lens.mapping.version,
  };
}

/**
 * A lens between two classes as a `resolver.mjs` lens hook (`{ from, to,
 * read, write }`), so a view's resolver and an integration's sync run the
 * same interpreter (pieces.md L4). Only for lenses whose endpoints are both
 * classes, keyed by property subjects.
 */
export function resolverLens(lens) {
  if (
    typeof lens.source?.class !== 'string' ||
    typeof lens.target?.class !== 'string'
  )
    throw new LensError(
      'bad-endpoint',
      'resolverLens needs two class endpoints',
    );
  const mapping = parseMapping(lens.mapping);

  return {
    from: lens.source.class,
    to: lens.target.class,
    read: row => lensGet(mapping, row),
    write: (patch, row) => {
      const next = lensPut(mapping, patch, row);
      const changed = {};

      for (const key of Object.keys(next))
        if (!deepEqual(next[key], row[key])) changed[key] = next[key];

      return changed;
    },
  };
}
