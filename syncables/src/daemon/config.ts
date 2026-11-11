import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { nodeHash } from '../postgres/json-graph.js';
import { safeUrl } from '../cli/auth.js';
import type { ReadLimits } from '../read/pages.js';

export type FileInventorySource =
  | { provider: 'dropbox' | 'google-drive'; tokenFile: string }
  | { provider: 'icloud-drive'; directory: string };

export interface CollectionConfig {
  platform: string;
  account: string;
  name: string;
  connection: string;
  document: string;
  collection: string;
  bindings: Record<string, string>;
  query: Record<string, string>;
  pollSeconds: number;
  readLimits?: Partial<
    Pick<ReadLimits, 'maxRecords' | 'maxRequests' | 'timeoutMs'>
  >;
  fileInventory?: FileInventorySource;
  notifications?: {
    source: string;
    parameters: Record<string, string>;
    events: string[];
  };
  /** Explicit provider writes; replacement also permits permanent retirement. */
  writes?: { enabled: true; allowReplacement?: boolean };
}
export interface DaemonConfig {
  version: 1;
  owner: string;
  issuer: string;
  clientId: string;
  dataDirectory: string;
  checkoutDirectory?: string;
  /** PostgreSQL snapshot folders; separate from preserved legacy Git worktrees. */
  workspaceDirectory?: string;
  collections: CollectionConfig[];
  webhookPort?: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid daemon configuration object');
  return value as Record<string, unknown>;
}
function label(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)
  )
    throw new Error('Invalid config ' + name);
  return value;
}
function text(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 8192 ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error('Invalid config ' + name);
  return value;
}
function strings(value: unknown): Record<string, string> {
  const result = object(value ?? {});
  for (const child of Object.values(result))
    if (typeof child !== 'string')
      throw new Error('Bindings and query values must be strings');
  return result as Record<string, string>;
}
function readLimits(
  value: unknown,
): NonNullable<CollectionConfig['readLimits']> {
  const limits: NonNullable<CollectionConfig['readLimits']> = {};
  for (const [key, limit] of Object.entries(object(value))) {
    if (
      (key !== 'maxRecords' && key !== 'maxRequests' && key !== 'timeoutMs') ||
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 2_147_483_647
    )
      throw new Error('Invalid collection readLimits');
    limits[key] = limit;
  }
  return limits;
}
function fileInventory(value: unknown, base: string): FileInventorySource {
  const settings = object(value);
  switch (settings.provider) {
    case 'dropbox':
    case 'google-drive':
      return {
        provider: settings.provider,
        tokenFile: resolve(base, text(settings.tokenFile, 'tokenFile')),
      };
    case 'icloud-drive':
      return {
        provider: settings.provider,
        directory: resolve(base, text(settings.directory, 'directory')),
      };
    default:
      throw new Error('Invalid fileInventory provider');
  }
}
export async function loadDaemonConfig(file: string): Promise<DaemonConfig> {
  const data = object(JSON.parse(await readFile(file, 'utf8')));
  if (
    data.version !== 1 ||
    !Array.isArray(data.collections) ||
    data.collections.length > 100
  )
    throw new Error('Use daemon config version 1 with at most 100 collections');
  const base = dirname(resolve(file));
  const seen = new Set<string>();
  const collections = data.collections.map((item: unknown) => {
    const c = object(item);
    const files =
      c.fileInventory === undefined
        ? undefined
        : fileInventory(c.fileInventory, base);
    if (
      files &&
      [
        'platform',
        'connection',
        'document',
        'collection',
        'bindings',
        'query',
        'notifications',
        'writes',
      ].some((key) => Object.hasOwn(c, key))
    )
      throw new Error(
        'fileInventory defines a read-only collection with its own provider and source',
      );
    const account = label(c.account, 'account');
    const name = label(c.name, 'collection name');
    const collection: CollectionConfig = {
      platform: files?.provider ?? label(c.platform, 'platform'),
      account,
      name,
      connection: files
        ? 'file-inventory:' + files.provider + ':' + account + ':' + name
        : text(c.connection, 'connection'),
      document: files
        ? 'builtin:file-inventory'
        : resolve(base, text(c.document, 'document')),
      collection: files ? 'files' : text(c.collection, 'metadata collection'),
      bindings:
        files?.provider === 'icloud-drive'
          ? { root: files.directory }
          : strings(c.bindings),
      query: strings(c.query),
      pollSeconds: Number(c.pollSeconds ?? 300),
      ...(files ? { fileInventory: files } : {}),
      ...(c.readLimits === undefined
        ? {}
        : { readLimits: readLimits(c.readLimits) }),
    };
    if (
      !Number.isSafeInteger(collection.pollSeconds) ||
      (collection.pollSeconds !== 0 && collection.pollSeconds < 5) ||
      collection.pollSeconds > 86400
    )
      throw new Error('pollSeconds must be 0 (webhooks only), or 5 to 86400');
    if (c.notifications !== undefined) {
      const notice = object(c.notifications);
      const source = label(notice.source, 'notification source');
      if (
        !Array.isArray(notice.events) ||
        !notice.events.length ||
        notice.events.length > 32
      )
        throw new Error('Notifications require 1–32 event names');
      collection.notifications = {
        source,
        parameters: strings(notice.parameters),
        events: notice.events.map((value) =>
          label(value, 'notification event'),
        ),
      };
    }
    if (c.writes !== undefined) {
      const writes = object(c.writes);
      if (
        writes.enabled !== true ||
        (writes.allowReplacement !== undefined &&
          typeof writes.allowReplacement !== 'boolean')
      )
        throw new Error(
          'writes requires enabled: true and an optional allowReplacement boolean',
        );
      collection.writes = {
        enabled: true,
        ...(writes.allowReplacement === undefined
          ? {}
          : { allowReplacement: writes.allowReplacement as boolean }),
      };
    }
    const key = alias(collection);
    if (seen.has(key)) throw new Error('Duplicate configured collection alias');
    seen.add(key);
    return collection;
  });
  const issuer = safeUrl(
    text(data.issuer ?? 'https://localthought.io', 'issuer'),
  );
  if (issuer.pathname !== '/' || issuer.search)
    throw new Error('Issuer must be an origin');
  const port = data.webhookPort;
  if (
    port !== undefined &&
    (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535)
  )
    throw new Error('Invalid webhook port');
  return {
    version: 1,
    owner: text(data.owner, 'owner'),
    issuer: issuer.origin,
    clientId: label(data.clientId ?? 'syncables-cli', 'client id'),
    dataDirectory: resolve(
      base,
      text(data.dataDirectory ?? './syncables-data.git', 'data directory'),
    ),
    ...(data.checkoutDirectory === undefined
      ? {}
      : {
          checkoutDirectory: resolve(
            base,
            text(data.checkoutDirectory, 'checkout directory'),
          ),
        }),
    workspaceDirectory: resolve(
      base,
      text(data.workspaceDirectory ?? './workspace', 'workspace directory'),
    ),
    collections,
    ...(port === undefined ? {} : { webhookPort: Number(port) }),
  };
}
export function alias(c: CollectionConfig): string {
  return [c.platform, c.account, c.name].join('/');
}
export function selectedCollections(
  config: DaemonConfig,
  selectors: string[] = [],
): CollectionConfig[] {
  if (!selectors.length) return config.collections;
  const wanted = new Set(selectors);
  for (const name of wanted)
    if (!config.collections.some((c) => alias(c) === name))
      throw new Error('Unknown collection selector: ' + name);
  return config.collections.filter((c) => wanted.has(alias(c)));
}
export function collectionScope(
  owner: string,
  c: CollectionConfig,
  documentHash: string,
): string {
  const sorted = (value: Record<string, string>): [string, string][] =>
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    owner,
    c.connection,
    c.platform,
    c.collection,
    sorted(c.bindings),
    sorted(c.query),
    documentHash,
  ]);
}
export function itemSubject(
  owner: string,
  c: CollectionConfig,
  resource: string,
  id: string,
): string {
  const identity = JSON.stringify([
    owner,
    c.connection,
    resource,
    Object.entries(c.bindings).sort(),
  ]);
  return (
    'urn:syncables:item:' + nodeHash(identity) + ':' + encodeURIComponent(id)
  );
}
