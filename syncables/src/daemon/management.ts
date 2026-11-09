// @wc-ignore-file
import { safeUrl, type Session } from '../cli/auth.js';

export interface ManagementAction {
  action:
    | 'overview'
    | 'disconnect'
    | 'delegate'
    | 'revoke-delegation'
    | 'revoke-session';
  connection?: string;
  agent?: string;
  session?: string;
}
/** Fixed management operations, never an arbitrary URL, method or signing oracle. */
export async function manageAccess(
  session: Session,
  owner: string,
  input: unknown,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid management action');
  const action = input as ManagementAction;
  const scopes = (session.scope ?? '').split(' ');
  const canManageConnections = scopes.includes('connections:manage');
  const canManageSessions = scopes.includes('sessions:manage');
  const issuer = safeUrl(session.issuer);
  if (issuer.pathname !== '/' || issuer.search)
    throw new Error('Management requires an issuer origin');
  const call = async (
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(issuer.origin + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + session.accessToken,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('IAP refused the management request');
    if (response.status === 204) return {};
    const text = await response.text();
    if (text.length > 1024 * 1024)
      throw new Error('Management response too large');
    return JSON.parse(text) as Record<string, unknown>;
  };
  const field = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > 256 ||
      [...value].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
    )
      throw new Error('Invalid management identifier');
    return encodeURIComponent(value);
  };
  if (action.action === 'overview') {
    const connections = await call('/connections');
    if (connections.owner !== owner)
      throw new Error('Management owner mismatch');
    const sessions = canManageSessions
      ? await call('/device/sessions')
      : { sessions: [] };
    return {
      connections: connections.connections,
      sessions: sessions.sessions,
      sessionId: connections.session_id,
      canManageConnections,
      canManageSessions,
    };
  }
  if (action.action === 'revoke-session') {
    if (!canManageSessions) throw new Error('Approve sessions:manage first');
    return call('/device/sessions/' + field(action.session), 'DELETE');
  }
  if (!canManageConnections)
    throw new Error('Approve connections:manage first');
  if (!['disconnect', 'delegate', 'revoke-delegation'].includes(action.action))
    throw new Error('Unknown management action');
  const path = '/connections/' + field(action.connection);
  if (action.action === 'disconnect') return call(path, 'DELETE');
  field(action.agent);
  if (action.action === 'delegate')
    return call(path + '/agents', 'POST', { agent: action.agent });
  return call(path + '/agents/' + field(action.agent), 'DELETE');
}
