#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { deviceLogin, listConnections, probeApi } from './auth.js';
import {
  addConnection,
  configDirectory,
  defineConnection,
  listReplication,
} from './replication.js';

const HELP = `Syncables CLI scaffold

  syncables auth-test --client-id ID [--issuer URL] [--scope SCOPES]
    [--connection ID] [--path /repos/owner/repo/issues?per_page=1]
    [--device-endpoint URL --token-endpoint URL]
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
PostgreSQL, caching, outbox and daemon/service commands follow after this test.
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
      ].map((key) => [key, { type: 'string' as const }]),
    );
  options.help = { type: 'boolean' };
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options,
  });
  const string = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  if (values.help || !positionals.length) {
    process.stdout.write(HELP);
    return;
  }
  const directory = string('config-dir') ?? configDirectory();
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
