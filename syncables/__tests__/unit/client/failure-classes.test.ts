// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  defaultWriteFailureClass,
  prepareDocument,
  type AuthBlock,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
  type WriteFailure,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// #260: failure classification for writes. Deterministic fake transports,
// invented data.

const response = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): TransportResponse => ({
  status,
  headers,
  body: value === undefined ? '' : JSON.stringify(value),
});

const document = (): OpenApiDocument =>
  prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
  });

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function idle(client: { pendingWrites(): unknown[] }): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

type Pet = Record<string, unknown>;
type Answer =
  | TransportResponse
  | Promise<TransportResponse | undefined>
  | undefined;

/**
 * A fake provider. `behave` may answer a write itself (`undefined` applies
 * it); every write request is recorded, with the time it was sent.
 */
function provider(
  initial: Pet[],
  behave?: (request: TransportRequest, n: number) => Answer,
): {
  pets: Map<string, Pet>;
  writes: TransportRequest[];
  times: number[];
  transport: (request: TransportRequest) => Promise<TransportResponse>;
} {
  const pets = new Map(initial.map((p) => [String(p['id']), p]));
  const writes: TransportRequest[] = [];
  const times: number[] = [];
  let next = 1;
  const apply = (r: TransportRequest): TransportResponse => {
    const id = decodeURIComponent(r.url.pathname.split('/')[3] ?? '');
    if (r.method === 'POST') {
      const pet = { ...JSON.parse(r.body ?? '{}'), id: `srv-${next++}` };
      pets.set(pet.id, pet);
      return response(pet, 201);
    }
    if (!pets.has(id)) return response({ error: 'not found' }, 404);
    if (r.method === 'DELETE') {
      pets.delete(id);
      return response(undefined, 204);
    }
    const pet = { ...JSON.parse(r.body ?? '{}'), id };
    pets.set(id, pet);
    return response(pet);
  };
  const transport = async (r: TransportRequest): Promise<TransportResponse> => {
    if (r.method === 'GET') return response([...pets.values()]);
    writes.push(r);
    times.push(Date.now());
    return (await behave?.(r, writes.length)) ?? apply(r);
  };
  return { pets, writes, times, transport };
}

const rex = { id: '1', name: 'Rex', tag: 'dog' };
const milo = { id: '2', name: 'Milo', tag: 'cat' };

describe('defaultWriteFailureClass', () => {
  const failure = (
    status: number,
    type: WriteFailure['type'] = 'update',
    extra: Partial<WriteFailure> = {},
  ): WriteFailure => ({
    type,
    method: type === 'create' ? 'POST' : type === 'delete' ? 'DELETE' : 'PUT',
    status,
    headers: {},
    body: '',
    resource: '/pets',
    id: '1',
    afterRenewal: false,
    ...extra,
  });

  it('classifies statuses as documented', () => {
    const classes = (statuses: number[]): [number, string][] =>
      statuses.map((status) => [
        status,
        defaultWriteFailureClass(failure(status)),
      ]);
    const permanent = [400, 404, 405, 409, 410, 413, 415, 422, 418, 451];
    expect(classes(permanent)).toEqual(
      permanent.map((status) => [status, 'permanent']),
    );
    const retry = [408, 425, 429, 500, 502, 503, 504, 302];
    expect(classes(retry)).toEqual(retry.map((status) => [status, 'retry']));
    expect(defaultWriteFailureClass(failure(401))).toBe('auth');
    expect(defaultWriteFailureClass(failure(403))).toBe('auth');
    expect(defaultWriteFailureClass(failure(404, 'delete'))).toBe('satisfied');
    expect(defaultWriteFailureClass(failure(410, 'delete'))).toBe('satisfied');
    expect(defaultWriteFailureClass(failure(404, 'create'))).toBe('permanent');
  });

  it('treats a rate-limited 403 as retryable, and a 403 after a renewal as permanent', () => {
    expect(
      defaultWriteFailureClass(
        failure(403, 'update', { headers: { 'x-ratelimit-remaining': '0' } }),
      ),
    ).toBe('retry');
    expect(
      defaultWriteFailureClass(
        failure(403, 'update', { headers: { 'retry-after': '60' } }),
      ),
    ).toBe('retry');
    expect(
      defaultWriteFailureClass(failure(403, 'update', { afterRenewal: true })),
    ).toBe('permanent');
    expect(
      defaultWriteFailureClass(failure(401, 'update', { afterRenewal: true })),
    ).toBe('auth');
  });
});

describe('permanent client errors', () => {
  it.each([400, 404, 405, 409, 410, 413, 415, 422])(
    'fails an update answered %i at once, without retrying',
    async (status) => {
      const { writes, transport } = provider([rex], () =>
        response({ error: 'invented refusal' }, status),
      );
      const client = createApiClient(document(), {
        transport,
        retry: { baseDelayMs: 1 },
      });
      await client.sync();
      await client.update('/pets', '1', { name: 'Rex II' });
      await vi.waitFor(() =>
        expect(client.pendingWrites()[0]?.state).toBe('failed'),
      );
      await settle();
      expect(writes).toHaveLength(1);
      expect(client.pendingWrites()).toEqual([
        {
          resource: '/pets',
          id: '1',
          type: 'update',
          attempts: 1,
          lastError: `Request to /api/pets/1 failed with status ${status}: {"error":"invented refusal"}`,
          lastStatus: status,
          state: 'failed',
        },
      ]);
      // Still visible locally and resolvable.
      expect(await client.get('/pets', '1')).toMatchObject({ name: 'Rex II' });
    },
  );

  it('can be retried with resolveWrite once the cause is fixed', async () => {
    let refuse = true;
    const { pets, writes, transport } = provider([rex], () =>
      refuse ? response({ error: 'name too long' }, 422) : undefined,
    );
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    refuse = false;
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(client);
    expect(writes).toHaveLength(2);
    expect(pets.get('1')).toMatchObject({ name: 'Rex II' });
  });

  it('parks a refused create and holds back the writes queued behind it', async () => {
    const { writes, transport } = provider([], (r) =>
      r.method === 'POST' ? response({ error: 'duplicate' }, 409) : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    const created = await client.create('/pets', { name: 'Milo' });
    await client.update('/pets', String(created['id']), { tag: 'cat' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    await settle();
    expect(writes).toHaveLength(1);
    expect(client.pendingWrites().map((w) => [w.type, w.state])).toEqual([
      ['create', 'failed'],
      ['update', 'pending'],
    ]);
    expect(client.pendingWrites()[0]).toMatchObject({
      attempts: 1,
      lastStatus: 409,
    });
  });

  it('keeps a long error body to an excerpt of 200 characters', async () => {
    const body = `  ${'x'.repeat(150)}\n\n${'y'.repeat(150)}  `;
    const { transport } = provider([rex], () => ({
      status: 400,
      headers: {},
      body,
    }));
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    const lastError = client.pendingWrites()[0]?.lastError ?? '';
    const expected = `${'x'.repeat(150)} ${'y'.repeat(49)}…`;
    expect(lastError).toBe(
      `Request to /api/pets/1 failed with status 400: ${expected}`,
    );
  });

  it('lets later writes of the record go ahead after a refused update', async () => {
    const { pets, writes, transport } = provider([rex], (_r, n) =>
      n === 1 ? response({}, 422) : undefined,
    );
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'bad' });
    await client.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    await settle();
    expect(pets.get('1')).toMatchObject({ name: 'Rex', tag: 'wolf' });
    expect(client.pendingWrites()).toMatchObject([
      { type: 'update', state: 'failed', lastStatus: 422 },
    ]);
  });
});

describe('deletes of records that are already gone', () => {
  it.each([404, 410])('settles a delete answered %i, once', async (status) => {
    const { writes, transport } = provider([rex, milo], (r) =>
      r.method === 'DELETE' ? response({}, status) : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.remove('/pets', '1');
    await idle(client);
    await settle();
    expect(writes).toHaveLength(1);
    expect(await client.get('/pets', '1')).toBeUndefined();
  });

  it('settles the delete of a record another client deleted, and the next sync agrees', async () => {
    const { pets, writes, transport } = provider([rex, milo]);
    const client = createApiClient(document(), { transport });
    await client.sync();
    pets.delete('1');
    await client.remove('/pets', '1');
    await idle(client);
    expect(writes).toHaveLength(1);
    await client.sync();
    expect((await client.list('/pets')).map((p) => p['id'])).toEqual(['2']);
  });
});

describe('retryable failures', () => {
  it.each([408, 425, 429, 503])(
    'retries an update answered %i',
    async (status) => {
      const { pets, writes, transport } = provider([rex], (_r, n) =>
        n === 1 ? response({}, status) : undefined,
      );
      const client = createApiClient(document(), {
        transport,
        retry: { baseDelayMs: 1 },
      });
      await client.sync();
      await client.update('/pets', '1', { name: 'Rex II' });
      await idle(client);
      expect(writes).toHaveLength(2);
      expect(pets.get('1')).toMatchObject({ name: 'Rex II' });
    },
  );

  it('waits the Retry-After seconds instead of the backoff delay', async () => {
    const { times, transport } = provider([rex], (_r, n) =>
      n === 1 ? response({}, 429, { 'Retry-After': '1' }) : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]), {
      timeout: 3000,
    });
    expect(times).toHaveLength(2);
    expect((times[1] as number) - (times[0] as number)).toBeGreaterThanOrEqual(
      950,
    );
  });

  it('never retries sooner than the backoff, whatever Retry-After says', async () => {
    // "0", a date in the past, or a server clock behind the client's.
    for (const retryAfter of [
      '0',
      new Date(Date.now() - 60_000).toUTCString(),
    ]) {
      const { writes, transport } = provider([rex], () =>
        response({}, 429, { 'retry-after': retryAfter }),
      );
      const client = createApiClient(document(), {
        transport,
        retry: { baseDelayMs: 100 },
      });
      await client.sync();
      await client.update('/pets', '1', { name: 'Rex II' });
      await settle(500);
      // Sent at about 0, 100, 300 ms; the next one waits until about 700 ms.
      expect(writes.length).toBeGreaterThanOrEqual(2);
      expect(writes.length).toBeLessThanOrEqual(4);
      await client
        .resolveWrite('/pets', '1', { action: 'discard' })
        .catch(() => undefined);
    }
  });

  it('caps a long Retry-After at retry.maxRetryAfterMs', async () => {
    const { times, transport } = provider([rex], (_r, n) =>
      n === 1 ? response({}, 503, { 'retry-after': '3600' }) : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1, maxRetryAfterMs: 100 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(times).toHaveLength(2);
    const waited = (times[1] as number) - (times[0] as number);
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThan(1000);
  });

  it('ignores a Retry-After that is neither delay-seconds nor an HTTP date', async () => {
    const { times, transport } = provider([rex], (_r, n) =>
      n === 1 ? response({}, 429, { 'retry-after': '1.5' }) : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(times).toHaveLength(2);
    expect((times[1] as number) - (times[0] as number)).toBeLessThan(500);
  });

  it('counts retryable failures against retry.maxAttempts', async () => {
    const { writes, transport } = provider([rex], () => response({}, 503));
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1, maxAttempts: 3 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    expect(writes).toHaveLength(3);
    expect(client.pendingWrites()[0]).toMatchObject({
      attempts: 3,
      lastStatus: 503,
    });
  });

  it('retries a rate-limited 403 instead of blocking', async () => {
    const { writes, transport } = provider([rex], (_r, n) =>
      n === 1 ? response({}, 403, { 'X-RateLimit-Remaining': '0' }) : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(writes).toHaveLength(2);
    expect(client.authBlocked()).toBeUndefined();
  });

  it('still makes a create answered 500 uncertain', async () => {
    const { writes, transport } = provider([], () => response({}, 500));
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    expect(writes).toHaveLength(1);
    expect(client.pendingWrites()[0]?.lastStatus).toBe(500);
  });
});

describe('auth failures block the client until authRenewed()', () => {
  it('blocks every write on a 401, without counting attempts, and resumes in order', async () => {
    let token = 'old';
    const blocks: AuthBlock[] = [];
    const { pets, writes, transport } = provider([rex, milo], (r) =>
      r.headers['authorization'] === 'Bearer new'
        ? undefined
        : response({ message: 'Bad credentials' }, 401),
    );
    const client = createApiClient(document(), {
      transport,
      authenticate: (r) => ({
        ...r,
        headers: { ...r.headers, authorization: `Bearer ${token}` },
      }),
      onAuthBlocked: (block) => blocks.push(block),
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(client.authBlocked()).toBeDefined());
    // Writes queued while blocked are not sent, for any record.
    await client.update('/pets', '1', { tag: 'wolf' });
    await client.update('/pets', '2', { name: 'Milo II' });
    await client.create('/pets', { name: 'Fido' });
    await settle();
    expect(writes).toHaveLength(1);
    expect(blocks).toEqual([
      {
        status: 401,
        lastError:
          'Request to /api/pets/1 failed with status 401: {"message":"Bad credentials"}',
        resource: '/pets',
        id: '1',
      },
    ]);
    expect(client.authBlocked()).toEqual(blocks[0]);
    expect(
      client.pendingWrites().map(({ id, type, state, attempts }) => ({
        id,
        type,
        state,
        attempts,
      })),
    ).toEqual([
      { id: '1', type: 'update', state: 'blocked', attempts: 0 },
      { id: '1', type: 'update', state: 'pending', attempts: 0 },
      { id: '2', type: 'update', state: 'pending', attempts: 0 },
      expect.objectContaining({ type: 'create', state: 'pending' }),
    ]);
    expect(client.pendingWrites()[0]).toMatchObject({ lastStatus: 401 });
    await expect(
      client.resolveWrite('/pets', '1', { action: 'retry' }),
    ).rejects.toThrow(/authRenewed/);
    // Local edits stay visible.
    expect(await client.get('/pets', '1')).toMatchObject({
      name: 'Rex II',
      tag: 'wolf',
    });

    token = 'new';
    await client.authRenewed();
    expect(client.authBlocked()).toBeUndefined();
    await idle(client);
    expect(
      writes.slice(1).filter((r) => r.url.pathname === '/api/pets/1'),
    ).toHaveLength(2);
    const record1 = writes
      .filter((r) => r.url.pathname === '/api/pets/1')
      .map((r) => JSON.parse(r.body ?? '{}'));
    expect(record1.slice(1)).toEqual([
      { ...rex, name: 'Rex II' },
      { ...rex, name: 'Rex II', tag: 'wolf' },
    ]);
    expect(pets.get('2')).toMatchObject({ name: 'Milo II' });
    expect([...pets.values()].some((p) => p['name'] === 'Fido')).toBe(true);
    expect(blocks).toHaveLength(1);
  });

  it('does nothing on authRenewed() when not blocked', async () => {
    const { writes, transport } = provider([rex]);
    const client = createApiClient(document(), { transport });
    await client.authRenewed();
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(writes).toHaveLength(1);
  });

  it('blocks on a 403, and fails a 403 that renewed credentials did not fix', async () => {
    const { writes, transport } = provider([rex, milo], (r) =>
      r.url.pathname === '/api/pets/1' ? response({}, 403) : undefined,
    );
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(client.authBlocked()).toMatchObject({ status: 403 }),
    );
    await client.authRenewed();
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    expect(client.authBlocked()).toBeUndefined();
    expect(client.pendingWrites()[0]).toMatchObject({
      attempts: 1,
      lastStatus: 403,
    });
    // A write that succeeds shows the credentials work: the next 403 blocks.
    await client.update('/pets', '2', { name: 'Milo II' });
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    await settle();
    await client.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() =>
      expect(client.authBlocked()).toMatchObject({ status: 403, id: '1' }),
    );
  });

  it.each([401, 403])(
    'retries a %i for a request sent before the renewal, without blocking or failing it',
    async (status) => {
      let releaseSecond!: (r: TransportResponse) => void;
      const second = new Promise<TransportResponse>((resolve) => {
        releaseSecond = resolve;
      });
      // Rex's resend after the renewal waits, so no write has succeeded
      // with the renewed credentials when Milo's stale answer arrives.
      let releaseRex!: () => void;
      const rexGate = new Promise<void>((resolve) => {
        releaseRex = resolve;
      });
      const blocks: AuthBlock[] = [];
      let renewed = false;
      const { pets, writes, transport } = provider(
        [rex, milo],
        async (r, n) => {
          if (renewed && n > 2) {
            if (r.url.pathname === '/api/pets/1') await rexGate;
            return undefined;
          }
          if (r.url.pathname === '/api/pets/2') return second;
          return response({}, 401);
        },
      );
      const client = createApiClient(document(), {
        transport,
        onAuthBlocked: (b) => blocks.push(b),
      });
      await client.sync();
      // Milo's request is in flight while Rex's is refused.
      await client.update('/pets', '2', { name: 'Milo II' });
      await client.update('/pets', '1', { name: 'Rex II' });
      await vi.waitFor(() => expect(client.authBlocked()).toBeDefined());
      renewed = true;
      await client.authRenewed();
      releaseSecond(response({}, status));
      await vi.waitFor(() =>
        expect(
          writes.filter((r) => r.url.pathname === '/api/pets/2'),
        ).toHaveLength(2),
      );
      releaseRex();
      await idle(client);
      expect(blocks).toHaveLength(1);
      expect(client.authBlocked()).toBeUndefined();
      expect(
        writes.filter((r) => r.url.pathname === '/api/pets/2'),
      ).toHaveLength(2);
      expect(pets.get('2')).toMatchObject({ name: 'Milo II' });
      expect(pets.get('1')).toMatchObject({ name: 'Rex II' });
    },
  );

  it('blocks on a create, keeping the follow-up writes behind it', async () => {
    let refuse = true;
    const { pets, writes, transport } = provider([], () =>
      refuse ? response({}, 401) : undefined,
    );
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'Milo' });
    await client.update('/pets', String(created['id']), { tag: 'cat' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('blocked'),
    );
    refuse = false;
    await client.authRenewed();
    await idle(client);
    expect(writes.map((r) => r.method)).toEqual(['POST', 'POST', 'PUT']);
    expect([...pets.values()]).toEqual([
      { name: 'Milo', tag: 'cat', id: 'srv-1' },
    ]);
  });
});

describe('auth failures: review of #313', () => {
  it('judges a 403 by whether it was sent after the renewal, not by what settled meanwhile', async () => {
    let releaseRex!: (r: TransportResponse) => void;
    const rexAnswer = new Promise<TransportResponse>((resolve) => {
      releaseRex = resolve;
    });
    let renewed = false;
    const { pets, writes, transport } = provider([rex, milo], (r) => {
      if (!renewed) return response({}, 401);
      // After the renewal Rex's resend waits; Milo's update succeeds first.
      return r.url.pathname === '/api/pets/1' ? rexAnswer : undefined;
    });
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(client.authBlocked()).toBeDefined());
    await client.update('/pets', '2', { name: 'Milo II' });
    renewed = true;
    await client.authRenewed();
    await vi.waitFor(() =>
      expect(pets.get('2')).toMatchObject({ name: 'Milo II' }),
    );
    await settle();
    releaseRex(response({}, 403));
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { id: '1', state: 'failed', lastStatus: 403 },
      ]),
    );
    expect(client.authBlocked()).toBeUndefined();
    expect(writes).toHaveLength(3);
  });

  it('takes any answer but a refusal after a renewal as accepted credentials', async () => {
    let renewed = false;
    const { transport } = provider([rex, milo], (r) => {
      if (!renewed) return response({}, 401);
      return r.url.pathname === '/api/pets/1'
        ? response({}, 422)
        : response({}, 403);
    });
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(client.authBlocked()).toBeDefined());
    renewed = true;
    await client.authRenewed();
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]).toMatchObject({
        state: 'failed',
        lastStatus: 422,
      }),
    );
    // The 422 showed the renewed credentials work: a 403 blocks again.
    await client.update('/pets', '2', { name: 'Milo II' });
    await vi.waitFor(() =>
      expect(client.authBlocked()).toMatchObject({ status: 403, id: '2' }),
    );
  });

  it('fails every write the renewed credentials may not make, without blocking again', async () => {
    let renewed = false;
    const { writes, transport } = provider([rex, milo], (r) => {
      if (!renewed) return response({}, 401);
      return r.url.pathname === '/api/pets/1' ? response({}, 403) : undefined;
    });
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(client.authBlocked()).toBeDefined());
    await client.update('/pets', '1', { tag: 'wolf' });
    renewed = true;
    await client.authRenewed();
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { id: '1', state: 'failed', lastStatus: 403 },
        { id: '1', state: 'failed', lastStatus: 403 },
      ]),
    );
    await settle();
    expect(client.authBlocked()).toBeUndefined();
    expect(writes).toHaveLength(3);
  });

  it('lets a custom classifier with its own renewal rule fail every write instead of re-blocking', async () => {
    const seen: boolean[] = [];
    const { writes, transport } = provider([rex, milo], () =>
      response({ error: 'insufficient_scope' }, 400),
    );
    const client = createApiClient(document(), {
      transport,
      classifyWriteFailure: (f) => {
        seen.push(f.afterRenewal);
        return f.status === 400 && f.body.includes('insufficient_scope')
          ? f.afterRenewal
            ? 'permanent'
            : 'auth'
          : defaultWriteFailureClass(f);
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(client.authBlocked()).toMatchObject({ status: 400 }),
    );
    await client.update('/pets', '1', { tag: 'wolf' });
    await client.update('/pets', '2', { name: 'Milo II' });
    await client.authRenewed();
    await vi.waitFor(() =>
      expect(
        client
          .pendingWrites()
          .map(({ id, state, lastStatus }) => [id, state, lastStatus]),
      ).toEqual([
        ['1', 'failed', 400],
        ['1', 'failed', 400],
        ['2', 'failed', 400],
      ]),
    );
    await settle();
    expect(client.authBlocked()).toBeUndefined();
    expect(writes).toHaveLength(4);
    // Asked once before the renewal; twice for each failure after it.
    expect(seen).toEqual([false, true, false, true, false, true, false]);
  });

  it('does not count a custom 403 made permanent by the renewal as accepted credentials', async () => {
    let renewed = false;
    const { writes, transport } = provider([rex, milo], () =>
      renewed ? response({}, 403) : response({}, 401),
    );
    const client = createApiClient(document(), {
      transport,
      // Rex's 403 is a per-record permission once credentials are renewed;
      // everything else follows the defaults.
      classifyWriteFailure: (f) =>
        f.status === 403 && f.id === '1' && f.afterRenewal
          ? 'permanent'
          : defaultWriteFailureClass(f),
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(client.authBlocked()).toBeDefined());
    renewed = true;
    await client.authRenewed();
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { id: '1', state: 'failed', lastStatus: 403 },
      ]),
    );
    // Rex's refusal did not show the credentials accepted: Milo's 403 fails
    // by the default renewal rule instead of blocking the client again.
    await client.update('/pets', '2', { name: 'Milo II' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { id: '1', state: 'failed' },
        { id: '2', state: 'failed', lastStatus: 403 },
      ]),
    );
    expect(client.authBlocked()).toBeUndefined();
    expect(writes).toHaveLength(3);
  });

  it('makes a create that a classifier calls auth on a 5xx uncertain, not blocked', async () => {
    const { writes, transport } = provider([], () => response({}, 502));
    const client = createApiClient(document(), {
      transport,
      classifyWriteFailure: (f) =>
        f.status === 502 ? 'auth' : defaultWriteFailureClass(f),
    });
    await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]).toMatchObject({
        state: 'uncertain',
        attempts: 1,
        lastStatus: 502,
      }),
    );
    await settle();
    expect(client.authBlocked()).toBeUndefined();
    expect(writes).toHaveLength(1);
  });

  it('discards a blocked write with resolveWrite, keeping the block; retry still throws', async () => {
    const { writes, transport } = provider([rex, milo], () =>
      response({}, 401),
    );
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(client.authBlocked()).toBeDefined());
    await client.update('/pets', '1', { tag: 'wolf' });
    await expect(
      client.resolveWrite('/pets', '1', { action: 'retry' }),
    ).rejects.toThrow(/authRenewed/);
    await client.resolveWrite('/pets', '1', { action: 'discard' });
    expect(client.authBlocked()).toBeDefined();
    expect(client.pendingWrites()).toMatchObject([
      { id: '1', type: 'update', state: 'pending' },
    ]);
    expect(await client.get('/pets', '1')).toEqual({ ...rex, tag: 'wolf' });
    await settle();
    expect(writes).toHaveLength(1);
  });

  it('discards a blocked create with the writes queued behind it', async () => {
    const { transport } = provider([], () => response({}, 401));
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'Milo' });
    const id = String(created['id']);
    await client.update('/pets', id, { tag: 'cat' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('blocked'),
    );
    await client.resolveWrite('/pets', id, { action: 'discard' });
    expect(client.pendingWrites()).toEqual([]);
    expect(await client.get('/pets', id)).toBeUndefined();
    expect(client.authBlocked()).toBeDefined();
  });

  it("retries auth failures with backoff under onAuthFailure: 'retry'", async () => {
    const blocks: AuthBlock[] = [];
    const { pets, writes, transport } = provider([rex], (_r, n) =>
      n <= 2 ? response({}, 401) : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      onAuthFailure: 'retry',
      onAuthBlocked: (b) => blocks.push(b),
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(writes).toHaveLength(3);
    expect(pets.get('1')).toMatchObject({ name: 'Rex II' });
    expect(blocks).toEqual([]);

    const refused = provider([rex], () => response({}, 403));
    const bounded = createApiClient(document(), {
      transport: refused.transport,
      onAuthFailure: 'retry',
      retry: { baseDelayMs: 1, maxAttempts: 2 },
    });
    await bounded.sync();
    await bounded.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(bounded.pendingWrites()[0]).toMatchObject({
        state: 'failed',
        attempts: 2,
        lastStatus: 403,
      }),
    );
    expect(bounded.authBlocked()).toBeUndefined();
  });
});

describe('classifyWriteFailure', () => {
  it('overrides the default classes', async () => {
    const seen: WriteFailure[] = [];
    const { writes, transport } = provider([rex, milo], (r, n) => {
      if (r.method === 'DELETE') return response({}, 404);
      if (r.url.pathname === '/api/pets/1' && n <= 2)
        return response({ error: 'locked' }, 422, { 'X-Invented': 'yes' });
      return undefined;
    });
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
      classifyWriteFailure: (failure) => {
        seen.push(failure);
        if (failure.status === 422) return 'retry';
        if (failure.type === 'delete')
          return defaultWriteFailureClass(failure) === 'satisfied'
            ? 'permanent'
            : 'retry';
        return defaultWriteFailureClass(failure);
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    await client.remove('/pets', '2');
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { type: 'delete', state: 'failed', lastStatus: 404 },
      ]),
    );
    expect(seen[0]).toEqual({
      type: 'update',
      method: 'PUT',
      status: 422,
      headers: { 'x-invented': 'yes' },
      body: '{"error":"locked"}',
      resource: '/pets',
      id: '1',
      afterRenewal: false,
    });
  });

  it('uses the default when the classifier throws or returns something else', async () => {
    for (const classifier of [
      (): never => {
        throw new Error('invented bug');
      },
      (): never => 'later' as never,
    ]) {
      const { writes, transport } = provider([rex], () => response({}, 422));
      const client = createApiClient(document(), {
        transport,
        retry: { baseDelayMs: 1 },
        classifyWriteFailure: classifier,
      });
      await client.sync();
      await client.update('/pets', '1', { name: 'Rex II' });
      await vi.waitFor(() =>
        expect(client.pendingWrites()[0]?.state).toBe('failed'),
      );
      expect(writes).toHaveLength(1);
    }
  });

  it('treats satisfied as permanent for an update', async () => {
    const { writes, transport } = provider([rex], () => response({}, 404));
    const client = createApiClient(document(), {
      transport,
      classifyWriteFailure: () => 'satisfied',
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    expect(writes).toHaveLength(1);
  });
});
