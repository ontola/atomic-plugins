import { addAbortSignal, type Readable } from 'node:stream';
import { isSealedConnectionGrant } from '../cli/auth.js';
import { nodeHash } from '../postgres/json-graph.js';
import { keychainCommand } from './keychain.js';
import { ConnectionGrantAuthError } from './sync-errors.js';

export interface ConnectionGrantBinding {
  issuer: string;
  owner: string;
  clientId: string;
  sessionId: string;
  connectionId: string;
}

export interface ConnectionGrant extends ConnectionGrantBinding {
  version: 1;
  grant: string;
  expiresAt: number;
}

export interface ConnectionGrantStore {
  get(binding: ConnectionGrantBinding): Promise<ConnectionGrant | undefined>;
  set(value: ConnectionGrant): Promise<void>;
}

const MAX_INPUT_BYTES = 8 * 1024;
const MAX_VALIDITY_SECONDS = 30 * 24 * 60 * 60;
const SERVICE = 'syncables-daemon-connection-grant';

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/\s/.test(value) &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
  );
}

export function parseConnectionGrant(value: unknown): ConnectionGrant {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 8)
    throw new Error('Invalid connection grant envelope');
  const {
    version,
    issuer,
    owner,
    clientId,
    sessionId,
    connectionId,
    grant,
    expiresAt,
  } = value as Record<string, unknown>;
  if (
    version !== 1 ||
    !isIdentifier(issuer) ||
    !isIdentifier(owner) ||
    !isIdentifier(clientId) ||
    !isIdentifier(sessionId) ||
    !isIdentifier(connectionId) ||
    !isSealedConnectionGrant(grant) ||
    typeof expiresAt !== 'number' ||
    !Number.isSafeInteger(expiresAt)
  )
    throw new Error('Invalid connection grant envelope');
  return {
    version,
    issuer,
    owner,
    clientId,
    sessionId,
    connectionId,
    grant,
    expiresAt,
  };
}

function parseJson(text: string): ConnectionGrant {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid connection grant JSON');
  }
  return parseConnectionGrant(value);
}

export async function readConnectionGrant(
  input: Readable,
): Promise<ConnectionGrant> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of addAbortSignal(controller.signal, input)) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) break;
      chunks.push(buffer);
    }
  } catch {
    if (controller.signal.aborted)
      throw new Error('Connection grant input timed out');
    throw new Error('Could not read connection grant input');
  } finally {
    clearTimeout(timeout);
  }
  if (bytes > MAX_INPUT_BYTES)
    throw new Error('Connection grant input exceeds 8192 bytes');
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

export function validateGrantExpiry(expiresAt: number): void {
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) throw new ConnectionGrantAuthError('expired');
  if (expiresAt > now + MAX_VALIDITY_SECONDS)
    throw new Error('Connection grant expiry exceeds 30 days');
}

function accountOf(binding: ConnectionGrantBinding): string {
  return nodeHash(
    JSON.stringify([
      binding.issuer,
      binding.owner,
      binding.clientId,
      binding.sessionId,
      binding.connectionId,
    ]),
  );
}

export function checkGrantBinding(
  value: ConnectionGrant,
  binding: ConnectionGrantBinding,
): void {
  if (
    value.issuer !== binding.issuer ||
    value.owner !== binding.owner ||
    value.clientId !== binding.clientId ||
    value.sessionId !== binding.sessionId ||
    value.connectionId !== binding.connectionId
  )
    throw new Error(
      'Connection grant does not match the current configuration, session, or connection',
    );
}

/** MacOS security receives the encoded password through stdin. */
export class KeychainConnectionGrants implements ConnectionGrantStore {
  async get(
    binding: ConnectionGrantBinding,
  ): Promise<ConnectionGrant | undefined> {
    let encoded: string;
    try {
      encoded = await keychainCommand([
        'find-generic-password',
        '-s',
        SERVICE,
        '-a',
        accountOf(binding),
        '-w',
      ]);
    } catch (error) {
      if ((error as { code?: number }).code === 44) return undefined;
      throw new ConnectionGrantAuthError('keychain');
    }
    try {
      const value = parseJson(
        Buffer.from(encoded.trim(), 'base64').toString('utf8'),
      );
      checkGrantBinding(value, binding);
      return value;
    } catch {
      throw new ConnectionGrantAuthError('invalid');
    }
  }

  async set(value: ConnectionGrant): Promise<void> {
    const secret = Buffer.from(JSON.stringify(value)).toString('base64');
    await keychainCommand(
      ['-i'],
      `add-generic-password -U -s ${SERVICE} -a ${accountOf(value)} -w ${secret}\n`,
    );
    // The interactive process status does not report subcommand failures.
    const stored = await this.get(value);
    if (stored?.grant !== value.grant || stored.expiresAt !== value.expiresAt)
      throw new Error('Keychain did not persist the connection grant');
  }
}
