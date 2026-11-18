import { open } from 'node:fs/promises';
import type { PostgresArchive } from '../postgres/archive.js';
import type { SnapshotStore } from './snapshot-store.js';
import { selectedCollections, type DaemonConfig } from './config.js';
import { prepareCollection, SOURCE_ID, SOURCE_JSON } from './sync.js';
import { withEditLock } from './edits.js';
import { DaemonAuth, KeychainCredentials } from './auth.js';
import { listConnections } from '../cli/auth.js';
import {
  localTransport,
  stageLocalContent,
  stageConnectorContent,
} from './local-transport.js';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { proxyWriteTransport } from './write-transport.js';
import { isRecord } from '../read/model.js';
import {
  interactiveGrantConnection,
  validateInteractiveGrantOptions,
  withInteractiveConnectionGrant,
} from './interactive-grant.js';

export const EDIT_COMMANDS = [
  'copy',
  'create',
  'edit',
  'delete',
  'edits',
  'send',
  'cancel-edit',
  'adopt-edit',
  'keep-both',
];
export async function editCommand(
  config: DaemonConfig,
  archive: PostgresArchive,
  store: SnapshotStore,
  positionals: string[],
  values: Record<string, string | boolean | undefined>,
  signal: AbortSignal,
): Promise<void> {
  const string = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  const required = (key: string): string => {
    const value = string(key);
    if (!value) throw new Error('Supply --' + key);
    return value;
  };
  const command = positionals[0];
  validateInteractiveGrantOptions(command, values);
  const needsId = [
    'edit',
    'delete',
    'cancel-edit',
    'adopt-edit',
    'keep-both',
  ].includes(command);
  if (positionals.length !== (needsId ? 2 : 1))
    throw new Error('Unexpected edit arguments; run syncables --help');
  const source = selectedCollections(config, [required('collection')])[0];
  const stdinConnection = values['connection-grant-stdin']
    ? interactiveGrantConnection([source])
    : undefined;
  const prepared = await prepareCollection(config.owner, source);
  const output = await withEditLock(
    archive.pool,
    config.owner,
    prepared,
    async (edits, lockedSignal) => {
      if (command === 'edits') return edits.list();
      if (command === 'cancel-edit') {
        await edits.cancel(positionals[1]);
        return edits.list();
      }
      if (command === 'keep-both') {
        await edits.keepBoth(positionals[1]);
        return edits.list();
      }
      if (command === 'copy') {
        let sha256: string;
        let modifiedTime: string | undefined;
        if (string('source-collection')) {
          if (string('source'))
            throw new Error('Choose a source file or a source collection');
          const from = selectedCollections(config, [
            required('source-collection'),
          ])[0];
          sha256 = await stageConnectorContent(
            source,
            await prepareCollection(config.owner, from),
            required('source-path'),
            lockedSignal,
          );
        } else {
          const input = required('source');
          const information = await stat(input);
          if (!information.isFile() || information.size > 1024 * 1024 * 1024)
            throw new Error('Copy supports regular files up to 1 GiB');
          sha256 = await stageLocalContent(source, input, lockedSignal);
          modifiedTime = information.mtime.toISOString();
        }
        const operationId = string('edit-id') ?? randomUUID();
        return edits.enqueue({
          action: 'create',
          id: operationId,
          desired: {
            operationId,
            path: required('path'),
            kind: 'file',
            sha256,
            ...(modifiedTime === undefined ? {} : { modifiedTime }),
          },
        });
      }
      if ((command === 'send' || command === 'adopt-edit') && source.local) {
        const transport = localTransport(source, lockedSignal);
        const connection = {
          connection_id: source.connection,
          platform: source.platform,
        };
        if (command === 'adopt-edit') {
          await edits.adopt(
            positionals[1],
            required('created-id'),
            transport,
            undefined,
            connection,
          );
          return edits.list();
        }
        return edits.send(transport, undefined, connection);
      }
      if (command === 'send' || command === 'adopt-edit') {
        if (stdinConnection)
          return withInteractiveConnectionGrant(
            {
              config,
              archive,
              connection: stdinConnection,
              write: true,
              input: process.stdin,
              report: (message) => process.stderr.write(message + '\n'),
            },
            async (_auth, session, connection, grant) =>
              edits.send(
                proxyWriteTransport(
                  session,
                  connection,
                  lockedSignal,
                  globalThis.fetch,
                  grant,
                ),
                session,
                connection,
              ),
          );
        const auth = new DaemonAuth(
          config,
          archive,
          values.interactive ? undefined : new KeychainCredentials(config),
        );
        if (values.interactive)
          await auth.login(
            (message) => process.stderr.write(message + '\n'),
            true,
          );
        const session = await auth.session();
        const available = await listConnections(session);
        if (available.owner !== config.owner)
          throw new Error('Connection owner differs from configured owner');
        const connection = available.connections.find(
          (c) =>
            c.connection_id === source.connection &&
            c.platform === source.platform,
        );
        if (!connection)
          throw new Error(
            'Configured connection not approved for this owner and platform',
          );
        const transport = proxyWriteTransport(
          session,
          connection,
          lockedSignal,
        );
        if (command === 'adopt-edit') {
          await edits.adopt(
            positionals[1],
            required('created-id'),
            transport,
            session,
            connection,
          );
          return edits.list();
        }
        return edits.send(transport, session, connection);
      }
      let desired: Record<string, unknown> | undefined;
      if (command !== 'delete') {
        const file = await open(required('input'), 'r');
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 1024 * 1024)
            throw new Error('Input must be a JSON file of at most 1 MiB');
          const buffer = Buffer.alloc(1024 * 1024 + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 1024 * 1024) throw new Error('Input exceeds 1 MiB');
          const input: unknown = JSON.parse(
            buffer.subarray(0, bytesRead).toString('utf8'),
          );
          if (!isRecord(input)) throw new Error('Input must be a JSON object');
          desired = input;
        } finally {
          await file.close();
        }
      }
      let baseline: Record<string, unknown> | undefined;
      let revision: string | undefined;
      if (command !== 'create') {
        revision = await store.resolveRevision(prepared.scope, required('at'));
        const row = (await store.list(prepared.scope, revision))
          .map((raw) => JSON.parse(raw) as Record<string, unknown>)
          .find((row) => row[SOURCE_ID] === positionals[1]);
        if (!row || !isRecord(row[SOURCE_JSON]))
          throw new Error('Item is absent from the selected accepted snapshot');
        baseline = row[SOURCE_JSON];
      }
      return edits.enqueue({
        action:
          command === 'edit' ? 'replace' : (command as 'create' | 'delete'),
        ...(string('edit-id') ? { id: string('edit-id')! } : {}),
        ...(baseline
          ? { baseline, target: positionals[1], revision: revision! }
          : {}),
        ...(desired ? { desired } : {}),
        owned: values.owned === true,
      });
    },
    signal,
  );
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
