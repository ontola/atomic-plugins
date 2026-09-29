/**
 * Solid resource server for one Atomic Server installation (QuickJS entry:
 * no Node, sockets, credential parsing or private read bypass).
 *
 * The host verifies Solid-OIDC DPoP-bound access tokens before `handle`
 * runs (`auth: dpop`) and hands over `request.caller = { webid, ... }`, or
 * `null` for an anonymous request, which then reads as the public and cannot
 * write. This file decides what a verified WebID may do (the pod's `access`
 * config), and maps Solid resources onto PlainText atoms under the pod's
 * `storage` folder: one atom per resource or container, found by its path.
 */
export const P = Object.freeze({
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  media: 'https://atomicdata.dev/properties/mimetype',
  localId: 'https://atomicdata.dev/properties/localId',
  parent: 'https://atomicdata.dev/properties/parent',
});
export const MAX_BYTES = 32768;
/** Children listed in one container representation. */
export const MAX_CHILDREN = 256;
/** Longest resource path, and deepest nesting. */
export const MAX_PATH = 1024;
export const MAX_DEPTH = 16;

const PLAIN_TEXT = 'https://atomicdata.dev/classes/PlainText';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const LDP = 'http://www.w3.org/ns/ldp#';
const SOLID = 'http://www.w3.org/ns/solid/terms#';
const PIM = 'http://www.w3.org/ns/pim/space#';
const RDF_TYPES = ['text/turtle', 'application/ld+json'];
const IMPORT_TYPES = ['text/plain', ...RDF_TYPES];
const PATCH_TYPES = 'text/n3, application/sparql-update';
const MODES = ['read', 'append', 'write'];
const EXPOSED =
  'Accept-Patch, Accept-Post, Accept-Put, Allow, Content-Type, ETag, Link, Location, Vary, WAC-Allow, WWW-Authenticate';

const route = (id, path, methods) => ({
  id,
  path,
  methods,
  principal: 'installation',
  auth: 'dpop',
  body: 'text',
  maxBodyBytes: 65536,
  cors: 'any-origin-no-credentials',
  writes: ['storage'],
});

export const manifest = {
  config: {
    key: 'solid',
    properties: {
      storage: {
        type: 'string',
        description:
          'Atomic folder that holds the pod: every Solid resource and container is a PlainText atom directly under it.',
      },
      access: {
        type: 'object',
        description:
          'Who may do what, pod-wide: {"owners": [WebID], "readers": [WebID], "appenders": [WebID], "writers": [WebID], "public": ["read"]}.',
      },
      parent: {
        type: 'string',
        description:
          'Atomic destination parent, required for reviewed import jobs.',
      },
      document: {
        type: 'object',
        description:
          'Import document: id, name, mediaType and body; required for reviewed import jobs.',
      },
    },
    required: [],
  },
  schemaVersion: 3,
  name: 'solid',
  namespace: 'atomic-plugins',
  capabilities: [
    {
      name: 'storage',
      reason:
        'Serve and store the pod’s resources as atoms in the configured folder.',
    },
  ],
  http: {
    mount: 'installation-origin',
    reason:
      'A Solid pod: Solid apps read and write its resources with Solid-OIDC (DPoP) tokens the host verifies.',
    writeTargets: [
      { id: 'storage', parent: 'config:storage', classes: [PLAIN_TEXT] },
    ],
    routes: [
      route('root', '/', ['GET', 'HEAD', 'POST']),
      route('resource', '/{*path}', [
        'GET',
        'HEAD',
        'PUT',
        'POST',
        'PATCH',
        'DELETE',
      ]),
    ],
  },
};

function fail(message) {
  throw new Error(message);
}

class HttpError extends Error {
  constructor(status, message = '', headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const refuse = (status, message, headers) => {
  throw new HttpError(status, message, headers);
};

function iri(value) {
  return (
    typeof value === 'string' &&
    /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(value) &&
    ![...value].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}

const blank = value =>
  typeof value === 'string' && /^_:[A-Za-z0-9_-]+$/.test(value);
const node = value => iri(value) || blank(value);

export function bytes(text) {
  // encodeURIComponent also rejects unpaired surrogates; QuickJS has no TextEncoder.
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}|./g, 'x').length;
}

function bounded(body) {
  if (typeof body !== 'string')
    fail('Only UTF-8 text bodies are supported; blob storage is unavailable');
  if (bytes(body) > MAX_BYTES) fail('Document exceeds 32768 UTF-8 bytes');
}

// -- IRIs --------------------------------------------------------------------

function removeDots(path) {
  const out = [];

  for (const segment of path.split('/')) {
    if (segment === '..') {
      if (out.length > 1) out.pop();
    } else if (segment !== '.') out.push(segment);
  }

  let result = out.join('/');
  if (/\/\.\.?$/.test(path) && !result.endsWith('/')) result += '/';

  return result;
}

/** RFC 3986 section 5.2 reference resolution. */
export function resolveIri(base, ref) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
  const b =
    /^([a-z][a-z0-9+.-]*:)(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(?:#.*)?$/i.exec(
      base || '',
    );
  if (!b) fail(`Cannot resolve a relative IRI without an absolute base`);
  const [, scheme, authority = '', path = '', query = ''] = b;
  if (ref.startsWith('//')) return scheme + ref;
  if (ref === '') return scheme + authority + path + query;
  if (ref[0] === '#') return scheme + authority + path + query + ref;
  if (ref[0] === '?') return scheme + authority + path + ref;
  const [, refPath, rest] = /^([^?#]*)(.*)$/.exec(ref);
  const merged =
    refPath[0] === '/'
      ? refPath
      : (authority && !path ? '/' : path.slice(0, path.lastIndexOf('/') + 1)) +
        refPath;

  return scheme + authority + removeDots(merged) + rest;
}

// -- Turtle / N3 / SPARQL Update ---------------------------------------------

/**
 * One parser for the bounded RDF 1.1 Turtle subset, N3 Patch formulas and
 * SPARQL Update data blocks. Terms: `{t: 'iri'|'bnode'|'lit'|'var'|'formula'}`.
 */
function parser(body, options = {}) {
  bounded(body);
  const { n3 = false } = options;
  let base = options.base;
  let offset = 0;
  const counters = options.counters ?? {
    statements: 0,
    expandedBytes: 0,
    subjects: new Set(),
  };
  const prefixes = new Map();
  const labels = new Map();
  let generated = 0;
  const error = () =>
    fail(`Unsupported or invalid Turtle at character ${offset}`);

  function space() {
    while (offset < body.length) {
      if (/[\t\r\n ]/.test(body[offset])) offset++;
      else if (body[offset] === '#') {
        while (offset < body.length && !/[\r\n]/.test(body[offset])) offset++;
      } else break;
    }
  }

  function take(pattern) {
    const found = pattern.exec(body.slice(offset));
    if (!found) return undefined;
    offset += found[0].length;

    return found[0];
  }

  function punctuation(mark) {
    space();
    if (body[offset] !== mark) error();
    offset++;
  }

  function escape(iriMode) {
    const code = body[offset++];

    if (code === 'u' || code === 'U') {
      const count = code === 'u' ? 4 : 8;
      const digits = body.slice(offset, offset + count);
      if (digits.length !== count || !/^[0-9A-Fa-f]+$/.test(digits)) error();
      offset += count;
      const value = Number.parseInt(digits, 16);
      if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) error();

      return String.fromCodePoint(value);
    }

    const escapes = {
      t: '\t',
      b: '\b',
      n: '\n',
      r: '\r',
      f: '\f',
      '"': '"',
      "'": "'",
      '\\': '\\',
    };
    if (iriMode || !Object.prototype.hasOwnProperty.call(escapes, code))
      error();

    return escapes[code];
  }

  function delimited(close, iriMode, long = false) {
    offset += long ? 3 : 1;
    let value = '';

    while (offset < body.length) {
      if (
        long ? body.startsWith(close.repeat(3), offset) : body[offset] === close
      ) {
        offset += long ? 3 : 1;

        return value;
      }

      const char = body[offset++];

      if (char === '\\') value += escape(iriMode);
      else {
        if (!long && (char === '\n' || char === '\r')) error();
        value += char;
      }
    }

    return error();
  }

  function absolute(value) {
    const resolved = iri(value) ? value : base ? resolveIri(base, value) : '';
    if (!iri(resolved)) error();
    bytes(resolved); // Reject invalid Unicode scalar values after escape decoding.

    return resolved;
  }

  function reference() {
    space();
    if (body[offset] === '<') return absolute(delimited('>', true));
    // This subset intentionally excludes Unicode/escaped/dotted prefixed names.
    const name = take(
      /^(?:[A-Za-z][A-Za-z0-9_-]*)?:(?:[A-Za-z0-9_][A-Za-z0-9_-]*)?/,
    );
    if (name === undefined) error();
    const colon = name.indexOf(':');
    const prefix = name.slice(0, colon);
    if (!prefixes.has(prefix)) error();
    const value = prefixes.get(prefix) + name.slice(colon + 1);
    if (!iri(value)) error();
    bytes(value);

    return value;
  }

  function label(name) {
    if (!labels.has(name)) labels.set(name, `_:b${labels.size + generated}`);

    return labels.get(name);
  }

  function fresh() {
    generated++;

    return `_:g${generated}`;
  }

  const END = '(?=[\\t\\r\\n ;,.#\\])}]|$)';

  function variable() {
    const name = take(/^\?[A-Za-z_][A-Za-z0-9_]*/);
    if (!name) error();

    return { t: 'var', v: name };
  }

  function subjectTerm(triples) {
    space();

    if (body.startsWith('_:', offset)) {
      const name = take(/^_:[A-Za-z0-9_][A-Za-z0-9_-]*/);
      if (!name) error();

      return { t: 'bnode', v: label(name) };
    }

    if (body[offset] === '[') return blankList(triples);
    if (n3 && body[offset] === '?') return variable();
    if (body[offset] === '(') error();

    return { t: 'iri', v: reference() };
  }

  function blankList(triples) {
    offset++;
    const subject = { t: 'bnode', v: fresh() };
    space();

    if (body[offset] === ']') {
      offset++;

      return subject;
    }

    predicateObjects(subject, triples);
    punctuation(']');

    return subject;
  }

  function object(triples) {
    space();
    const quote = body[offset];

    if (quote === '"' || quote === "'") {
      const long = body.startsWith(quote.repeat(3), offset);
      const value = delimited(quote, false, long);
      bytes(value);
      const result = { t: 'lit', v: value };

      if (body[offset] === '@') {
        offset++;
        const language = take(/^[A-Za-z]+(?:-[A-Za-z0-9]+)*/);
        if (!language) error();
        result.lang = language.toLowerCase();
      } else if (body.slice(offset, offset + 2) === '^^') {
        offset += 2;
        result.dt = reference();
      }

      return result;
    }

    if (n3 && quote === '{') return formula();

    const boolean = take(new RegExp(`^(?:true|false)${END}`));
    if (boolean) return { t: 'lit', v: boolean, dt: XSD + 'boolean' };
    const number = take(
      new RegExp(
        `^[+-]?(?:(?:[0-9]+\\.[0-9]*|\\.[0-9]+|[0-9]+)[eE][+-]?[0-9]+|[0-9]*\\.[0-9]+|[0-9]+)${END}`,
      ),
    );

    if (number) {
      const type = /[eE]/.test(number)
        ? 'double'
        : number.includes('.')
          ? 'decimal'
          : 'integer';

      return { t: 'lit', v: number, dt: XSD + type };
    }

    return subjectTerm(triples);
  }

  function add(triples, s, p, o) {
    if (++counters.statements > 512) fail('At most 512 RDF statements');
    counters.expandedBytes +=
      bytes(s.v) + bytes(p.v) + bytes(JSON.stringify(o)) + 32;
    if (counters.expandedBytes > MAX_BYTES)
      fail('Expanded Turtle exceeds 32768 bytes');

    if (!counters.subjects.has(s.v)) {
      if (counters.subjects.size >= 128) fail('At most 128 RDF nodes');
      counters.subjects.add(s.v);
    }

    triples.push({ s, p, o });
  }

  function predicate() {
    space();
    if (take(/^a(?=[\t\r\n <#[_"'])/)) return { t: 'iri', v: RDF_TYPE };
    if (n3 && body[offset] === '?') return variable();

    return { t: 'iri', v: reference() };
  }

  function predicateObjects(subject, triples) {
    while (true) {
      const p = predicate();

      while (true) {
        add(triples, subject, p, object(triples));
        space();
        if (body[offset] !== ',') break;
        offset++;
      }

      space();
      if (body[offset] !== ';') break;

      while (body[offset] === ';') {
        offset++;
        space();
      }

      if (['.', ']', '}'].includes(body[offset])) break;
    }
  }

  function directive() {
    const found = take(/^(?:@prefix|@base|PREFIX|BASE)(?=[\t\r\n <])/i);
    if (!found) return false;
    if (found.startsWith('@') && found !== '@prefix' && found !== '@base')
      error();
    space();

    if (/base$/i.test(found)) {
      if (body[offset] !== '<') error();
      base = absolute(delimited('>', true));
    } else {
      const prefix = take(/^(?:[A-Za-z][A-Za-z0-9_-]*)?:/);
      if (prefix === undefined) error();
      space();
      if (body[offset] !== '<') error();
      prefixes.set(prefix.slice(0, -1), reference());
    }

    if (found.startsWith('@')) punctuation('.');

    return true;
  }

  /** Statements until `close` (or the end); the last `.` before `close` is optional. */
  function statements(close) {
    const triples = [];

    while (true) {
      space();
      if (close ? body[offset] === close : offset === body.length) break;
      if (offset === body.length) error();
      if (!close && directive()) continue;
      const subject = subjectTerm(triples);
      const bare = subject.t === 'bnode' && body[offset - 1] === ']';
      space();
      if (!(bare && ['.', close].includes(body[offset])))
        predicateObjects(subject, triples);
      space();
      if (close && body[offset] === close) break;
      punctuation('.');
    }

    return triples;
  }

  function formula() {
    offset++;
    const triples = statements('}');
    punctuation('}');

    return { t: 'formula', triples };
  }

  return {
    statements,
    directive,
    space,
    take,
    punctuation,
    done: () => offset === body.length,
    at: () => offset,
    peek: () => body[offset],
  };
}

/** The Turtle subset as triples; relative IRIs need `options.base` or `@base`. */
export function parseTriples(body, options = {}) {
  return parser(body, options).statements();
}

const termId = term => term.v;

function objectJson(o) {
  if (o.t === 'iri' || o.t === 'bnode') return { '@id': o.v };
  const value = { '@value': o.v };
  if (o.lang) value['@language'] = o.lang;
  else if (o.dt) value['@type'] = o.dt;

  return value;
}

/** Triples as expanded JSON-LD nodes (rdf:type stays a predicate). */
export function triplesToGraph(triples) {
  const nodes = new Map();

  for (const { s, p, o } of triples) {
    if (!nodes.has(s.v)) nodes.set(s.v, { '@id': s.v });
    const n = nodes.get(s.v);
    if (!Object.prototype.hasOwnProperty.call(n, p.v)) n[p.v] = [];
    n[p.v].push(objectJson(o));
  }

  return [...nodes.values()];
}

/** Bounded RDF 1.1 Turtle subset as expanded JSON-LD nodes. */
export function parseTurtle(body, options = {}) {
  return triplesToGraph(parseTriples(body, options));
}

/** Expanded JSON-LD subset: named and blank nodes, absolute predicates, string literals.
 * No contexts, nested graphs, lists, or numeric precision conversion.
 */
export function parseRdf(body) {
  bounded(body);
  const graph = JSON.parse(body);
  if (!Array.isArray(graph) || graph.length > 128)
    fail('Expected up to 128 expanded JSON-LD nodes');
  let triples = 0;

  for (const n of graph) {
    if (!n || typeof n !== 'object' || Array.isArray(n) || !node(n['@id']))
      fail('Node needs an absolute or blank @id');

    for (const [predicate, values] of Object.entries(n)) {
      if (predicate === '@id') continue;

      if (predicate === '@type') {
        if (!Array.isArray(values) || !values.every(iri))
          fail('Types must be absolute IRIs');
      } else {
        if (!iri(predicate) || !Array.isArray(values))
          fail('Expected absolute predicate and value array');

        for (const value of values) {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            fail('Expected expanded value');
          const keys = Object.keys(value);
          if (keys.length === 1 && node(value['@id'])) continue;
          if (
            typeof value['@value'] !== 'string' ||
            keys.some(k => !['@value', '@type', '@language'].includes(k))
          )
            fail('Expected string literal or named node');
          bytes(value['@value']);
          if (
            '@type' in value &&
            (!iri(value['@type']) || '@language' in value)
          )
            fail('Invalid literal datatype');
          if (
            '@language' in value &&
            (typeof value['@language'] !== 'string' ||
              !/^[a-z]+(?:-[a-z0-9]+)*$/i.test(value['@language']))
          )
            fail('Invalid language');
        }
      }

      triples += values.length;
      if (triples > 512) fail('At most 512 RDF statements');
    }
  }

  return graph;
}

/** Expanded JSON-LD nodes (after [parseRdf]) as triples. */
export function graphToTriples(graph) {
  const triples = [];
  const term = v => ({ t: blank(v) ? 'bnode' : 'iri', v });

  for (const n of graph) {
    for (const [predicate, values] of Object.entries(n)) {
      if (predicate === '@id') continue;

      for (const value of values) {
        const p = { t: 'iri', v: predicate === '@type' ? RDF_TYPE : predicate };
        let o;

        if (predicate === '@type') o = term(value);
        else if ('@id' in value) o = term(value['@id']);
        else {
          o = { t: 'lit', v: value['@value'] };
          if (value['@language']) o.lang = value['@language'];
          else if (value['@type']) o.dt = value['@type'];
        }

        triples.push({ s: term(n['@id']), p, o });
      }
    }
  }

  return triples;
}

function termTurtle(t) {
  if (t.t === 'iri') return `<${t.v}>`;
  if (t.t === 'bnode') return t.v;
  let out = JSON.stringify(t.v);
  if (t.lang) out += `@${t.lang}`;
  else if (t.dt) out += `^^<${t.dt}>`;

  return out;
}

/** Triples as absolute-IRI Turtle lines, capped at [MAX_BYTES]. */
export function serializeTriples(triples) {
  const lines = [];
  let outputBytes = 0;

  for (const { s, p, o } of triples) {
    const line = `${termTurtle(s)} ${termTurtle(p)} ${termTurtle(o)} .`;
    outputBytes += bytes(line) + (lines.length ? 1 : 0);
    if (outputBytes > MAX_BYTES)
      fail('Turtle representation exceeds 32768 bytes');
    lines.push(line);
  }

  return lines.join('\n');
}

/** Absolute triple form is valid Turtle; lexical strings never become JS numbers. */
export function serializeTurtle(graph) {
  // Use the same graph subset as the expanded JSON-LD importer.
  parseRdf(JSON.stringify(graph));

  return serializeTriples(graphToTriples(graph));
}

// -- N3 Patch and SPARQL Update -----------------------------------------------

const sameTerm = (a, b) =>
  a.t === b.t &&
  a.v === b.v &&
  (a.lang || '') === (b.lang || '') &&
  (a.dt || '') === (b.dt || '');
const sameTriple = (a, b) =>
  sameTerm(a.s, b.s) && sameTerm(a.p, b.p) && sameTerm(a.o, b.o);
const termsOf = t => [t.s, t.p, t.o];

function checkPatchTerms(triples, what, { blanks, variables }) {
  for (const triple of triples)
    for (const term of termsOf(triple)) {
      if (term.t === 'formula') fail(`${what} cannot nest formulas`);
      if (term.t === 'bnode' && !blanks)
        fail(`${what} cannot contain blank nodes`);
      if (term.t === 'var' && !variables.has(term.v))
        fail(`${what} uses ${term.v}, which solid:where does not bind`);
    }
}

/** A Solid N3 Patch (Solid Protocol 5.3.1): one solid:InsertDeletePatch. */
export function parseN3Patch(body, base) {
  const triples = parseTriples(body, { base, n3: true });
  const patches = triples.filter(
    t =>
      t.p.v === RDF_TYPE &&
      t.o.t === 'iri' &&
      t.o.v === SOLID + 'InsertDeletePatch',
  );
  if (patches.length !== 1)
    fail('An N3 Patch needs exactly one solid:InsertDeletePatch');
  const subject = patches[0].s;

  const formula = name => {
    const found = triples.filter(
      t => sameTerm(t.s, subject) && t.p.v === SOLID + name,
    );
    if (found.length > 1) fail(`An N3 Patch has at most one solid:${name}`);
    if (found.length && found[0].o.t !== 'formula')
      fail(`solid:${name} must be a formula`);

    return found.length ? found[0].o.triples : [];
  };

  const where = formula('where');
  const variables = new Set(
    where
      .flatMap(termsOf)
      .filter(t => t.t === 'var')
      .map(termId),
  );
  checkPatchTerms(where, 'solid:where', { blanks: false, variables });
  const inserts = formula('inserts');
  const deletes = formula('deletes');
  checkPatchTerms(inserts, 'solid:inserts', { blanks: true, variables });
  checkPatchTerms(deletes, 'solid:deletes', { blanks: false, variables });

  return [{ where, deletes, inserts }];
}

/** SPARQL 1.1 Update, only `INSERT DATA` and `DELETE DATA` operations. */
export function parseSparqlUpdate(body, base) {
  const p = parser(body, { base });
  const operations = [];

  while (true) {
    p.space();
    if (p.done()) break;
    if (p.take(/^;/)) continue;
    if (p.directive()) continue;
    const keyword = p.take(/^(?:INSERT|DELETE)[\t\r\n ]+DATA(?=[\t\r\n {])/i);
    if (!keyword)
      fail(
        'Only SPARQL Update INSERT DATA and DELETE DATA operations are supported',
      );
    p.punctuation('{');
    const triples = p.statements('}');
    p.punctuation('}');
    const insert = /^insert/i.test(keyword);
    checkPatchTerms(triples, keyword.toUpperCase(), {
      blanks: insert,
      variables: new Set(),
    });
    operations.push({
      where: [],
      deletes: insert ? [] : triples,
      inserts: insert ? triples : [],
    });
  }

  if (!operations.length) fail('The SPARQL Update has no operations');

  return operations;
}

/** Every binding of `patterns` in `graph`; stops after two. */
function bindingsOf(patterns, graph) {
  const found = [];

  function unify(term, value, binding) {
    if (term.t !== 'var') return sameTerm(term, value) ? binding : undefined;
    const bound = binding[term.v];
    if (bound) return sameTerm(bound, value) ? binding : undefined;

    return { ...binding, [term.v]: value };
  }

  function walk(i, binding) {
    if (found.length > 1) return;

    if (i === patterns.length) {
      found.push(binding);

      return;
    }

    for (const triple of graph) {
      let b = unify(patterns[i].s, triple.s, binding);
      if (b) b = unify(patterns[i].p, triple.p, b);
      if (b) b = unify(patterns[i].o, triple.o, b);
      if (b) walk(i + 1, b);
    }
  }

  walk(0, {});

  return found;
}

/**
 * Applies patch operations to a graph. A `where` must match exactly once and
 * every delete must be present (Solid Protocol 5.3.1: otherwise 409).
 */
export function applyPatch(graph, operations, salt = 'p') {
  let triples = [...graph];
  let counter = 0;

  for (const { where, deletes, inserts } of operations) {
    let binding = {};

    if (where.length) {
      const bindings = bindingsOf(where, triples);
      if (bindings.length !== 1)
        refuse(
          409,
          `solid:where matched ${bindings.length === 0 ? 'nothing' : 'more than once'}`,
        );
      binding = bindings[0];
    }

    const blanks = new Map();

    const instance = term => {
      if (term.t === 'var') return binding[term.v];

      if (term.t === 'bnode') {
        if (!blanks.has(term.v)) blanks.set(term.v, `_:${salt}${counter++}`);

        return { t: 'bnode', v: blanks.get(term.v) };
      }

      return term;
    };

    for (const pattern of deletes) {
      const triple = {
        s: instance(pattern.s),
        p: instance(pattern.p),
        o: instance(pattern.o),
      };
      const index = triples.findIndex(t => sameTriple(t, triple));
      if (index < 0) refuse(409, 'A triple to delete is not in the resource');
      triples.splice(index, 1);
    }

    for (const pattern of inserts) {
      const triple = {
        s: instance(pattern.s),
        p: instance(pattern.p),
        o: instance(pattern.o),
      };
      if (!triples.some(t => sameTriple(t, triple))) triples.push(triple);
    }
  }

  if (triples.length > 512) refuse(413, 'At most 512 RDF statements');

  return triples;
}

// -- SHA-256 (for strong ETags; QuickJS has no crypto) -------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8(text) {
  const out = [];

  for (const char of text) {
    const c = char.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000)
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
  }

  return out;
}

export function sha256hex(text) {
  const data = utf8(text);
  const length = data.length;
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  const bits = length * 8;
  for (let i = 7; i >= 0; i--)
    data.push(
      i >= 4
        ? Math.floor(bits / 2 ** (8 * i)) & 0xff
        : (bits >>> (8 * i)) & 0xff,
    );
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let chunk = 0; chunk < data.length; chunk += 64) {
    for (let i = 0; i < 16; i++)
      w[i] =
        (data[chunk + 4 * i] << 24) |
        (data[chunk + 4 * i + 1] << 16) |
        (data[chunk + 4 * i + 2] << 8) |
        data[chunk + 4 * i + 3];

    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Strong validator of one representation (media type and exact bytes). */
export function etag(media, body) {
  return `"${sha256hex(`${media}\n${body}`).slice(0, 32)}"`;
}

// -- the reviewed import job --------------------------------------------------

function validate(body, media, base) {
  bounded(body);
  if (media === 'application/ld+json') return graphToTriples(parseRdf(body));
  if (media === 'text/turtle') return parseTriples(body, { base });

  return undefined;
}

/** Existing sandbox job verdicts become real Atomic commits only after host review. */
export function run(ctx) {
  const { parent, document } = ctx.config || {};
  if (
    !iri(parent) ||
    !document ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(document.id || '')
  )
    fail('Configure parent and document with a safe id');
  if (typeof document.name !== 'string' || document.name.length > 256)
    fail('Document name must be at most 256 characters');
  if (!IMPORT_TYPES.includes(document.mediaType))
    fail(
      'Unsupported media type; expected text/plain, text/turtle or expanded application/ld+json',
    );
  validate(document.body, document.mediaType);
  const identity = `solid:/${document.id}`;
  // Existing resources are never overwritten without a host concurrency primitive.
  if (ctx.query(P.localId, identity).length)
    fail(
      'Document already imported; conditional updates require host write support',
    );

  return {
    intents: [
      {
        op: 'create',
        localId: `solid-${document.id}`,
        parent,
        isA: [PLAIN_TEXT],
        set: {
          [P.name]: document.name,
          [P.description]: document.body,
          [P.media]: document.mediaType,
          [P.localId]: identity,
        },
      },
    ],
    problems: [],
  };
}

// -- the resource server ----------------------------------------------------

function qualityFor(header, media) {
  if (!header) return 1;
  let best = -1,
    quality = 0;

  for (const range of header.split(',')) {
    const [type, ...params] = range.trim().toLowerCase().split(';');
    const qParam = params.map(p => p.trim()).find(p => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    const specificity =
      type === media
        ? 2
        : type === media.split('/')[0] + '/*'
          ? 1
          : type === '*/*'
            ? 0
            : -1;

    if (specificity > best) {
      best = specificity;
      quality = Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0;
    }
  }

  return best >= 0 ? quality : 0;
}

/** A request path as the pod's identity: `/`, `/a/b` or `/a/b/`. */
export function podPath(raw) {
  const path = raw || '/';
  if (
    path.length > MAX_PATH ||
    path[0] !== '/' ||
    !/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(path) ||
    /%(?![0-9A-Fa-f]{2})/.test(path)
  )
    refuse(400, 'Unsupported resource path');
  const segments = path.slice(1).split('/');
  if (segments.length > MAX_DEPTH) refuse(400, 'Resource path is too deep');
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if ((!segment && !last) || segment === '.' || segment === '..')
      refuse(400, 'Unsupported resource path');
    if (/^(?:\.|%2e){1,2}$/i.test(segment))
      refuse(400, 'Unsupported resource path');
  });

  return path;
}

const isContainer = path => path.endsWith('/');

/** The containers above `path`, outermost first, without the root. */
function ancestors(path) {
  const segments = path.slice(1).split('/');
  const out = [];
  for (let i = 1; i < segments.length - (isContainer(path) ? 1 : 0); i++)
    out.push('/' + segments.slice(0, i).join('/') + '/');

  return out;
}

const containerOf = path =>
  path.slice(0, path.slice(0, -1).lastIndexOf('/') + 1);

const list = value =>
  Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];

/** What `caller` may do: the pod's `access` config (a pod-wide WAC-like map). */
export function accessModes(config, caller) {
  const access = (config && config.access) || {};
  const pub = new Set(list(access.public).filter(m => MODES.includes(m)));
  const user = new Set(pub);
  const webid = caller && caller.webid;

  if (webid) {
    if (list(access.owners).includes(webid)) MODES.forEach(m => user.add(m));
    for (const [mode, key] of [
      ['read', 'readers'],
      ['append', 'appenders'],
      ['write', 'writers'],
    ])
      if (list(access[key]).includes(webid)) user.add(mode);
  }

  if (user.has('write')) user.add('append');

  return { user, public: pub };
}

const wacAllow = modes =>
  `user="${MODES.filter(m => modes.user.has(m)).join(' ')}",public="${MODES.filter(m => modes.public.has(m)).join(' ')}"`;

function mediaOf(value) {
  const essence = (value || '').split(';')[0].trim().toLowerCase();
  if (
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(essence) ||
    essence.length > 128
  )
    return undefined;

  return essence;
}

/** The pod's atoms, as the handler's principal can read them. */
class Pod {
  constructor(ctx, request) {
    this.ctx = ctx;
    this.storage = ctx.config && ctx.config.storage;
    if (!iri(this.storage))
      refuse(503, 'This pod has no storage folder configured');
    this.base = String(request.base || '').replace(/\/$/, '');
    this.cache = new Map();
  }

  url(path) {
    return this.base + path;
  }

  inStorage(resource) {
    const parent = resource && resource[P.parent];
    const strip = s => String(s).replace(/\/$/, '');

    return typeof parent === 'string' && strip(parent) === strip(this.storage);
  }

  /** The atom at `path`, or null. */
  find(path) {
    if (this.cache.has(path)) return this.cache.get(path);
    const id = `solid:${path}`;
    let found = null;
    let subjects = [];

    try {
      subjects = this.ctx.query(P.localId, id);
    } catch {
      subjects = [];
    }

    for (const subject of subjects) {
      let resource;

      try {
        resource = this.ctx.read(subject);
      } catch {
        continue;
      }

      if (resource && resource[P.localId] === id && this.inStorage(resource)) {
        found = {
          subject,
          media: resource[P.media] || 'application/octet-stream',
          body:
            typeof resource[P.description] === 'string'
              ? resource[P.description]
              : '',
        };
        break;
      }
    }

    this.cache.set(path, found);

    return found;
  }

  exists(path) {
    return path === '/' || this.find(path) !== null;
  }

  /** Paths directly inside container `path`. */
  children(path) {
    let subjects = [];

    try {
      subjects = this.ctx.query(P.parent, this.storage);
    } catch {
      subjects = [];
    }

    const out = [];

    for (const subject of subjects) {
      let resource;

      try {
        resource = this.ctx.read(subject);
      } catch {
        continue;
      }

      const id = resource && resource[P.localId];
      if (typeof id !== 'string' || !id.startsWith(`solid:${path}`)) continue;
      const child = id.slice('solid:'.length);
      const rest = child.slice(path.length);
      if (!rest || rest.slice(0, -1).includes('/')) continue;
      out.push(child);
    }

    out.sort();

    return out;
  }
}

function headersFor(pod, path, modes, extra = {}) {
  const container = isContainer(path);
  const link = [`<${LDP}Resource>; rel="type"`];
  if (container)
    link.push(
      `<${LDP}Container>; rel="type"`,
      `<${LDP}BasicContainer>; rel="type"`,
    );
  if (path === '/') link.push(`<${PIM}Storage>; rel="type"`);
  const methods = container
    ? path === '/'
      ? 'GET, HEAD, POST'
      : 'DELETE, GET, HEAD, POST, PUT'
    : 'DELETE, GET, HEAD, PATCH, PUT';
  const out = {
    'cache-control': 'no-cache',
    vary: 'Accept, Authorization, Origin',
    'wac-allow': wacAllow(modes),
    allow: methods,
    'access-control-expose-headers': EXPOSED,
    link,
    ...extra,
  };

  if (container)
    out['accept-post'] = 'text/turtle, application/ld+json, text/plain, */*';
  else {
    out['accept-put'] = '*/*';
    out['accept-patch'] = PATCH_TYPES;
  }

  return out;
}

function unauthorized(caller) {
  return caller
    ? refuse(403, 'Your WebID may not do this on this pod')
    : refuse(401, 'Authenticate with a Solid-OIDC DPoP-bound access token', {
        'www-authenticate':
          'DPoP realm="solid", algs="ES256 RS256 PS256 EdDSA"',
      });
}

function need(modes, mode, caller) {
  if (!modes.user.has(mode)) unauthorized(caller);
}

function listHas(header, tag) {
  return header
    .split(',')
    .map(v => v.trim())
    .some(v => v === tag);
}

/** RFC 9110 section 13 for writes: 412 when the stored state is not what the client expects. */
function preconditions(headers, current) {
  const match = headers['if-match'];
  const none = headers['if-none-match'];
  if (match && (!current || (match.trim() !== '*' && !listHas(match, current))))
    refuse(412, 'The resource is not in the state If-Match expects');
  if (none && current && (none.trim() === '*' || listHas(none, current)))
    refuse(412, 'The resource is not in the state If-None-Match expects');
}

/** The RDF triples of a stored representation. */
function storedTriples(found, url) {
  try {
    return validate(found.body, found.media, url) || [];
  } catch {
    return refuse(415, 'Stored document representation is unsupported');
  }
}

function containerTriples(pod, path, found) {
  const url = pod.url(path);
  const s = { t: 'iri', v: url };
  const type = v => ({ s, p: { t: 'iri', v: RDF_TYPE }, o: { t: 'iri', v } });
  const triples = [
    type(LDP + 'BasicContainer'),
    type(LDP + 'Container'),
    type(LDP + 'Resource'),
  ];
  if (path === '/') triples.push(type(PIM + 'Storage'));
  const children = pod.children(path);
  if (children.length > MAX_CHILDREN)
    refuse(507, `This container has more than ${MAX_CHILDREN} children`);
  for (const child of children)
    triples.push({
      s,
      p: { t: 'iri', v: LDP + 'contains' },
      o: { t: 'iri', v: pod.url(child) },
    });
  if (found && found.body && RDF_TYPES.includes(found.media))
    triples.push(...storedTriples(found, url));

  return triples;
}

function represent(triples, type) {
  return type === 'text/turtle'
    ? serializeTriples(triples)
    : JSON.stringify(triplesToGraph(triples));
}

/** The representation `accept` selects, or a 406. */
function negotiate(accept, choices) {
  const selected = choices
    .map(type => ({ type, quality: qualityFor(accept, type) }))
    .sort((a, b) => b.quality - a.quality)[0];
  if (!selected || selected.quality <= 0) refuse(406, '', { vary: 'Accept' });

  return selected.type;
}

function read(pod, path, request, modes) {
  need(modes, 'read', request.caller);
  const headers = request.headers || {};
  const found = pod.find(path);
  if (!found && !(isContainer(path) && path === '/')) refuse(404, '');
  let media, body;

  if (isContainer(path)) {
    const triples = containerTriples(pod, path, found);
    media = negotiate(headers.accept, RDF_TYPES);

    try {
      body = represent(triples, media);
    } catch {
      refuse(406, '', { vary: 'Accept' });
    }
  } else {
    media = found.media;
    body = found.body;
    const rdf = RDF_TYPES.includes(media);
    const selected = negotiate(
      headers.accept,
      rdf ? [media, ...RDF_TYPES.filter(t => t !== media)] : [media],
    );
    if (selected !== media) {
      try {
        body = represent(storedTriples(found, pod.url(path)), selected);
        bounded(body);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        refuse(406, '', { vary: 'Accept' });
      }

      media = selected;
    } else if (rdf) storedTriples(found, pod.url(path));
  }

  const tag = etag(media, body);
  const out = headersFor(pod, path, modes, {
    'content-type': media,
    etag: tag,
  });
  if (!isContainer(path))
    out.link.push(
      `<${LDP}${RDF_TYPES.includes(found.media) ? 'RDFSource' : 'NonRDFSource'}>; rel="type"`,
    );
  if (
    headers['if-match'] &&
    headers['if-match'].trim() !== '*' &&
    !listHas(headers['if-match'], tag)
  )
    return { status: 412, headers: out, body: '' };
  const none = headers['if-none-match'];
  if (none && (none.trim() === '*' || listHas(none, tag)))
    return { status: 304, headers: out, body: '' };

  return {
    status: 200,
    headers: out,
    body: request.method === 'HEAD' ? '' : body,
  };
}

/** The current strong validator of a stored resource, in its stored media type. */
function currentTag(pod, path, found) {
  if (!found && path !== '/') return undefined;
  if (isContainer(path))
    return etag(
      'text/turtle',
      serializeTriples(containerTriples(pod, path, found)),
    );

  return etag(found.media, found.body);
}

function checkedBody(request, url) {
  const media = mediaOf(request.headers && request.headers['content-type']);
  if (!media) refuse(415, 'A Content-Type is required');
  const body = request.body || '';

  try {
    bounded(body);
    if (RDF_TYPES.includes(media)) validate(body, media, url);
  } catch (e) {
    refuse(RDF_TYPES.includes(media) ? 400 : 413, e.message);
  }

  return { media, body };
}

let sequence = 0;

function localId(prefix) {
  sequence++;

  return `${prefix}${sequence}`;
}

function createIntent(pod, path, media, body) {
  const set = {
    [P.name]: path,
    [P.media]: media,
    [P.localId]: `solid:${path}`,
  };
  if (body) set[P.description] = body;

  return {
    op: 'create',
    localId: localId('solid-'),
    parent: pod.storage,
    isA: [PLAIN_TEXT],
    set,
  };
}

/** Creates for the containers `path` needs, or a 409 when a document is in the way. */
function containersFor(pod, path) {
  const intents = [];

  for (const container of ancestors(path)) {
    if (pod.find(container.slice(0, -1)))
      refuse(409, `${container.slice(0, -1)} is a document, not a container`);
    if (!pod.find(container))
      intents.push(createIntent(pod, container, 'text/turtle', ''));
  }

  return intents;
}

function wantsContainer(link) {
  return /<http:\/\/www\.w3\.org\/ns\/ldp#(?:Basic)?Container>\s*;\s*rel="?type"?/i.test(
    link || '',
  );
}

function put(pod, path, request, modes) {
  const found = pod.find(path);
  need(modes, 'write', request.caller);
  preconditions(request.headers || {}, currentTag(pod, path, found));

  if (isContainer(path)) {
    if (found) refuse(409, 'Replacing a container is not supported');
    if (pod.find(path.slice(0, -1)))
      refuse(409, 'A document already has this path');
    const intents = [
      ...containersFor(pod, path),
      createIntent(pod, path, 'text/turtle', ''),
    ];

    return {
      response: {
        status: 201,
        headers: headersFor(pod, path, modes),
        body: '',
      },
      intents,
    };
  }

  if (pod.find(path + '/')) refuse(409, 'A container already has this path');
  const { media, body } = checkedBody(request, pod.url(path));
  if (found)
    return {
      response: {
        status: 204,
        headers: headersFor(pod, path, modes),
        body: '',
      },
      intents: [
        {
          op: 'set',
          subject: found.subject,
          set: { [P.media]: media, [P.description]: body },
        },
      ],
    };

  return {
    response: { status: 201, headers: headersFor(pod, path, modes), body: '' },
    intents: [
      ...containersFor(pod, path),
      createIntent(pod, path, media, body),
    ],
  };
}

function post(pod, path, request, modes) {
  need(modes, 'append', request.caller);
  if (!isContainer(path))
    refuse(405, 'POST creates resources in containers only');
  if (!pod.exists(path)) refuse(404, '');
  const headers = request.headers || {};
  const container = wantsContainer(headers.link);
  const unique =
    String((request.receivedAt ?? Date.now()) % 1e9) + '-' + sequence;
  let slug = String(headers.slug || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64);
  if (!slug) slug = unique;
  let child = path + slug + (container ? '/' : '');
  if (pod.find(child) || pod.find(container ? child.slice(0, -1) : child + '/'))
    child = path + `${slug}-${unique}` + (container ? '/' : '');
  podPath(child);
  const location = pod.url(child);
  const intents = [];

  if (container) intents.push(createIntent(pod, child, 'text/turtle', ''));
  else {
    const { media, body } = checkedBody(request, location);
    intents.push(createIntent(pod, child, media, body));
  }

  return {
    response: {
      status: 201,
      headers: headersFor(pod, path, modes, { location }),
      body: '',
    },
    intents,
  };
}

function patch(pod, path, request, modes) {
  if (isContainer(path)) refuse(409, 'PATCH on containers is not supported');
  const headers = request.headers || {};
  const type = mediaOf(headers['content-type']);
  const url = pod.url(path);
  let operations;

  try {
    if (type === 'text/n3') operations = parseN3Patch(request.body || '', url);
    else if (type === 'application/sparql-update')
      operations = parseSparqlUpdate(request.body || '', url);
    else
      refuse(415, `PATCH takes ${PATCH_TYPES}`, {
        'accept-patch': PATCH_TYPES,
      });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    refuse(422, e.message);
  }

  const deletes = operations.some(o => o.deletes.length);
  const wheres = operations.some(o => o.where.length);
  need(modes, deletes ? 'write' : 'append', request.caller);
  if (deletes || wheres) need(modes, 'read', request.caller);
  const found = pod.find(path);
  if (!found && pod.find(path + '/'))
    refuse(409, 'A container already has this path');
  preconditions(headers, currentTag(pod, path, found));
  if (found && !RDF_TYPES.includes(found.media))
    refuse(415, 'Only RDF resources can be patched');
  const media = found ? found.media : 'text/turtle';
  const triples = applyPatch(
    found ? storedTriples(found, url) : [],
    operations,
    `p${String(request.receivedAt ?? 0).slice(-6)}n`,
  );
  let body;

  try {
    body = represent(triples, media);
    bounded(body);
  } catch (e) {
    refuse(413, e.message);
  }

  const out = headersFor(pod, path, modes);
  if (found)
    return {
      response: { status: 204, headers: out, body: '' },
      intents: [
        { op: 'set', subject: found.subject, set: { [P.description]: body } },
      ],
    };

  return {
    response: { status: 201, headers: out, body: '' },
    intents: [
      ...containersFor(pod, path),
      createIntent(pod, path, media, body),
    ],
  };
}

function remove(pod, path, request, modes) {
  need(modes, 'write', request.caller);
  if (path === '/') refuse(405, 'The storage root cannot be deleted');
  const found = pod.find(path);
  if (!found) refuse(404, '');
  preconditions(request.headers || {}, currentTag(pod, path, found));
  if (isContainer(path) && pod.children(path).length)
    refuse(409, 'The container is not empty');

  return {
    response: { status: 204, headers: headersFor(pod, path, modes), body: '' },
    intents: [{ op: 'destroy', subject: found.subject }],
  };
}

function problem(error, modes) {
  const headers = {
    'cache-control': 'no-store',
    'access-control-expose-headers': EXPOSED,
    ...error.headers,
  };
  if (modes) headers['wac-allow'] = wacAllow(modes);
  if (error.message && !headers['content-type'])
    headers['content-type'] = 'text/plain; charset=utf-8';

  return { status: error.status, headers, body: error.message || '' };
}

export function handle(ctx, request) {
  let modes;

  try {
    const caller =
      request.caller && request.caller.webid ? request.caller : null;
    request = { ...request, caller };
    modes = accessModes(ctx.config, caller);
    const path = podPath(request.path);
    const pod = new Pod(ctx, request);

    switch (request.method) {
      case 'GET':
      case 'HEAD':
        return read(pod, path, request, modes);
      case 'PUT':
        return put(pod, path, request, modes);
      case 'POST':
        return post(pod, path, request, modes);
      case 'PATCH':
        return patch(pod, path, request, modes);
      case 'DELETE':
        return remove(pod, path, request, modes);
      default:
        return refuse(405, 'Method not allowed');
    }
  } catch (error) {
    if (error instanceof HttpError) return problem(error, modes);
    throw error;
  }
}
