/* eslint-disable no-control-regex -- Protocol validation must reject control characters. */
/** QuickJS-compatible remoteStorage server: WebFinger, the OAuth implicit
 * grant through the host's consent page and bearer tokens, and the storage
 * API (GET/HEAD/PUT/DELETE, folder listings, ETags and conditional requests)
 * over Atomic File resources and the host's blob store. Also a reviewed
 * importer for JSON text exports.
 * No network, filesystem, Buffer, URL, crypto or browser globals are required.
 */
export const P = Object.freeze({
  parent: 'https://atomicdata.dev/properties/parent',
  name: 'https://atomicdata.dev/properties/name',
  localId: 'https://atomicdata.dev/properties/localId',
  baseline: 'https://atomicdata.dev/properties/importBaseline',
  content: 'https://atomicdata.dev/properties/description',
  blob: 'https://atomicdata.dev/properties/blob',
  filename: 'https://atomicdata.dev/properties/filename',
  filesize: 'https://atomicdata.dev/properties/filesize',
  mimetype: 'https://atomicdata.dev/properties/mimetype',
  downloadURL: 'https://atomicdata.dev/properties/downloadURL',
});
export const FILE = 'https://atomicdata.dev/classes/File';
export const SPEC_VERSION = 'draft-dejong-remotestorage-22';
const MAX_BYTES = 262144;
const MAX_RECORDS = 128;
/** Documents one storage may hold: every listing and every write reads them all. */
export const MAX_DOCUMENTS = 1000;
/** Bytes per PUT body, the host's default blob route limit (16 MiB). */
export const MAX_DOCUMENT_BYTES = 16777216;
const FOLDER_CONTEXT = 'http://remotestorage.io/spec/folder-description';

const STORAGE_CORS = {
  'access-control-expose-headers':
    'ETag, Content-Type, Content-Length, WWW-Authenticate',
};

export const manifest = {
  schemaVersion: 3,
  name: 'remotestorage',
  namespace: 'atomic-plugins',
  version: '0.3.0',
  description:
    'A remoteStorage server for this drive: apps connect with a user address, you approve per category, and documents are stored as Atomic Files.',
  operations: [],
  secrets: [],
  capabilities: [
    {
      name: 'storage',
      reason:
        'Read and write this plugin’s own Files under the configured folder; propose reviewed document import intents.',
    },
  ],
  config: {
    key: 'remotestorage',
    properties: {
      table: {
        type: 'string',
        description:
          'Folder resource the documents are stored in (as Files) and imports go to',
      },
      user: {
        type: 'string',
        description:
          'The user name in the remoteStorage address (name@host); any name when unset',
      },
    },
    required: ['table'],
  },
  accepts: [
    {
      extensions: ['.json'],
      mediaTypes: ['application/json'],
      as: 'text',
      maxBytes: MAX_BYTES,
    },
  ],
  http: {
    mount: 'installation-origin',
    reason:
      'A remoteStorage server: apps you approve per category read and write documents in the configured folder, and anyone may read documents under /public/.',
    routes: [
      {
        id: 'webfinger',
        path: '/webfinger',
        methods: ['GET', 'HEAD'],
        principal: 'anonymous',
        auth: 'none',
        cors: 'any-origin-no-credentials',
      },
      {
        id: 'oauth',
        path: '/oauth',
        methods: ['GET'],
        principal: 'anonymous',
        auth: 'none',
      },
      {
        id: 'oauth-callback',
        path: '/oauth/callback',
        methods: ['GET'],
        principal: 'anonymous',
        auth: 'none',
      },
      {
        id: 'storage-read',
        path: '/storage/{*rest}',
        methods: ['GET', 'HEAD'],
        principal: 'installation',
        auth: 'bearer',
        authOptional: true,
        cors: 'any-origin-no-credentials',
      },
      {
        id: 'storage-write',
        path: '/storage/{*rest}',
        methods: ['PUT', 'DELETE'],
        principal: 'installation',
        auth: 'bearer',
        cors: 'any-origin-no-credentials',
        body: 'blob',
        maxBodyBytes: MAX_DOCUMENT_BYTES,
        writes: ['documents'],
      },
    ],
    wellKnown: [
      {
        name: 'webfinger',
        kind: 'shared',
        match: { resourcePrefix: 'acct:' },
        route: 'webfinger',
      },
    ],
    writeTargets: [
      { id: 'documents', parent: 'config:table', classes: [FILE] },
    ],
    tokens: [
      {
        name: 'storage',
        reason:
          'Bearer tokens this plugin hands to remoteStorage apps, each for the categories (read, or read and write) you approved.',
      },
    ],
  },
};

export function utf8(text) {
  // encodeURIComponent rejects unpaired surrogates, preventing silently changed bytes.
  const encoded = encodeURIComponent(text),
    out = [];

  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%') {
      out.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(encoded.charCodeAt(i));
  }

  return out;
}
export function sha256(text) {
  const bytes = utf8(text),
    bits = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--)
    bytes.push(Math.floor(bits / 2 ** (i * 8)) & 255);
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
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = [];
    for (let i = 0; i < 16; i++)
      w[i] =
        (bytes[offset + i * 4] << 24) |
        (bytes[offset + i * 4 + 1] << 16) |
        (bytes[offset + i * 4 + 2] << 8) |
        bytes[offset + i * 4 + 3];

    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (w[i - 16] +
          (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
          w[i - 7] +
          (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) |
        0;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 64; i++) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          w[i]) |
        0;
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      [a, b, c, d, e, f, g, h] = [
        (t1 + t2) | 0,
        a,
        b,
        c,
        (d + t1) | 0,
        e,
        f,
        g,
      ];
    }

    [a, b, c, d, e, f, g, h].forEach((v, i) => {
      H[i] = (H[i] + v) | 0;
    });
  }

  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

function fail(message) {
  throw new Error(message);
}

export function pathParts(path) {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/'))
    fail('Invalid storage path');
  const folder = path.endsWith('/');
  const pieces = path.slice(1, folder ? -1 : undefined).split('/');
  if (pieces.length > 32) fail('Path depth limit exceeded');

  for (const part of pieces) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[%\\?#\x00-\x1f\x7f]/.test(part)
    )
      fail('Invalid storage path segment');
  }

  return { pieces, folder };
}

function validateDocument(doc) {
  const { pieces, folder } = pathParts(doc.path);
  if (folder || pieces.length < (pieces[0] === 'public' ? 3 : 2))
    fail('Document path needs category and filename');
  if (typeof doc.text !== 'string' || utf8(doc.text).length > MAX_BYTES)
    fail('Only bounded UTF-8 text is supported');
  if (
    typeof doc.contentType !== 'string' ||
    !/^(text\/[a-z0-9.+-]+|application\/(json|[a-z0-9.+-]+\+json))(; charset=utf-8)?$/i.test(
      doc.contentType,
    )
  )
    fail('Only UTF-8 text/JSON media types are supported');
  if (/^text\/html(?:;|$)/i.test(doc.contentType))
    fail('HTML documents are not imported');

  return { path: doc.path, text: doc.text, contentType: doc.contentType };
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(k => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );

  return JSON.stringify(value);
}

function baseline(resource) {
  const data = resource[P.baseline];
  if (!data || data.protocol !== 'remoteStorage-text-v1') return null;

  const doc = validateDocument(data);
  if (canonical(data.values) !== canonical(sourceValues(doc)))
    fail('Local document edits or legacy baseline require review');

  return doc;
}

function sourceValues(doc) {
  return { [P.name]: doc.path.split('/').pop(), [P.content]: doc.text };
}

function sameDisplay(resource, doc) {
  return Object.entries(sourceValues(doc)).every(
    ([property, value]) => resource[property] === value,
  );
}

// Match the host's canonical atomic: scheme and legacy did:ad: alias without
// imposing a signature alphabet. The host owns deeper identifier validation.
function subjectId(value) {
  if (
    typeof value !== 'string' ||
    /\s/.test(value) ||
    [...value].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return false;
  if (/^https?:\/\/[^/?#]+/.test(value)) return true;
  const body = value.startsWith('atomic:')
    ? value.slice(7)
    : value.startsWith('did:ad:')
      ? value.slice(7)
      : '';

  return body.split(/[?#]/)[0].length > 0 && !body.startsWith('//');
}

/** Existing host importer contract: proposals only; host previews, authorizes and applies. */
export function run(ctx) {
  try {
    const parent = ctx.config?.table;
    if (!subjectId(parent))
      fail('Configure table with an Atomic parent subject');
    const text = ctx.upload?.text;
    if (typeof text !== 'string' || utf8(text).length > MAX_BYTES)
      fail('Upload a bounded JSON text export');
    const batch = JSON.parse(text);
    if (!Array.isArray(batch.documents) || batch.documents.length > MAX_RECORDS)
      fail('Expected at most 128 documents');
    const documents = batch.documents.map(validateDocument);
    if (new Set(documents.map(d => d.path)).size !== documents.length)
      fail('Duplicate document path');
    // File/folder collisions are rejected even across separate import runs.
    const subjects = ctx.query(P.parent, parent);
    if (!Array.isArray(subjects) || subjects.length > MAX_DOCUMENTS)
      fail('Destination exceeds ' + MAX_DOCUMENTS + ' records');
    const existing = subjects
      .map(subject => ({ subject, resource: ctx.read(subject) }))
      .filter(({ resource }) => resource[P.parent] === parent);
    const existingDocs = existing
      .map(item => ({ ...item, doc: baseline(item.resource) }))
      .filter(item => item.doc);
    // Documents apps stored over remoteStorage are theirs: an import never
    // replaces one.
    const stored = existing
      .map(({ subject, resource }) => recordOf(subject, resource, parent))
      .filter(record => record?.kind === 'blob');
    for (const doc of documents)
      if (stored.some(record => record.path === doc.path))
        fail(doc.path + ' was stored by a remoteStorage app; it is not imported');
    const paths = [
      ...new Set([
        ...existingDocs.map(item => item.doc.path),
        ...stored.map(record => record.path),
        ...documents.map(d => d.path),
      ]),
    ];
    if (paths.length > MAX_DOCUMENTS)
      fail('Destination exceeds ' + MAX_DOCUMENTS + ' documents');
    if (paths.some(a => paths.some(b => a !== b && b.startsWith(a + '/'))))
      fail('Document/folder path collision');
    const intents = [];

    for (const doc of documents) {
      const key = 'remotestorage:' + sha256(doc.path);
      const matches = existing.filter(
        ({ resource }) => resource[P.localId] === key,
      );
      if (matches.length > 1) fail('Duplicate persistent document identity');
      const set = {
        [P.name]: doc.path.split('/').pop(),
        [P.localId]: key,
        [P.content]: doc.text,
        [P.baseline]: {
          protocol: 'remoteStorage-text-v1',
          ...doc,
          values: sourceValues(doc),
          previous: matches.length
            ? { ...matches[0].resource[P.baseline]?.values }
            : {},
        },
      };

      if (!matches.length)
        intents.push({ op: 'create', localId: key, parent, isA: [], set });
      else {
        const { subject, resource } = matches[0],
          previous = baseline(resource);
        if (
          !previous ||
          previous.path !== doc.path ||
          !sameDisplay(resource, previous)
        )
          fail(
            'Local document edits require review before replacing source text',
          );
        if (canonical(previous) !== canonical(doc))
          intents.push({ op: 'set', subject, set });
      }
    }

    return { intents, problems: [] };
  } catch (error) {
    return {
      intents: [],
      problems: [{ severity: 'error', message: error.message }],
    };
  }
}


// -- the storage: Files under `config.table` ---------------------------------

/** The identity of the document at `path`, shared by imports and PUTs. */
export function documentKey(path) {
  return 'remotestorage:' + sha256(path);
}

/** `/notes/a b.txt` → `/notes/a%20b.txt`, for URLs. */
function encodePath(path) {
  return path
    .split('/')
    .map(part => encodeURIComponent(part))
    .join('/');
}

/**
 * The storage path of a request path: `/storage/notes/a` → `/notes/a`,
 * `/storage/` → `/`. Each segment is decoded once; encoded separators,
 * traversal and empty segments are refused.
 */
export function storagePath(requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/storage/'))
    fail('Invalid storage path');
  const raw = requestPath.slice('/storage'.length);
  if (raw === '/') return { path: '/', pieces: [], folder: true };
  const path = raw
    .split('/')
    .map(part => {
      const decoded = decodeURIComponent(part);
      if (decoded.includes('/')) fail('Encoded path separator');

      return decoded;
    })
    .join('/');

  return { path, ...pathParts(path) };
}

/** The download URL of a document, which also records its path. */
function downloadURL(base, path) {
  return base + '/storage' + encodePath(path);
}

/** The path a download URL records, or null. */
function pathOfURL(url) {
  if (typeof url !== 'string') return null;
  // The first `/storage/` segment: a mount prefix may come before it.
  const match = /^https?:\/\/[^/?#]+\/(?:[^?#]*?\/)??storage(\/[^?#]*)$/.exec(
    url,
  );
  if (!match) return null;
  try {
    const path = match[1]
      .split('/')
      .map(part => decodeURIComponent(part))
      .join('/');
    pathParts(path);

    return path;
  } catch {
    return null;
  }
}

function blobHash(value) {
  const match =
    typeof value === 'string' ? /([0-9a-f]{64})$/i.exec(value) : null;

  return match ? match[1].toLowerCase() : null;
}

/**
 * One stored document, from its resource: a File a PUT stored (`kind:
 * 'blob'`), a reviewed text import (`'text'`), or an import whose text was
 * edited in Atomic since (`'stale'`, served as 503). Anything else under
 * the folder is not a remoteStorage document: null.
 */
export function recordOf(subject, resource, table) {
  if (!resource || resource[P.parent] !== table) return null;
  const hash = blobHash(resource[P.blob]);
  const key = resource[P.localId];
  if (hash) {
    const path = pathOfURL(resource[P.downloadURL]);
    if (!path || path.endsWith('/') || key !== documentKey(path)) return null;
    const size = resource[P.filesize];

    return {
      kind: 'blob',
      subject,
      path,
      hash,
      etag: hash,
      type: resource[P.mimetype] || 'application/octet-stream',
      size: typeof size === 'number' ? size : Number(size) || 0,
    };
  }
  const data = resource[P.baseline];
  if (!data || data.protocol !== 'remoteStorage-text-v1') return null;
  let doc;
  try {
    doc = baseline(resource);
  } catch {
    doc = null;
  }
  if (!doc) {
    const path = typeof data.path === 'string' ? data.path : null;

    return path ? { kind: 'stale', subject, path } : null;
  }
  if (!sameDisplay(resource, doc) || key !== documentKey(doc.path))
    return { kind: 'stale', subject, path: doc.path };

  return {
    kind: 'text',
    subject,
    path: doc.path,
    text: doc.text,
    etag: sha256(canonical(doc)),
    type: doc.contentType,
    size: utf8(doc.text).length,
  };
}

function table(ctx) {
  const parent = ctx.config?.table;
  if (!subjectId(parent)) fail('Configure table with an Atomic parent subject');

  return parent;
}

/** Every document in the storage. Throws when the folder is out of bounds. */
export function allRecords(ctx) {
  const parent = table(ctx);
  const subjects = ctx.query(P.parent, parent);
  if (!Array.isArray(subjects) || subjects.length > MAX_DOCUMENTS)
    fail('The storage folder holds more than ' + MAX_DOCUMENTS + ' resources');
  const records = [];

  for (const subject of subjects) {
    const record = recordOf(subject, ctx.read(subject), parent);
    if (record) records.push(record);
  }

  return records;
}

/** The documents at exactly `path` (normally one; the host keeps identities unique). */
function recordsAt(ctx, path) {
  const parent = table(ctx);
  const subjects = ctx.query(P.localId, documentKey(path));
  if (!Array.isArray(subjects)) fail('Storage lookup failed');

  return subjects
    .map(subject => recordOf(subject, ctx.read(subject), parent))
    .filter(record => record && record.path === path)
    .sort((a, b) => (a.subject < b.subject ? -1 : 1));
}

// -- scopes ----------------------------------------------------------------------

/** `notes:rw` → `{ category: 'notes', write: true }`; `*` is every category. */
export function parseScope(scope) {
  const match = /^([a-zA-Z0-9_-]+|\*):(rw|r)$/.exec(scope);

  return match ? { category: match[1], write: match[2] === 'rw' } : null;
}

/** The category a path belongs to, or null for `/` and `/public/`. */
export function categoryOf(pieces) {
  if (pieces[0] === 'public') return pieces[1] ?? null;

  return pieces[0] ?? null;
}

export function mayAccess(scopes, category, write) {
  return (scopes || []).some(scope => {
    const parsed = parseScope(scope);

    return (
      parsed &&
      (parsed.category === '*' || parsed.category === category) &&
      (!write || parsed.write)
    );
  });
}

// -- responses ---------------------------------------------------------------------

function header(request, name) {
  const pairs = Object.entries(request.headers || {}).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (pairs.length > 1 || (pairs.length && typeof pairs[0][1] !== 'string'))
    fail('Ambiguous request header');

  return pairs[0]?.[1];
}

function tagMatches(value, tag, weak) {
  if (value.trim() === '*') return true;
  // Quoted opaque tags may contain commas; parse them without split(',').
  if (!value.trim()) fail('Malformed ETag condition');
  const tags = value.match(/(?:W\/)?"[^"\x00-\x20\x7f]*"/g) || [];
  if (tags.join(',') !== value.replace(/\s*,\s*/g, ',').trim())
    fail('Malformed ETag condition');

  return tags.some(t => (weak ? t.replace(/^W\//, '') === tag : t === tag));
}

function response(status, body = '', headers = {}) {
  return {
    status,
    headers: {
      'cache-control': 'no-cache',
      'content-type': 'text/plain; charset=utf-8',
      ...STORAGE_CORS,
      ...headers,
    },
    body,
  };
}

function unauthorized() {
  return response(401, 'This document needs a bearer token', {
    'www-authenticate': 'Bearer realm="remoteStorage"',
  });
}

function forbidden() {
  return response(403, 'The token does not cover this category', {
    'www-authenticate': 'Bearer realm="remoteStorage", error="insufficient_scope"',
  });
}

/** The folder description of `path` and its ETag, from all records. */
export function folderRepresentation(records, path) {
  const items = Object.create(null),
    folders = new Set();

  for (const record of records.filter(r => r.path.startsWith(path))) {
    const rest = record.path.slice(path.length),
      slash = rest.indexOf('/');
    if (slash < 0) {
      if (record.kind === 'stale') continue;
      items[rest] = {
        ETag: record.etag,
        'Content-Type': record.type,
        'Content-Length': record.size,
      };
    } else folders.add(rest.slice(0, slash + 1));
  }

  for (const key of folders)
    items[key] = {
      ETag: folderRepresentation(records, path + key).tag.slice(1, -1),
    };
  const body = canonical({ '@context': FOLDER_CONTEXT, items });

  return { body, tag: '"' + sha256(body) + '"' };
}

/** Plugin-side conditional GET/HEAD for bodies the plugin itself serves. */
function conditional(request, tag, headers, body) {
  const match = header(request, 'if-match'),
    none = header(request, 'if-none-match');
  if (match !== undefined && !tagMatches(match, tag, false))
    return response(412, '', headers);
  if (none !== undefined && tagMatches(none, tag, true))
    return response(304, '', headers);

  return response(200, request.method === 'HEAD' ? '' : body, headers);
}

function read(ctx, request, target, scopes) {
  const category = categoryOf(target.pieces);
  const isPublic = target.pieces[0] === 'public';
  if (!scopes) {
    // Without a token: public documents only, never a listing.
    if (!isPublic || target.folder) return unauthorized();
  } else if (!(isPublic && !target.folder) && !mayAccess(scopes, category, false))
    return forbidden();

  if (target.folder) {
    const { body, tag } = folderRepresentation(allRecords(ctx), target.path);

    return conditional(
      request,
      tag,
      { 'content-type': 'application/ld+json', etag: tag },
      body,
    );
  }

  const [record] = recordsAt(ctx, target.path);
  if (!record)
    return response(header(request, 'if-match') !== undefined ? 412 : 404);
  if (record.kind === 'stale')
    return response(
      503,
      'This document was edited in Atomic; review its import first',
    );
  if (record.kind === 'text')
    return conditional(
      request,
      '"' + record.etag + '"',
      { 'content-type': record.type, etag: '"' + record.etag + '"' },
      record.text,
    );

  // The host sends the bytes, sets the ETag and answers the conditions.
  return {
    response: {
      headers: {
        'cache-control': 'no-cache',
        'content-type': record.type,
        ...STORAGE_CORS,
      },
      blob: record.hash,
    },
  };
}

function write(ctx, request, target, scopes) {
  if (!scopes) return unauthorized();
  if (target.folder)
    return response(400, 'Folders are made and removed with their documents');
  if (!mayAccess(scopes, categoryOf(target.pieces), true)) return forbidden();

  const records = allRecords(ctx);
  const existing = records.filter(r => r.path === target.path);
  const [current] = existing;
  const conflict =
    records.some(r => r.path.startsWith(target.path + '/')) ||
    records.some(r => target.path.startsWith(r.path + '/'));
  const refuse = (status, text) => ({
    response: { ...response(status, text), current: current?.hash ?? null },
  });

  if (current && current.kind !== 'blob')
    return refuse(
      409,
      'This document was imported into Atomic; change it there, not over remoteStorage',
    );

  if (request.method === 'DELETE') {
    if (!current) return refuse(404, '');

    return {
      response: { ...response(200, ''), current: current.hash },
      intents: existing.map(r => ({ op: 'destroy', subject: r.subject })),
    };
  }

  if (conflict)
    return refuse(409, 'A folder and a document cannot have the same path');
  const blob = request.blob;
  if (!blob || typeof blob.subject !== 'string')
    return refuse(400, 'The request has no body');
  const name = target.pieces[target.pieces.length - 1];
  const set = {
    [P.name]: name,
    [P.filename]: name,
    [P.localId]: documentKey(target.path),
    [P.blob]: blob.subject,
    [P.filesize]: blob.size,
    [P.mimetype]: blob.type,
    [P.downloadURL]: downloadURL(request.base, target.path),
  };

  if (!current) {
    if (records.length >= MAX_DOCUMENTS)
      return refuse(507, 'This storage holds as many documents as it may');

    return {
      response: { ...response(201, ''), current: null },
      intents: [
        {
          op: 'create',
          localId: 'document',
          parent: table(ctx),
          isA: [FILE],
          set,
        },
      ],
    };
  }

  return {
    response: { ...response(200, ''), current: current.hash },
    intents: [
      { op: 'set', subject: current.subject, set },
      // A duplicate identity (which the host's identity check should never
      // let happen) is removed rather than served.
      ...existing.slice(1).map(r => ({ op: 'destroy', subject: r.subject })),
    ],
  };
}

function storage(ctx, request) {
  let target;

  try {
    target = storagePath(request.path);
  } catch {
    return response(400, 'Invalid remoteStorage path');
  }

  const scopes = request.caller?.token?.scopes ?? null;

  try {
    return request.method === 'GET' || request.method === 'HEAD'
      ? read(ctx, request, target, scopes)
      : write(ctx, request, target, scopes);
  } catch (error) {
    if (/ETag condition|request header/.test(error?.message || ''))
      return response(400, 'Invalid conditional request');

    // Host read or query failures say nothing about the data behind them.
    return response(503, 'The storage cannot be read right now');
  }
}

// -- OAuth: the implicit grant, through the host's consent page ------------------

/** `https://App.example:443/cb?x` → `https://app.example`; null if not http(s). */
export function originOf(url) {
  const match =
    typeof url === 'string'
      ? /^(https?):\/\/([^/?#@\s]+)(?:[/?#]|$)/i.exec(url)
      : null;
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  let host = match[2].toLowerCase();
  if (
    (scheme === 'https' && host.endsWith(':443')) ||
    (scheme === 'http' && host.endsWith(':80'))
  )
    host = host.replace(/:\d+$/, '');

  return scheme + '://' + host;
}

function oauthError(status, text) {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: text };
}

/** Parses the remoteStorage `scope` parameter: `notes:rw contacts:r`. */
export function parseScopes(value) {
  if (typeof value !== 'string') return null;
  const scopes = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  if (!scopes.length || scopes.length > 32 || !scopes.every(parseScope))
    return null;

  return scopes;
}

function authorize(ctx, request) {
  const q = request.query || {};
  const redirect = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
  const client = originOf(redirect);
  if (!client || redirect.length > 400)
    return oauthError(400, 'redirect_uri must be an http(s) URL of at most 400 characters');
  if ((q.response_type ?? 'token') !== 'token')
    return oauthError(400, 'Only the implicit grant (response_type=token) is supported');
  const scopes = parseScopes(q.scope);
  if (!scopes)
    return oauthError(400, 'scope must be categories with :r or :rw, such as notes:rw');
  const state = JSON.stringify({
    r: redirect.replace(/#.*$/, ''),
    s: typeof q.state === 'string' ? q.state : '',
  });
  if (state.length > 512)
    return oauthError(400, 'redirect_uri and state together are too long');
  const { url } = ctx.tokens.requestConsent({
    name: 'storage',
    scopes,
    client,
    redirect: '/oauth/callback',
    state,
  });

  return {
    status: 302,
    headers: { location: url, 'cache-control': 'no-store' },
  };
}

function callback(ctx, request) {
  const q = request.query || {};
  let state;

  try {
    state = JSON.parse(q.state);
  } catch {
    state = null;
  }

  if (!state || typeof state.r !== 'string' || !originOf(state.r))
    return oauthError(400, 'This answer does not belong to a request from this server');
  if (q.error)
    // The host only lets a route redirect to a client someone approved, so
    // a denial cannot be handed back to the app.
    return oauthError(403, 'Access was denied. You can close this page.');
  if (typeof q.code !== 'string') return oauthError(400, 'No code');
  const issued = ctx.tokens.issue({ code: q.code });
  if (issued.client !== originOf(state.r)) {
    ctx.tokens.revoke(issued.id);

    return oauthError(400, 'The redirect does not match the approved app');
  }
  const fragment =
    'access_token=' +
    encodeURIComponent(issued.token) +
    '&token_type=bearer' +
    (state.s ? '&state=' + encodeURIComponent(state.s) : '');

  return {
    status: 302,
    headers: { location: state.r + '#' + fragment, 'cache-control': 'no-store' },
  };
}

// -- WebFinger -----------------------------------------------------------------------

function authorityOf(url) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url || '');

  return match ? match[1].toLowerCase() : null;
}

/** The JRD for `acct:<user>@<this host>`, with the storage and OAuth links. */
export function webfinger(ctx, request) {
  const resource = request.query?.resource;
  const match =
    typeof resource === 'string' ? /^acct:([^@\s]+)@([^@\s]+)$/i.exec(resource) : null;
  const host = authorityOf(request.url);
  const user = ctx.config?.user;
  if (
    !match ||
    match[2].toLowerCase() !== host ||
    (typeof user === 'string' && user && match[1] !== user)
  )
    return {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Unknown resource',
    };
  const base = request.base;
  const jrd = {
    subject: resource,
    links: [
      {
        rel: 'http://tools.ietf.org/id/draft-dejong-remotestorage',
        href: base + '/storage',
        type: SPEC_VERSION,
        properties: {
          'http://remotestorage.io/spec/version': SPEC_VERSION,
          'http://tools.ietf.org/html/rfc6749#section-4.2': base + '/oauth',
          'http://tools.ietf.org/html/rfc6750#section-2.3': null,
          'http://tools.ietf.org/html/rfc7233': null,
          'http://remotestorage.io/spec/web-authoring': null,
        },
      },
    ],
  };

  return {
    status: 200,
    headers: {
      'content-type': 'application/jrd+json',
      'cache-control': 'max-age=300',
    },
    body: request.method === 'HEAD' ? '' : JSON.stringify(jrd),
  };
}

/** Every route of the `http` block. */
export function handle(ctx, request) {
  switch (ctx.trigger?.route) {
    case 'webfinger':
      return webfinger(ctx, request);
    case 'oauth':
      try {
        return authorize(ctx, request);
      } catch {
        return oauthError(503, 'The consent page cannot be reached right now');
      }
    case 'oauth-callback':
      try {
        return callback(ctx, request);
      } catch {
        return oauthError(400, 'This answer is unknown, used or expired; start again from the app');
      }
    case 'storage-read':
    case 'storage-write':
      return storage(ctx, request);
    default:
      return oauthError(404, 'Not found');
  }
}
