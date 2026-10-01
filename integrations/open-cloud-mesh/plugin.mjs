/* eslint-disable no-control-regex -- Protocol validation must reject control characters. */
/**
 * Open Cloud Mesh receiver, as a QuickJS route handler (OCM 1.5.0).
 *
 * The host verifies every POST's `tag="ocm"` RFC 9421 signature before this
 * code runs, with the key the signing server publishes at the `jwksUri` of
 * its `/.well-known/ocm`, and hands over `request.caller = { keyId, owner,
 * domain, scheme, alg, tag, endPoint }`. This code decides what that server
 * may do: only allowed peers, only for their own accounts, only to
 * configured recipients.
 *
 * No network access of its own: the shared file is fetched by the host
 * (`ctx.blobs.fetch`) straight into the blob store, and notifications are
 * sent by the host's delivery queue, signed with the installation key.
 */
export const P = Object.freeze({
  isA: 'https://atomicdata.dev/properties/isA',
  parent: 'https://atomicdata.dev/properties/parent',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  localId: 'https://atomicdata.dev/properties/localId',
  blob: 'https://atomicdata.dev/properties/blob',
  filename: 'https://atomicdata.dev/properties/filename',
  filesize: 'https://atomicdata.dev/properties/filesize',
  mimetype: 'https://atomicdata.dev/properties/mimetype',
  downloadURL: 'https://atomicdata.dev/properties/downloadURL',
});
export const FILE = 'https://atomicdata.dev/classes/File';
export const API_VERSION = '1.5.0';
export const KEY = 'ocm-key';
export const MAX_BODY = 65536;
const PERMISSIONS = ['read', 'write', 'share'];
const IDENTITY = 'ocm-share-v2';

/** An error that becomes an HTTP answer. */
class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function refuse(status, message) {
  throw new Refusal(status, message);
}

function text(value, field, max = 1024) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    refuse(400, `Invalid ${field}`);

  return value;
}

/**
 * A server domain as OCM addresses and the host's `caller.domain` spell
 * it: a lowercase DNS name or IPv4 address, with an optional port. Nothing
 * else (no scheme, path, credentials or IPv6 literal).
 */
export function domain(value, field = 'domain') {
  text(value, field, 261);
  const match = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match) refuse(400, `Invalid ${field}`);
  const host = match[1].toLowerCase();
  if (
    host.length > 253 ||
    host
      .split('.')
      .some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    refuse(400, `Invalid ${field}`);

  if (match[2] !== undefined) {
    const port = Number(match[2]);
    if (port < 1 || port > 65535) refuse(400, `Invalid ${field}`);

    return `${host}:${port}`;
  }

  return host;
}

/** `user@domain`, split at the last `@` (OCM addresses may contain more). */
export function address(value, field) {
  text(value, field);
  const at = value.lastIndexOf('@');
  if (at < 1) refuse(400, `Invalid ${field}`);

  return {
    user: value.slice(0, at),
    domain: domain(value.slice(at + 1), field),
  };
}

/** The host (and port) of a `scheme://host[:port]/...` URL, lowercased. */
function hostOf(url) {
  const match = /^https?:\/\/([^/?#]+)/i.exec(url ?? '');

  return match ? match[1].toLowerCase() : undefined;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The operator's peer policy: `{ "cloud.example.org": true }`. */
function allowedPeer(policy, peer) {
  if (!isRecord(policy)) return false;
  let allowed = false;

  for (const [raw, decision] of Object.entries(policy)) {
    let canonical;

    try {
      canonical = domain(raw, 'allowed peer');
    } catch {
      continue;
    }

    if (canonical === peer) {
      if (decision !== true) return false;
      allowed = true;
    }
  }

  return allowed;
}

function response(status, body, head = false) {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: head ? '' : JSON.stringify(body),
  };
}

function json(body, what) {
  if (typeof body !== 'string' || body.length > MAX_BODY)
    refuse(400, `${what} must be JSON of at most ${MAX_BODY} characters`);
  let value;

  try {
    value = JSON.parse(body);
  } catch {
    refuse(400, `Invalid ${what} JSON`);
  }

  if (!isRecord(value)) refuse(400, `Invalid ${what}`);

  return value;
}

/**
 * Validates the supported OCM 1.5 Share Creation Notification subset: a
 * `user` share of a `file`, offered over WebDAV with an absolute `uri` and a
 * `sharedSecret`, without requirements this receiver cannot meet. Returns
 * the metadata, and the access details separately (`access`), so callers
 * cannot persist the secret by accident.
 */
export function parseShare(body) {
  const value = json(body, 'share');
  if (value.shareType !== 'user')
    refuse(501, 'Only shares with a single user are supported');
  if (value.resourceType !== 'file')
    refuse(501, 'Only file shares are supported');
  if (value.encryption !== undefined)
    refuse(501, 'Encrypted shares are not supported');
  const protocol = value.protocol;
  if (!isRecord(protocol)) refuse(400, 'Missing protocol');
  const dav =
    protocol.name === 'multi' || protocol.name === 'webdav'
      ? isRecord(protocol.webdav)
        ? protocol.webdav
        : protocol.options
      : undefined;
  if (!isRecord(dav)) refuse(501, 'Only WebDAV access is supported');
  const uri = text(dav.uri, 'WebDAV uri', 2048);
  if (!/^https?:\/\/[^/@?#\\\s]+\/[^\s#]*$/i.test(uri))
    refuse(
      501,
      'Only absolute WebDAV URIs are supported (webdav-receive uri: absolute)',
    );
  const secret = text(dav.sharedSecret, 'sharedSecret', 4096);
  const requirements = dav.requirements ?? [];
  if (!Array.isArray(requirements)) refuse(400, 'Invalid WebDAV requirements');
  if (requirements.length)
    refuse(
      501,
      `Unsupported WebDAV requirements: ${requirements.map(String).join(', ')}`,
    );
  const accessTypes = dav.accessTypes ?? ['remote'];
  if (
    !Array.isArray(accessTypes) ||
    accessTypes.some(t => !['remote', 'datatx'].includes(t))
  )
    refuse(400, 'Invalid WebDAV accessTypes');
  const permissions = dav.permissions ?? ['read'];
  if (
    !Array.isArray(permissions) ||
    !permissions.length ||
    permissions.some(p => !PERMISSIONS.includes(p))
  )
    refuse(400, 'Unsupported WebDAV permissions');
  if (
    value.expiration !== undefined &&
    (!Number.isSafeInteger(value.expiration) || value.expiration < 0)
  )
    refuse(400, 'Invalid expiration');
  const name = text(value.name, 'name', 255);
  if (/[/\\]/.test(name) || name === '.' || name === '..')
    refuse(400, 'Invalid name');

  return {
    share: {
      name,
      providerId: text(value.providerId, 'providerId', 255),
      owner: text(value.owner, 'owner'),
      sender: text(value.sender, 'sender'),
      shareWith: text(value.shareWith, 'shareWith'),
      ...(value.ownerDisplayName === undefined
        ? {}
        : {
            ownerDisplayName: text(
              value.ownerDisplayName,
              'ownerDisplayName',
              255,
            ),
          }),
      ...(value.senderDisplayName === undefined
        ? {}
        : {
            senderDisplayName: text(
              value.senderDisplayName,
              'senderDisplayName',
              255,
            ),
          }),
      permissions: [...new Set(permissions)].sort(),
      ...(value.expiration === undefined
        ? {}
        : { expiration: String(value.expiration) }),
    },
    access: { uri, secret },
  };
}

/** The sender-initiated notifications this receiver acts on. */
export const NOTIFICATIONS = Object.freeze({
  SHARE_UNSHARED: 'unshared',
  SHARE_CHANGE_PERMISSION: 'permissions changed',
});

/**
 * Validates an OCM 1.5 notification about a received file share. The
 * provider ID is `notification.file.providerId`, or the deprecated top-level
 * `providerId`. Other notification parameters are never kept: the
 * specification allows secrets in them.
 */
export function parseNotification(body) {
  const value = json(body, 'notification');
  if (
    typeof value.notificationType !== 'string' ||
    !Object.prototype.hasOwnProperty.call(NOTIFICATIONS, value.notificationType)
  )
    refuse(501, 'Unsupported OCM notification type');
  if (value.resourceType !== 'file')
    refuse(501, 'Only notifications about file shares are supported');
  if (value.shareType !== undefined && value.shareType !== 'user')
    refuse(501, 'Only notifications about user shares are supported');
  const details = value.notification;
  if (details !== undefined && !isRecord(details))
    refuse(400, 'Invalid notification parameters');
  const file = details?.file;
  if (file !== undefined && !isRecord(file))
    refuse(400, 'Invalid notification file');
  const providerId = text(
    file?.providerId ?? value.providerId,
    'providerId',
    255,
  );
  let permissions;

  if (value.notificationType === 'SHARE_CHANGE_PERMISSION') {
    permissions = file?.permissions;
    if (
      !Array.isArray(permissions) ||
      !permissions.length ||
      permissions.some(p => !PERMISSIONS.includes(p))
    )
      refuse(400, 'SHARE_CHANGE_PERMISSION needs valid permissions');
    permissions = [...new Set(permissions)].sort();
  }

  return {
    notificationType: value.notificationType,
    senderDomain: domain(value.senderDomain, 'senderDomain'),
    providerId,
    ...(permissions ? { permissions } : {}),
  };
}

/** This installation's host (and port), from the URL the peer used. */
function ownDomain(request) {
  const host = hostOf(request.base);
  if (!host) refuse(503, 'This server does not know its own address');

  return host;
}

function keyId(request) {
  return `${ownDomain(request)}#${KEY}`;
}

/** What the drive shows for a received share. The secret is never in it. */
export function describe(meta) {
  const escape = value =>
    String(value).replace(/[\\`*_{}[\]()<>#+.!|~-]/g, '\\$&');
  const lines = {
    State: meta.state,
    'Shared by': meta.sender,
    Owner: meta.owner,
    'Sending server': meta.peer,
    'Provider ID': meta.providerId,
    Recipient: meta.shareWith,
    Permissions: meta.permissions.join(', '),
    Expiration: meta.expiration ?? 'none',
  };

  return (
    'Received over Open Cloud Mesh. This is a copy fetched when the share arrived; later changes at the sender are not synchronized.\n\n' +
    Object.entries(lines)
      .map(([key, value]) => `- ${key}: ${escape(value)}`)
      .join('\n')
  );
}

function stateLine(description) {
  return /^- State: (.*)$/m.exec(description ?? '')?.[1];
}

function config(ctx) {
  const c = isRecord(ctx.config) ? ctx.config : {};

  return {
    sharesFolder: typeof c.sharesFolder === 'string' ? c.sharesFolder : '',
    allowedPeers: c.allowedPeers,
    recipients: isRecord(c.recipients) ? c.recipients : {},
    providerName:
      typeof c.providerName === 'string' && c.providerName.length <= 100
        ? c.providerName
        : 'Atomic Server',
  };
}

/** The OCM discovery document for this installation (OCM 1.5 "Fields"). */
export function discovery(ctx, request) {
  const c = config(ctx);
  const base = request.base.replace(/\/$/, '');

  return {
    enabled: !!c.sharesFolder,
    apiVersion: API_VERSION,
    endPoint: `${base}/ocm`,
    provider: c.providerName,
    resourceTypes: [
      {
        name: 'file',
        shareTypes: ['user'],
        protocols: { 'webdav-receive': { uri: 'absolute' } },
      },
    ],
    capabilities: ['http-sig', 'notifications'],
    criteria: ['must-use-http-sig', 'allowlist'],
    jwksUri: `${base}/ocm/jwks`,
  };
}

/** The verified OCM signer, or a 401. */
function signer(request) {
  const caller = request.caller;
  if (
    !isRecord(caller) ||
    caller.tag !== 'ocm' ||
    typeof caller.domain !== 'string'
  )
    refuse(401, 'An OCM HTTP Message Signature (tag="ocm") is required');

  return domain(caller.domain, 'signing server');
}

/**
 * The `localId` of a received share. Plain text, not JSON: the host's intent
 * planner reads a JSON-looking string value as a JSON value (and resolves
 * the strings in an array as subjects), so a JSON array would not survive.
 */
export function identity(peer, providerId) {
  return [IDENTITY, peer, providerId].map(encodeURIComponent).join(' ');
}

function receiveShare(ctx, request) {
  const peer = signer(request);
  const c = config(ctx);
  if (!c.sharesFolder) refuse(503, 'This receiver is not configured');
  const { share, access } = parseShare(request.body);
  const sender = address(share.sender, 'sender');
  const owner = address(share.owner, 'owner');
  // OCM 1.5 "Validating the Payload": the accounts must be the signer's.
  if (sender.domain !== peer || owner.domain !== peer)
    refuse(403, 'sender and owner must be accounts of the signing server');
  if (!allowedPeer(c.allowedPeers, peer))
    refuse(403, 'This server does not accept shares from the signing server');
  const recipient = address(share.shareWith, 'shareWith');
  const displayName = c.recipients[recipient.user];
  if (
    recipient.domain !== ownDomain(request) ||
    typeof displayName !== 'string'
  )
    refuse(400, 'Unknown recipient');
  if (
    share.expiration !== undefined &&
    Number(share.expiration) * 1000 <= Date.now()
  )
    refuse(400, 'The share has already expired');
  if (!/^https:\/\//i.test(access.uri))
    refuse(400, 'The WebDAV URI must use HTTPS');

  const key = identity(peer, share.providerId);
  const existing = ctx.query(P.localId, key);
  if (!Array.isArray(existing)) refuse(503, 'Could not look up earlier shares');
  if (existing.length)
    // A repeated notification: the share is already here.
    return { response: response(201, { recipientDisplayName: displayName }) };

  let fetched;

  try {
    fetched = ctx.blobs.fetch({
      operation: 'fetch-file',
      url: access.uri,
      headers: { authorization: `Bearer ${access.secret}` },
    });
  } catch (error) {
    refuse(
      503,
      `The shared file could not be fetched: ${String(error.message ?? error)}`,
    );
  }

  if (!fetched?.blob)
    refuse(
      400,
      `The shared file could not be fetched: the sending server answered ${fetched?.status}`,
    );

  const meta = {
    ...share,
    peer,
    shareWith: share.shareWith,
    state: 'accepted',
  };
  const intents = [
    {
      op: 'create',
      localId: 'received-share',
      parent: c.sharesFolder,
      isA: [FILE],
      set: {
        [P.name]: share.name,
        [P.filename]: share.name,
        [P.description]: describe(meta),
        [P.localId]: key,
        [P.blob]: fetched.blob.subject,
        [P.filesize]: fetched.blob.size,
        [P.mimetype]: fetched.blob.type,
        // The node's content-addressed download path, as uploads use.
        [P.downloadURL]: `/download/files/${fetched.blob.hash}`,
      },
    },
  ];
  const enqueue = [];
  const problems = [];

  if (typeof request.caller.endPoint === 'string' && request.caller.endPoint) {
    enqueue.push({
      operation: 'notify',
      url: `${request.caller.endPoint.replace(/\/$/, '')}/notifications`,
      headers: { 'content-type': 'application/json' },
      body: {
        notificationType: 'SHARE_ACCEPTED',
        senderDomain: ownDomain(request),
        resourceType: 'file',
        shareType: 'user',
        notification: {
          message: 'The share was accepted.',
          file: { providerId: share.providerId },
        },
      },
      sign: { key: KEY, keyId: keyId(request), format: 'rfc9421', tag: 'ocm' },
      idempotencyKey: `accepted:${peer}:${share.providerId}`,
    });
  } else {
    problems.push({
      severity: 'warning',
      message: 'The sender advertises no endPoint; no SHARE_ACCEPTED was sent',
    });
  }

  return {
    response: response(201, { recipientDisplayName: displayName }),
    intents,
    enqueue,
    problems,
  };
}

function receiveNotification(ctx, request) {
  const peer = signer(request);
  const c = config(ctx);
  if (!c.sharesFolder) refuse(503, 'This receiver is not configured');
  const notification = parseNotification(request.body);
  if (notification.senderDomain !== peer)
    refuse(403, 'senderDomain must be the signing server');
  if (!allowedPeer(c.allowedPeers, peer))
    refuse(
      403,
      'This server does not accept notifications from the signing server',
    );
  const key = identity(peer, notification.providerId);
  const matches = ctx.query(P.localId, key);
  if (!Array.isArray(matches) || !matches.length) refuse(404, 'Unknown share');
  if (matches.length > 1) refuse(409, 'Ambiguous share; review required');
  const existing = ctx.read(matches[0]);
  if (
    !existing ||
    existing[P.parent] !== c.sharesFolder ||
    existing[P.localId] !== key ||
    !Array.isArray(existing[P.isA]) ||
    !existing[P.isA].includes(FILE)
  )
    refuse(409, 'The received share was moved or changed; review required');
  const description = String(existing[P.description] ?? '');
  const state = stateLine(description);
  if (state === undefined)
    refuse(409, 'The received share was edited; review required');
  let next = description;

  if (notification.notificationType === 'SHARE_UNSHARED') {
    if (state === 'unshared') return { response: response(201, {}) };
    next = description.replace(/^- State: .*$/m, '- State: unshared');
  } else {
    const escaped = notification.permissions.join(', ');
    next = description.replace(
      /^- Permissions: .*$/m,
      `- Permissions: ${escaped}`,
    );
    if (next === description) return { response: response(201, {}) };
  }

  return {
    response: response(201, {}),
    intents: [
      { op: 'set', subject: matches[0], set: { [P.description]: next } },
    ],
  };
}

function jwks(ctx, request) {
  const key = ctx.keys.publicKey(KEY);

  return { keys: [{ ...key.jwk, kid: keyId(request) }] };
}

/** `handle(ctx, request)`: every route of the manifest's `http` block. */
export function handle(ctx, request) {
  const method = request.method;
  const head = method === 'HEAD';

  try {
    switch (ctx.trigger?.route) {
      case 'discovery':
        if (method !== 'GET' && !head)
          return response(405, { message: 'Method not allowed' });

        return response(200, discovery(ctx, request), head);
      case 'jwks':
        if (method !== 'GET' && !head)
          return response(405, { message: 'Method not allowed' });

        return response(200, jwks(ctx, request), head);
      case 'shares':
        return receiveShare(ctx, request);
      case 'notifications':
        return receiveNotification(ctx, request);
      default:
        return response(404, { message: 'Not found' });
    }
  } catch (error) {
    if (error instanceof Refusal)
      return response(error.status, { message: error.message }, head);

    // Never echo request data (it may hold the shared secret).
    return response(500, { message: 'The receiver failed' }, head);
  }
}

/** No scheduled work: everything happens in `handle`. */
export function run() {
  return {
    intents: [],
    problems: [
      {
        severity: 'info',
        message:
          'Open Cloud Mesh receives shares through its routes; there is nothing to run.',
      },
    ],
  };
}
