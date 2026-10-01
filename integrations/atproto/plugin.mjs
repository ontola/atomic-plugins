/** QuickJS module; the host owns HTTPS, drive-host routing and exclusive claims. */
export const manifest = {
  config: {
    key: 'atproto',
    properties: {
      handle: {
        type: 'string',
        description:
          'Production handle: one of the drive hostnames, the one that answers.',
      },
      did: {
        type: 'string',
        description: 'Public did:plc or hostname-only did:web identity.',
      },
      pds: {
        type: 'string',
        description:
          'did:web only: HTTPS origin of the Personal Data Server that hosts the repository.',
      },
      signingKey: {
        type: 'string',
        description:
          'did:web only: the repository signing public key as a secp256k1 or P-256 Multikey (publicKeyMultibase).',
      },
    },
    required: ['handle', 'did'],
  },
  schemaVersion: 3,
  name: 'atproto',
  namespace: 'atomic-plugins',
  capabilities: [
    {
      name: 'storage',
      reason:
        'Reads the installation configuration; creates no records or blobs.',
    },
  ],
  http: {
    mount: 'drive-host',
    reason:
      'Publish the configured AT Protocol DID, and for did:web its DID document, on the approved drive hostname.',
    routes: [
      {
        id: 'atproto-did',
        path: '/atproto-did',
        methods: ['GET', 'HEAD'],
        principal: 'anonymous',
        auth: 'none',
        cors: 'any-origin-no-credentials',
      },
      {
        id: 'did-json',
        path: '/did.json',
        methods: ['GET', 'HEAD'],
        principal: 'anonymous',
        auth: 'none',
        cors: 'any-origin-no-credentials',
      },
    ],
    wellKnown: [
      { name: 'atproto-did', kind: 'exclusive', route: 'atproto-did' },
      { name: 'did.json', kind: 'exclusive', route: 'did-json' },
    ],
  },
};
const RESERVED = new Set([
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
  'test',
]);

/** Production handle rules: ASCII DNS labels, 253 bytes maximum, no reserved TLD. */
export function normalizeHandle(handleName) {
  if (
    typeof handleName !== 'string' ||
    handleName.length > 253 ||
    !/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
      handleName,
    )
  ) {
    throw new Error('Invalid AT Protocol handle');
  }

  const value = handleName.toLowerCase();
  if (RESERVED.has(value.split('.').pop()))
    throw new Error('Reserved handle suffix');

  return value;
}
/** Only the two AT Protocol supported DID methods, with production syntax. */
export function validateDid(did) {
  if (typeof did !== 'string' || did.length > 2048)
    throw new Error('Invalid DID');
  if (/^did:plc:[a-z2-7]{24}$/.test(did)) return did;

  if (did.startsWith('did:web:')) {
    const domain = did.slice(8);
    if (normalizeHandle(domain) === domain) return did;
  }

  throw new Error('Unsupported or malformed AT Protocol DID');
}

/** A PDS service endpoint: `https://` + production hostname + optional port, nothing else. */
export function validatePds(pds) {
  const match =
    typeof pds === 'string' &&
    pds.length <= 300 &&
    /^https:\/\/([^/:?#@\s]+)(:([1-9][0-9]{0,4}))?\/?$/.exec(pds);
  if (!match || (match[3] && Number(match[3]) > 65535))
    throw new Error('PDS must be an https:// origin');
  const hostname = normalizeHandle(match[1]);

  return `https://${hostname}${match[2] ?? ''}`;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58btc (Bitcoin alphabet) to bytes; undefined for any other character. */
export function base58Decode(text) {
  const bytes = [];

  for (const char of text) {
    let carry = BASE58.indexOf(char);
    if (carry < 0) return undefined;

    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of text) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return bytes.reverse();
}

/**
 * The key types AT Protocol accepts for `#atproto`, as their multicodec
 * varint prefixes: secp256k1-pub (0xe7) and p256-pub (0x1200), each followed
 * by a 33-byte compressed point (prefix 0x02 or 0x03).
 */
const KEY_PREFIXES = {
  secp256k1: [0xe7, 0x01],
  p256: [0x80, 0x24],
};

/**
 * The `publicKeyMultibase` for `#atproto`. Accepts the `did:key:` form the
 * reference PDS returns from getRecommendedDidCredentials as well.
 */
export function signingKey(value) {
  const key =
    typeof value === 'string' && value.startsWith('did:key:')
      ? value.slice(8)
      : value;
  validateSigningKey(key);

  return key;
}

/** A `publicKeyMultibase` for `#atproto`: which curve, or an error. */
export function validateSigningKey(key) {
  if (typeof key !== 'string' || key.length > 64 || key[0] !== 'z')
    throw new Error('Signing key must be a base58btc Multikey');
  const bytes = base58Decode(key.slice(1));
  if (!bytes || bytes.length !== 35)
    throw new Error('Signing key must be a compressed public key');
  for (const [curve, prefix] of Object.entries(KEY_PREFIXES))
    if (
      bytes[0] === prefix[0] &&
      bytes[1] === prefix[1] &&
      (bytes[2] === 0x02 || bytes[2] === 0x03)
    )
      return curve;

  throw new Error('Signing key must be secp256k1 or P-256');
}

export function configuration(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Missing configuration');
  const name = normalizeHandle(config.handle);
  const did = validateDid(config.did);
  // The DID document is published here only for did:web:<handle>; it then
  // needs the PDS and key, which only the PDS can supply. A did:web on
  // another host publishes its document there.
  const web = did === `did:web:${name}`;

  if (!web) return { handle: name, did };
  const key = signingKey(config.signingKey);

  return {
    handle: name,
    did,
    pds: validatePds(config.pds),
    signingKey: key,
    curve: validateSigningKey(key),
  };
}

/**
 * The did:web document (AT Protocol DID spec): the handle as `alsoKnownAs`,
 * the `#atproto` signing key and the `#atproto_pds` service.
 */
export function didDocument(config) {
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      config.curve === 'secp256k1'
        ? 'https://w3id.org/security/suites/secp256k1-2019/v1'
        : 'https://w3id.org/security/suites/ecdsa-2019/v1',
    ],
    id: config.did,
    alsoKnownAs: [`at://${config.handle}`],
    verificationMethod: [
      {
        id: `${config.did}#atproto`,
        type: 'Multikey',
        controller: config.did,
        publicKeyMultibase: config.signingKey,
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: config.pds,
      },
    ],
  };
}

function response(status, body = '', type = 'text/plain') {
  return {
    status,
    headers: { 'content-type': type, 'cache-control': 'no-store' },
    body,
  };
}

const ROUTES = {
  'atproto-did': { wellKnown: 'atproto-did', path: '/atproto-did' },
  'did-json': { wellKnown: 'did.json', path: '/did.json' },
};

export function handle(ctx, request) {
  // Validate the trusted dispatch fields, not untrusted Host/Origin/forwarded headers.
  const route = ROUTES[ctx.trigger?.route];
  if (!route) return response(404);
  const wellKnown = request.wellKnown;
  if (wellKnown !== null && wellKnown !== undefined) {
    if (
      wellKnown !== route.wellKnown ||
      request.path !== `/.well-known/${route.wellKnown}`
    )
      return response(404);
  } else if (request.path !== route.path) return response(404);
  // The manifest restricts methods before execution; this is defense in depth.
  if (!['GET', 'HEAD'].includes(request.method)) return response(405);
  const head = request.method === 'HEAD';
  let config;

  try {
    config = configuration(ctx.config);
  } catch {
    return response(503, head ? '' : 'AT Protocol identity is not configured');
  }

  // `request.host` is the name the host dispatched on (atomic-server
  // `claude/plugin-atproto-host`), never a forwarded header. Where the host
  // supplies it, only the handle's own hostname answers; older hosts leave it
  // out, and every approved hostname of the drive answers (README).
  if (typeof request.host === 'string' && request.host !== config.handle)
    return response(404);

  if (route.wellKnown === 'atproto-did')
    return response(200, head ? '' : config.did);
  // did:plc documents are published by the PLC directory, not here.
  if (!config.pds) return response(404);

  return response(
    200,
    head ? '' : JSON.stringify(didDocument(config)),
    'application/json',
  );
}
export function run(ctx) {
  configuration(ctx.config);

  return { intents: [], problems: [] };
}
