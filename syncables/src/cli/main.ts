#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DAEMON_HELP } from '../daemon/help.js';
import { deviceLogin, listConnections, probeApi } from './auth.js';
import {
  addConnection,
  configDirectory,
  defineConnection,
  listReplication,
} from './replication.js';

const HELP = `Syncables CLI

  syncables auth-test --client-id ID [--issuer URL] [--scope SCOPES]
    [--connection ID] [--path /repos/owner/repo/issues?per_page=1]
    [--device-endpoint URL --token-endpoint URL]
    [--archive --repeat 2 --max-age 60]
  syncables cache init
  syncables cache runs --owner ID
  syncables cache stats --owner ID
  syncables cache replay --owner ID --run ID
  syncables replication add --name NAME --backend atomic|nextgraph|remotestorage
    --collections NAME[,NAME] [backend options] [--config-dir DIRECTORY]
  syncables replication list [--config-dir DIRECTORY]

Backend options:
  atomic:        --url URL --drive atomic:ID
  nextgraph:     --graph did:ng:ID [--broker URL]
  remotestorage: --address user@host --module MODULE

auth-test performs device login and lists provider connections. With --path it
also tests a read-only provider API request. Tokens remain in memory and are
never printed or saved. Device flow depends on atomic-plugins#565; endpoint
overrides are available until its discovery contract is deployed.

Replication commands save/list non-secret configuration only. Authentication
and runtime replication for all three backends are NOT implemented yet.
The optional archive uses SYNCABLES_DATABASE_URL for local PostgreSQL only.
Remote replication and range-window coverage follow in later stages.
`;

async function main(): Promise<void> {
  const options: Record<string, { type: 'string' | 'boolean' }> =
    Object.fromEntries(
      [
        'issuer',
        'client-id',
        'scope',
        'connection',
        'path',
        'device-endpoint',
        'token-endpoint',
        'name',
        'backend',
        'collections',
        'url',
        'drive',
        'graph',
        'broker',
        'address',
        'module',
        'config-dir',
        'owner',
        'run',
        'repeat',
        'max-age',
        'config',
        'collection',
        'at',
        'filter',
        'order-by',
        'page',
        'page-size',
        'message',
        'subject',
        'subtree',
        'branches',
        'output',
        'source',
        'peer-binary',
        'peer-directory',
        'signer-file',
        'reader',
        'peer-port',
        'braid-port',
        'braid-origin',
        'projection-contract',
        'input',
        'edit-id',
        'created-id',
      ].map((key) => [key, { type: 'string' as const }]),
    );
  options.write = { type: 'boolean' };
  options.owned = { type: 'boolean' };
  options.help = { type: 'boolean' };
  options.archive = { type: 'boolean' };
  options.interactive = { type: 'boolean' };
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options,
  });
  const string = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  if (values.help || !positionals.length) {
    process.stdout.write(HELP + DAEMON_HELP);
    return;
  }
  if (positionals[0] === 'braid') {
    if (positionals.length !== 1) throw new Error('Unexpected Braid arguments');
    const { braidCommand } = await import('../daemon/braid-command.js');
    await braidCommand(values);
    return;
  }
  if (
    [
      'create',
      'edit',
      'delete',
      'edits',
      'send',
      'cancel-edit',
      'adopt-edit',
      'keep-both',
      'login',
      'logout',
      'sync',
      'checkout',
      'migrate',
      'export',
      'daemon',
      'atomic-peer',
      'status',
      'browse',
      'resource',
      'history',
      'tag',
    ].includes(positionals[0])
  ) {
    const { daemonCommand } = await import('../daemon/commands.js');
    await daemonCommand(positionals, values);
    return;
  }
  const directory = string('config-dir') ?? configDirectory();
  if (positionals[0] === 'cache') {
    if (positionals.length !== 2)
      throw new Error('Use cache init, cache runs, or cache replay');
    const { cacheCommand } = await import('./cache.js');
    await cacheCommand(positionals[1], string('owner'), string('run'));
    return;
  }
  if (positionals[0] === 'replication') {
    if (positionals.length !== 2)
      throw new Error('Use replication add or replication list');
    if (positionals[1] === 'add') {
      const connection = defineConnection(values);
      await addConnection(directory, connection);
      process.stdout.write(
        JSON.stringify(
          { ...connection, replicationImplemented: false },
          null,
          2,
        ) + '\n',
      );
    } else if (positionals[1] === 'list') {
      process.stdout.write(
        JSON.stringify(
          {
            connections: await listReplication(directory),
            replicationImplemented: false,
          },
          null,
          2,
        ) + '\n',
      );
    } else throw new Error('Use replication add or replication list');
    return;
  }
  if (positionals[0] !== 'auth-test' || positionals.length !== 1)
    throw new Error('Unknown command; run syncables --help');
  const clientId = string('client-id');
  if (!clientId)
    throw new Error(
      'Supply the public --client-id published by atomic-plugins#565',
    );
  const scope = string('scope');
  const deviceEndpoint = string('device-endpoint');
  const tokenEndpoint = string('token-endpoint');
  if (values.archive && !string('path'))
    throw new Error('--archive requires an explicit --path API read');
  const repeat = Number(string('repeat') ?? '2');
  const maxAge = Number(string('max-age') ?? '60');
  if (
    values.archive &&
    (!Number.isInteger(repeat) ||
      repeat < 1 ||
      repeat > 100 ||
      !Number.isFinite(maxAge) ||
      maxAge < 0)
  )
    throw new Error(
      'Use --repeat 1–100 and a nonnegative --max-age in seconds',
    );
  const session = await deviceLogin(
    {
      issuer: string('issuer') ?? 'https://localthought.io',
      clientId,
      ...(scope ? { scope } : {}),
      ...(deviceEndpoint ? { deviceEndpoint } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
    },
    { report: (message) => process.stderr.write(message + '\n') },
  );
  const available = await listConnections(session);
  process.stdout.write(JSON.stringify(available, null, 2) + '\n');
  const path = string('path');
  if (path) {
    const id = string('connection');
    const connection = id
      ? available.connections.find((item) => item.connection_id === id)
      : available.connections.length === 1
        ? available.connections[0]
        : undefined;
    if (!connection)
      throw new Error('Select an accessible --connection ID for the API probe');
    if (values.archive) {
      const { archivedProbe } = await import('./cache.js');
      await archivedProbe({
        session,
        connection,
        owner: available.owner,
        path,
        repeat,
        maxAgeMs: maxAge * 1000,
      });
      return;
    }
    const result = await probeApi(session, connection, path);
    process.stdout.write(
      JSON.stringify(
        {
          apiAccess: 'verified',
          connection: connection.connection_id,
          ...result,
        },
        null,
        2,
      ) + '\n',
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `syncables: ${error instanceof Error ? error.message : 'command failed'}\n`,
  );
  process.exitCode = 1;
});
