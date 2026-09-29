import {
  encodeEntry,
  decodeEntry,
  validatePath,
  u64,
  hex,
  unhex,
  utf8,
} from './codec.mjs';
import { william3 } from '../willow-drop/william3.ts';
import { base64, encodeDrop, willowTime } from './drop.mjs';

export const P = Object.freeze({
  parent: 'https://atomicdata.dev/properties/parent',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  localId: 'https://atomicdata.dev/properties/localId',
  baseline: 'https://atomicdata.dev/properties/importBaseline',
  lastCommit: 'https://atomicdata.dev/properties/lastCommit',
  createdAt: 'https://atomicdata.dev/properties/createdAt',
});
/** The host-held Ed25519 key whose public half is this installation's subspace. */
export const WILLOW_KEY = 'willow';
const MAX_SUBJECTS = 32,
  MAX_PAYLOAD_BYTES = 65536;

export const manifest = {
  schemaVersion: 3,
  name: 'willow',
  namespace: 'atomic-plugins',
  version: '0.3.0',
  description:
    'Publish explicitly selected public Atomic properties as a Willow drop of host-signed, Meadowcap-authorised entries.',
  operations: [],
  secrets: [],
  http: {
    mount: 'drive-prefix',
    routes: [
      {
        id: 'drop',
        path: '/willow.drop',
        methods: ['GET'],
        principal: 'anonymous',
        auth: 'none',
      },
    ],
    keys: [
      {
        name: WILLOW_KEY,
        alg: 'ed25519',
        willow: { namespace: 'config:namespace', pathPrefix: 'config:pathPrefix' },
        reason:
          "This installation's Willow subspace key. The host signs Willow entries with it, only in the configured communal namespace and under the configured path prefix.",
      },
    ],
    reason:
      'Serves the selected resources, as far as anyone may read them, as a Willow drop that other Willow peers can import.',
  },
  capabilities: [
    {
      name: 'storage',
      reason:
        'Read approved Atomic resources and propose reviewed unsigned export records.',
    },
  ],
  configSchema: {
    type: 'object',
    properties: {
      subjects: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit Atomic resource subjects to export',
      },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Explicit property subjects included in each JSON-AD payload',
      },
      outputParent: {
        type: 'string',
        description:
          'Unsigned candidate job only: Atomic parent for reviewed unsigned export candidates',
      },
      namespace: {
        type: 'string',
        description:
          'Willow namespace id, 64 hex characters. The drop route needs a communal one (last byte even).',
      },
      subspace: {
        type: 'string',
        description:
          "Unsigned candidate job only: Willow subspace id, 64 hex characters. The drop route uses the installation's own key.",
      },
      pathPrefix: {
        type: 'array',
        items: { type: 'string' },
        description: 'Willow binary path components as hexadecimal strings',
      },
      timestamp: {
        type: 'string',
        description:
          'Unsigned candidate job only: explicit logical Willow U64 timestamp as decimal text; increase after source changes',
      },
    },
    required: ['subjects', 'properties', 'namespace', 'pathPrefix'],
  },
};

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

function decimal(value) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 20
  )
    throw Error('Timestamp must be canonical U64 decimal text');

  return u64(BigInt(value));
}

/** Deterministic JSON serialization is an application payload choice, not Willow framing. */
export function canonicalJson(value, depth = 0) {
  if (depth > 32) throw Error('Payload nesting limit exceeded');
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length > 1024) throw Error('Payload array limit exceeded');

    return (
      '[' + value.map(item => canonicalJson(item, depth + 1)).join(',') + ']'
    );
  }

  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    const keys = Object.keys(value).sort();
    if (keys.length > 128) throw Error('Payload object limit exceeded');

    return (
      '{' +
      keys
        .map(
          key =>
            JSON.stringify(key) + ':' + canonicalJson(value[key], depth + 1),
        )
        .join(',') +
      '}'
    );
  }

  throw Error('Payload contains a non-JSON value');
}

function config(raw) {
  if (!raw || !subjectId(raw.outputParent))
    throw Error('Configure an Atomic output parent');

  for (const field of ['subjects', 'properties']) {
    if (
      !Array.isArray(raw[field]) ||
      !raw[field].length ||
      raw[field].length > MAX_SUBJECTS ||
      !raw[field].every(subjectId) ||
      new Set(raw[field]).size !== raw[field].length
    )
      throw Error('Configure bounded unique ' + field);
  }

  if (raw.subjects.includes(raw.outputParent))
    throw Error('Output parent cannot be a source');
  if (
    !/^[a-fA-F0-9]{64}$/.test(raw.namespace) ||
    !/^[a-fA-F0-9]{64}$/.test(raw.subspace)
  )
    throw Error('Willow identifiers must be 32-byte public keys');
  if (!Array.isArray(raw.pathPrefix))
    throw Error('Configure binary path prefix');
  const prefix = validatePath(raw.pathPrefix.map(unhex));

  return {
    ...raw,
    prefix,
    namespaceBytes: unhex(raw.namespace),
    subspaceBytes: unhex(raw.subspace),
    time: decimal(raw.timestamp),
  };
}

/** Reads only an explicitly configured Atomic subject and selected properties.
 * Returns an unsigned Entry and payload, not a Meadowcap AuthorisedEntry.
 */
export function exportCandidate(ctx, raw, subject) {
  const c = config(raw);
  if (!c.subjects.includes(subject))
    throw Error('Subject is not approved for export');
  const resource = ctx.read(subject),
    selected = Object.create(null);
  selected['@id'] = subject;

  for (const property of c.properties) {
    if (Object.prototype.hasOwnProperty.call(resource, property))
      selected[property] = resource[property];
  }

  const payload = utf8(canonicalJson(selected));
  if (payload.length > MAX_PAYLOAD_BYTES) throw Error('Payload exceeds 64 KiB');
  const entry = {
    namespace: c.namespaceBytes,
    subspace: c.subspaceBytes,
    path: validatePath([...c.prefix, utf8(subject)]),
    timestamp: c.time,
    payloadLength: BigInt(payload.length),
    payloadDigest: william3(payload),
  };

  return { entry, entryBytes: encodeEntry(entry), payload };
}
/** Structural and payload-integrity validation only. No signature/capability check. */
export function checkCandidate(entryBytes, payload) {
  const entry = decodeEntry(entryBytes, { canonical: true });
  if (
    !(payload instanceof Uint8Array) ||
    payload.length > MAX_PAYLOAD_BYTES ||
    BigInt(payload.length) !== entry.payloadLength
  )
    throw Error('Payload length mismatch or limit exceeded');
  if (hex(william3(payload)) !== hex(entry.payloadDigest))
    throw Error('WILLIAM3 payload digest mismatch');

  return entry;
}
/** Existing Atomic sandbox job: proposes persisted candidate resources for review.
 * No remote peer receives these proposals and no signing key is ever handled.
 */
export function run(ctx) {
  try {
    const c = config(ctx.config),
      intents = [];

    for (const subject of c.subjects) {
      const { entry, entryBytes, payload } = exportCandidate(ctx, c, subject);
      const key =
        'willow-candidate:' +
        hex(
          william3(
            utf8(
              canonicalJson({
                namespace: hex(entry.namespace),
                subspace: hex(entry.subspace),
                path: entry.path.map(hex),
              }),
            ),
          ),
        );
      const matches = ctx
        .query(P.localId, key)
        .filter(id => ctx.read(id)[P.parent] === c.outputParent);
      if (matches.length > 1)
        throw Error('Duplicate export candidate identity');
      const envelope = {
        format: 'atomic-willow-signing-candidate-v1',
        status: 'unsigned',
        source: subject,
        mediaType: 'application/ad+json',
        entryHex: hex(entryBytes),
        payloadHex: hex(payload),
      };
      const serialized = canonicalJson(envelope);
      const set = {
        [P.name]: 'Unsigned Willow export: ' + subject,
        [P.description]: serialized,
        [P.localId]: key,
        [P.baseline]: {
          ...envelope,
          values: {
            [P.name]: 'Unsigned Willow export: ' + subject,
            [P.description]: serialized,
          },
          previous: {},
        },
      };

      if (!matches.length)
        intents.push({
          op: 'create',
          localId: key,
          parent: c.outputParent,
          isA: [],
          set,
        });
      else {
        const existing = ctx.read(matches[0]),
          previous = existing[P.baseline];
        if (
          !previous ||
          previous.format !== envelope.format ||
          !previous.values ||
          existing[P.description] !== previous.values[P.description] ||
          existing[P.name] !== previous.values[P.name] ||
          previous.values[P.description] !==
            canonicalJson({
              format: previous.format,
              status: previous.status,
              source: previous.source,
              mediaType: previous.mediaType,
              entryHex: previous.entryHex,
              payloadHex: previous.payloadHex,
            })
        )
          throw Error('Local candidate edits require manual reconciliation');
        const oldEntry = checkCandidate(
          unhex(previous.entryHex),
          unhex(previous.payloadHex),
        );
        if (
          previous.source !== subject ||
          hex(oldEntry.namespace) !== hex(entry.namespace) ||
          hex(oldEntry.subspace) !== hex(entry.subspace) ||
          canonicalJson(oldEntry.path.map(hex)) !==
            canonicalJson(entry.path.map(hex))
        )
          throw Error('Existing candidate identity does not match source');
        if (
          previous.entryHex === envelope.entryHex &&
          previous.payloadHex === envelope.payloadHex
        )
          continue;
        if (entry.timestamp <= oldEntry.timestamp)
          throw Error(
            'Increase logical timestamp before replacing an export candidate',
          );
        set[P.baseline].previous = previous.values;
        intents.push({ op: 'set', subject: matches[0], set });
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

function routeConfig(raw) {
  if (!raw) throw Error('The plugin is not configured');

  for (const field of ['subjects', 'properties']) {
    if (
      !Array.isArray(raw[field]) ||
      !raw[field].length ||
      raw[field].length > MAX_SUBJECTS ||
      !raw[field].every(subjectId) ||
      new Set(raw[field]).size !== raw[field].length
    )
      throw Error('Configure bounded unique ' + field);
  }

  if (!/^[a-fA-F0-9]{64}$/.test(raw.namespace))
    throw Error('The Willow namespace must be 64 hex characters');
  if (!Array.isArray(raw.pathPrefix))
    throw Error('Configure binary path prefix');

  return { ...raw, prefix: validatePath(raw.pathPrefix.map(unhex)) };
}

/** The JSON-AD payload of the selected properties, as exportCandidate makes it. */
function payloadOf(subject, resource, properties) {
  const selected = Object.create(null);
  selected['@id'] = subject;

  for (const property of properties) {
    if (Object.prototype.hasOwnProperty.call(resource, property))
      selected[property] = resource[property];
  }

  const payload = utf8(canonicalJson(selected));
  if (payload.length > MAX_PAYLOAD_BYTES) throw Error('Payload exceeds 64 KiB');

  return payload;
}

/**
 * One source as a host-authorised Willow entry. The timestamp is the
 * source's last commit time, read as the data model recommends, so an
 * unchanged source yields the same entry (and the host the same signature),
 * and an edit a newer one. The host refuses to sign unless the source is
 * still at the commit read here and readable by this route's principal.
 */
export function authorisedEntry(ctx, c, subspace, subject) {
  const resource = ctx.read(subject);
  const commit = resource[P.lastCommit];
  if (typeof commit !== 'string' || !commit)
    throw Error('A selected resource has no last commit');
  const createdAt = ctx.read(commit)[P.createdAt];
  if (!Number.isSafeInteger(createdAt) || createdAt < 0)
    throw Error("A selected resource's last commit has no creation time");
  const payload = payloadOf(subject, resource, c.properties);
  const entry = {
    namespace: unhex(c.namespace),
    subspace,
    path: validatePath([...c.prefix, utf8(subject)]),
    timestamp: willowTime(BigInt(createdAt)),
    payloadLength: BigInt(payload.length),
    payloadDigest: william3(payload),
  };
  const entryHex = hex(encodeEntry(entry));
  const signed = ctx.willow.authorise({
    key: WILLOW_KEY,
    entry: entryHex,
    source: { subject, commit },
  });
  if (signed.entry !== entryHex)
    throw Error('The host signed other bytes than the ones asked for');

  return { entry, signature: unhex(signed.signature), payload };
}

/**
 * `GET /willow.drop`: every selected resource the public may read, as one
 * Willow drop (raw bytes). Anonymous, so it exports nothing a visitor could
 * not read anyway. All or nothing: a resource that cannot be read or signed
 * fails the request, and the reason goes to the run log, not the response.
 */
export function handle(ctx) {
  try {
    const c = routeConfig(ctx.config);
    const { subspace } = ctx.willow.subspace(WILLOW_KEY);
    const items = c.subjects.map(subject =>
      authorisedEntry(ctx, c, unhex(subspace), subject),
    );

    return {
      response: {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-cache',
        },
        bodyBase64: base64(encodeDrop(items)),
      },
      problems: [],
    };
  } catch (error) {
    return {
      response: {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'This Willow drop cannot be built right now; the installation run log says why.',
      },
      problems: [{ severity: 'error', message: error.message }],
    };
  }
}
