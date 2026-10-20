import type { Transport, TransportResponse } from '../read/transport.js';
import { PostgresArchive, type ResponseHead } from './archive.js';
import {
  cleanHeaders,
  requestIdentity,
  type ArchiveScope,
} from './identity.js';

function reusable(stored: ResponseHead, maxAgeMs: number): boolean {
  if (maxAgeMs === 0) return false;
  const control = stored.response.headers['cache-control'] ?? '';
  if (
    /\b(no-store|no-cache)\b/i.test(control) ||
    (stored.response.headers.vary ?? '')
      .split(',')
      .some((value) =>
        ['*', 'authorization', 'cookie'].includes(value.trim().toLowerCase()),
      )
  )
    return false;
  const serverAge = /\bmax-age="?(\d+)/i.exec(control);
  const limit = serverAge
    ? Math.min(maxAgeMs, Number(serverAge[1]) * 1000)
    : maxAgeMs;
  const age = Number(stored.response.headers.age ?? '0');
  if (!Number.isFinite(age) || age < 0) return false;
  return (
    stored.response.status === 200 &&
    Math.max(0, Date.now() - stored.observedAt.getTime()) + age * 1000 <= limit
  );
}

export function createCachingTransport(options: {
  archive: PostgresArchive;
  scope: ArchiveScope;
  run: string;
  upstream: Transport;
  mode?: 'live' | 'cache';
  maxAgeMs?: number;
  leaseMs?: number;
  waitMs?: number;
  onResponse?: (result: {
    origin: 'upstream' | 'cache';
    response: TransportResponse;
  }) => void;
}): Transport {
  const leaseMs = options.leaseMs ?? 30_000;
  const waitMs = options.waitMs ?? 35_000;
  const maxAge = options.maxAgeMs ?? 0;
  if (
    ![leaseMs, waitMs].every((value) => Number.isFinite(value) && value > 0) ||
    !Number.isFinite(maxAge) ||
    maxAge < 0
  )
    throw new Error('Invalid cache freshness or lease limits');
  return async (request) => {
    const identity = requestIdentity(request);
    const attempt = await options.archive.begin(
      options.scope,
      options.run,
      request,
    );
    const conditional =
      request.purpose === 'precondition' ||
      request.purpose === 'inbox' ||
      ['if-none-match', 'if-modified-since'].some(
        (key) => key in identity.request.headers,
      );
    const initial = await options.archive.head(
      options.scope,
      identity.cacheKey,
    );
    const hit = async (head: ResponseHead): Promise<TransportResponse> => {
      const stored = await options.archive.responseById(options.scope, head.id);
      await options.archive.cacheHit(attempt, stored);
      options.onResponse?.({ origin: 'cache', response: stored.response });
      return { ...stored.response, fromCache: true };
    };
    const freshSince = async (): Promise<ResponseHead | undefined> => {
      if (conditional) return undefined;
      const latest = await options.archive.head(
        options.scope,
        identity.cacheKey,
      );
      return latest && latest.id !== initial?.id && reusable(latest, leaseMs)
        ? latest
        : undefined;
    };
    if (
      !conditional &&
      options.mode === 'cache' &&
      initial &&
      reusable(initial, maxAge)
    )
      return hit(initial);
    const started = Date.now();
    let token: string | undefined;
    while (
      !(token = await options.archive.claim(
        options.scope,
        identity.key,
        leaseMs,
      ))
    ) {
      if (Date.now() - started >= waitMs) {
        await options.archive.failure(attempt, false);
        throw new Error('Timed out waiting for a cache refresh lease');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const latest = await freshSince();
      if (latest) return hit(latest);
    }
    try {
      // A completed refresh may have released its lease between our lookup and claim.
      const latest = await freshSince();
      if (latest) return await hit(latest);
      let response: TransportResponse;
      try {
        response = await options.upstream(request);
      } catch {
        await options.archive.failure(attempt);
        throw new Error('Recorded upstream read failed');
      }
      // Persist before returning; a persistence failure leaves a pending attempt, never an applied observation.
      const archived = { ...response, headers: cleanHeaders(response.headers) };
      await options.archive.response(attempt, archived, token);
      options.onResponse?.({ origin: 'upstream', response: archived });
      return archived;
    } finally {
      await options.archive
        .release(options.scope, identity.key, token)
        .catch(() => {});
    }
  };
}

export async function createReplayTransport(options: {
  archive: PostgresArchive;
  owner: string;
  run: string;
}): Promise<Transport> {
  const run = await options.archive.run(options.owner, options.run);
  if (run.state !== 'complete')
    throw new Error('Replay requires a completed recorded run');
  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return (request) => {
    const result = queue.then(async () => {
      const key = requestIdentity(request).key;
      const stored = await options.archive.recorded(
        options.owner,
        options.run,
        sequence,
      );
      if (stored.key !== key)
        throw new Error(
          'Replay request does not match the next recorded request',
        );
      sequence += 1;
      if (!stored.response) throw new Error('Recorded upstream read failed');
      return stored.response;
    });
    queue = result.catch(() => {});
    return result;
  };
}
