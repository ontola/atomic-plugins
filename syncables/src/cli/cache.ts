import { randomUUID } from 'node:crypto';
import {
  proxyReadTransport,
  proxyRequest,
  type Session,
  type Connection,
} from './auth.js';
import {
  PostgresArchive,
  createCachingTransport,
  createReplayTransport,
} from '../postgres/index.js';

export function localArchive(): PostgresArchive {
  const url = process.env.SYNCABLES_DATABASE_URL;
  if (!url)
    throw new Error(
      'Set SYNCABLES_DATABASE_URL to the separate local PostgreSQL database',
    );
  return new PostgresArchive(url);
}

export async function cacheCommand(
  command: string,
  owner?: string,
  runId?: string,
): Promise<void> {
  if (!['init', 'runs', 'replay', 'stats'].includes(command))
    throw new Error('Use cache init, runs, stats, or replay');
  const archive = localArchive();
  try {
    await archive.initialize();
    if (command === 'init') {
      process.stdout.write(
        'Local PostgreSQL archive initialized (schema v1).\n',
      );
      return;
    }
    if (!owner)
      throw new Error('Supply --owner for local archive inspection/replay');
    if (command === 'stats') {
      process.stdout.write(
        JSON.stringify(await archive.stats(owner), null, 2) + '\n',
      );
      return;
    }
    if (command === 'runs') {
      process.stdout.write(
        JSON.stringify(await archive.runs(owner), null, 2) + '\n',
      );
      return;
    }
    if (command !== 'replay' || !runId)
      throw new Error(
        'Use cache init, cache runs --owner ID, or cache replay --owner ID --run ID',
      );
    const run = await archive.run(owner, runId);
    const replay = await createReplayTransport({ archive, owner, run: runId });
    for (let sequence = 0; sequence < run.next_sequence; sequence++) {
      const stored = await archive.recorded(owner, runId, sequence);
      const response = await replay({
        url: new URL(stored.request.url),
        method: stored.request.method,
        headers: stored.request.headers,
      });
      process.stdout.write(
        JSON.stringify({
          sequence,
          url: stored.request.url,
          recordedOrigin: stored.origin,
          status: response.status,
          bytes: Buffer.byteLength(response.body, 'utf8'),
          replay: true,
        }) + '\n',
      );
    }
  } finally {
    await archive.close();
  }
}

export async function archivedProbe(options: {
  session: Session;
  connection: Connection;
  owner: string;
  path: string;
  repeat: number;
  maxAgeMs: number;
}): Promise<void> {
  const archive = localArchive();
  let run: string | undefined;
  const scope = {
    owner: options.owner,
    connection: options.connection.connection_id,
    authorizationContext: randomUUID(),
  };
  try {
    await archive.initialize();
    run = await archive.createRun(scope, 'CLI read-only API test');
    const transport = createCachingTransport({
      archive,
      scope,
      run,
      mode: 'cache',
      maxAgeMs: options.maxAgeMs,
      upstream: proxyReadTransport(options.session, options.connection),
      onResponse: ({ origin, response }) => {
        process.stdout.write(
          JSON.stringify({
            run,
            owner: scope.owner,
            origin,
            status: response.status,
            bytes: Buffer.byteLength(response.body, 'utf8'),
          }) + '\n',
        );
      },
    });
    const request = proxyRequest(
      options.session,
      options.connection,
      options.path,
    );
    for (let index = 0; index < options.repeat; index++) {
      const response = await transport(request);
      if (response.status < 200 || response.status >= 300)
        throw new Error(`API read refused (HTTP ${response.status})`);
    }
    await archive.finishRun(scope.owner, run);
    process.stdout.write(
      JSON.stringify({
        archiveRun: run,
        owner: scope.owner,
        state: 'complete',
      }) + '\n',
    );
  } catch (error) {
    if (run) await archive.finishRun(scope.owner, run, false).catch(() => {});
    throw error;
  } finally {
    await archive.close();
  }
}
