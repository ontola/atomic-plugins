// @wc-ignore-file
import type { OpenApiDocument } from '../openapi/types.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { isRecord, upstreamOf } from './model.js';
import type { Transport, TransportRequest } from './transport.js';

export interface PrincipalIdentifier {
  scope: 'provider' | 'client';
  stable?: boolean;
  reassigned?: boolean;
}

export interface AuthenticatedPrincipalDescription {
  operationId: string;
  path: string;
  method: 'GET';
  kind: 'user' | 'organization' | 'serviceAccount' | 'bot';
  namespace: string;
  subject: string;
  identifier: PrincipalIdentifier;
  claims: Partial<
    Record<'name' | 'email' | 'picture' | 'email_verified', string>
  >;
}

export interface AuthenticatedPrincipal {
  namespace: string;
  /** Preserve JSON type: numeric 7 and string "7" identify different principals. */
  subject: string | number;
  kind: AuthenticatedPrincipalDescription['kind'];
  identifier: PrincipalIdentifier;
  /** Required for a client-scoped identifier; never compare it across clients. */
  clientContext?: string;
  claims: {
    name?: string;
    email?: string;
    picture?: string;
    email_verified?: boolean;
  };
  record: unknown;
}

/** Strict JSON Pointer evaluation for response-body Runtime Expressions. */
export function responseBodyValue(expression: string, body: unknown): unknown {
  const prefix = '$response.body#';
  if (!expression.startsWith(prefix))
    throw new Error('Unsupported response expression');
  const pointer = expression.slice(prefix.length);
  if (pointer === '') return body;
  if (!pointer.startsWith('/') || /~(?:[^01]|$)/.test(pointer)) {
    throw new Error('Invalid response JSON Pointer');
  }
  let value: unknown = body;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (
      (isRecord(value) || Array.isArray(value)) &&
      Object.hasOwn(value, key)
    ) {
      value = (value as Record<string, unknown>)[key];
    } else return undefined;
  }
  return value;
}

const only = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

function expression(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    responseBodyValue(value, {});
    return true;
  } catch {
    return false;
  }
}

/** Discover the fixed, authenticated GET subset of Authenticated Principal 0.1.0. */
export function describeAuthenticatedPrincipals(
  document: OpenApiDocument,
): AuthenticatedPrincipalDescription[] {
  const doc = resolveRefs(document);
  const results: AuthenticatedPrincipalDescription[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    const operation = item.get;
    const raw = operation?.['x-authenticated-principal'];
    if (raw === undefined) continue;
    if (
      !isRecord(raw) ||
      !only(raw, ['kind', 'namespace', 'subject', 'identifier', 'claims'])
    )
      throw new Error(`Invalid authenticated principal at ${path}`);
    const id = raw['identifier'];
    const claims = raw['claims'] ?? {};
    let namespace: URL;
    try {
      namespace = new URL(String(raw['namespace']));
    } catch {
      throw new Error(`Invalid principal namespace at ${path}`);
    }
    if (
      namespace.protocol !== 'https:' ||
      namespace.username ||
      namespace.password ||
      namespace.search ||
      namespace.hash ||
      typeof raw['namespace'] !== 'string' ||
      /[\s\\]/.test(raw['namespace'])
    )
      throw new Error(`Invalid principal namespace at ${path}`);
    if (
      !['user', 'organization', 'serviceAccount', 'bot'].includes(
        String(raw['kind']),
      ) ||
      !expression(raw['subject']) ||
      !isRecord(id) ||
      !only(id, ['scope', 'stable', 'reassigned']) ||
      !['provider', 'client'].includes(String(id['scope'])) ||
      ['stable', 'reassigned'].some(
        (key) => id[key] !== undefined && typeof id[key] !== 'boolean',
      ) ||
      !isRecord(claims) ||
      !only(claims, ['name', 'email', 'picture', 'email_verified']) ||
      !Object.values(claims).every(expression)
    )
      throw new Error(`Invalid authenticated principal at ${path}`);
    const security = operation?.['security'] ?? doc['security'];
    if (
      !operation?.operationId ||
      /[{}?#\\\s]/.test(path) ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      (Array.isArray(item['parameters']) && item['parameters'].length) ||
      (Array.isArray(operation.parameters) && operation.parameters.length) ||
      !Array.isArray(security) ||
      !security.length ||
      security.some((entry) => !isRecord(entry) || !Object.keys(entry).length)
    )
      continue;
    results.push({
      operationId: operation.operationId,
      path,
      method: 'GET',
      kind: raw['kind'] as AuthenticatedPrincipalDescription['kind'],
      namespace: raw['namespace'],
      subject: raw['subject'],
      identifier: structuredClone(id) as unknown as PrincipalIdentifier,
      claims: { ...claims },
    });
  }
  return results;
}

export interface ResolveAuthenticatedPrincipalOptions {
  operationId?: string;
  namespace?: string;
  clientContext?: string;
  transport: Transport;
}

/** Resolve one durable principal through the caller's authenticated transport. */
export async function resolveAuthenticatedPrincipal(
  document: OpenApiDocument,
  options: ResolveAuthenticatedPrincipalOptions,
): Promise<AuthenticatedPrincipal> {
  const matches = describeAuthenticatedPrincipals(document).filter(
    (p) =>
      (!options.operationId || p.operationId === options.operationId) &&
      (!options.namespace || p.namespace === options.namespace),
  );
  const principal = matches[0];
  if (matches.length !== 1 || !principal)
    throw new Error('Unknown or ambiguous authenticated principal');
  if (
    principal.identifier.stable !== true ||
    principal.identifier.reassigned !== false
  )
    throw new Error('Principal has no durable identifier guarantee');
  if (
    options.clientContext !== undefined &&
    (typeof options.clientContext !== 'string' ||
      options.clientContext.length === 0)
  )
    throw new Error('clientContext must be a nonempty string');
  if (principal.identifier.scope === 'client' && !options.clientContext)
    throw new Error('Client-scoped principal requires clientContext');
  const upstream = upstreamOf(document);
  if (
    upstream.protocol !== 'https:' ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  )
    throw new Error('Principal requires a fixed HTTPS server');
  const url = new URL(upstream.href.replace(/\/$/, '') + principal.path);
  if (url.origin !== upstream.origin)
    throw new Error('Principal escaped server origin');
  const request: TransportRequest = {
    url,
    method: 'GET',
    headers: {},
    purpose: 'principal',
  };
  if (!validatePrincipalRead(document, request, principal))
    throw new Error('Principal request escaped declared operation');
  const response = await options.transport(request);
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Authenticated principal returned HTTP ${response.status}`);
  const record: unknown = JSON.parse(response.body);
  const subject = responseBodyValue(principal.subject, record);
  if (
    !(typeof subject === 'string' && subject.length) &&
    !(typeof subject === 'number' && Number.isSafeInteger(subject))
  )
    throw new Error(
      'Principal subject must be a nonempty string or safe integer',
    );
  const claims: AuthenticatedPrincipal['claims'] = {};
  for (const key of ['name', 'email', 'picture', 'email_verified'] as const) {
    const selector = principal.claims[key];
    const value = selector ? responseBodyValue(selector, record) : undefined;
    if (key === 'email_verified') {
      if (typeof value === 'boolean') claims[key] = value;
    } else if (typeof value === 'string') claims[key] = value;
  }
  return {
    namespace: principal.namespace,
    subject: subject as string | number,
    kind: principal.kind,
    identifier: principal.identifier,
    ...(options.clientContext ? { clientContext: options.clientContext } : {}),
    claims,
    record,
  };
}

/** Validate a principal lookup against the document's fixed authenticated operation. */
export function validatePrincipalRead(
  document: OpenApiDocument,
  request: TransportRequest,
  selection: { operationId?: string; namespace?: string } = {},
): boolean {
  try {
    const upstream = upstreamOf(document);
    if (
      upstream.protocol !== 'https:' ||
      upstream.username ||
      upstream.password ||
      upstream.search ||
      upstream.hash ||
      request.method !== 'GET' ||
      request.body !== undefined ||
      request.url.search ||
      request.url.hash ||
      request.url.username ||
      request.url.password
    )
      return false;
    return describeAuthenticatedPrincipals(document).some((p) => {
      if (
        (selection.operationId && selection.operationId !== p.operationId) ||
        (selection.namespace && selection.namespace !== p.namespace)
      )
        return false;
      const path = upstream.pathname.replace(/\/$/, '') + p.path;
      return (
        request.url.origin === upstream.origin && request.url.pathname === path
      );
    });
  } catch {
    return false;
  }
}
