// @wc-ignore-file
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/read/pages.js';
import {
  createApiClient,
  Pacer,
  prepareDocument,
  type OpenApiDocument,
  type RequestPurpose,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';
import { throttledPets } from '../../fixtures/throttling.js';

// #566's "smallest backward-compatible extension": every request syncables
// makes says why (`TransportRequest.purpose`), so a caching transport can
// tell a list read it may answer from a precondition read or a write it
// must not; and a response a cache answered (`fromCache`) gives back what
// it was counted against (pacing, the read's maxRequests).

const src = new URL('../../../src/', import.meta.url).pathname;

/** Every object literal under src/ with `url`, `method` and `headers`: a request. */
function requestLiterals(): {
  at: string;
  purpose: boolean;
  names: string[];
}[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk(src);
  const found: { at: string; purpose: boolean; names: string[] }[] = [];
  for (const file of files) {
    // The mock server answers requests; it makes none.
    if (file.includes('/mock-server/')) continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties.map((p) =>
          p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
            ? p.name.text
            : '',
        );
        if (['url', 'method', 'headers'].every((n) => names.includes(n)))
          found.push({
            at: `${relative(src, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
            purpose: names.includes('purpose'),
            names,
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe('every request syncables makes sets a purpose', () => {
  it('in every request literal under src/ (a new one without it fails here)', () => {
    // The one literal that is not a request: the stored response record
    // that `storeResponse` receives, with its `status` and `receivedAt`.
    const isStoredResponse = (l: { at: string; names: string[] }): boolean =>
      l.at.startsWith('read/responses.ts:') &&
      l.names.includes('status') &&
      l.names.includes('receivedAt');
    const all = requestLiterals();
    expect(all.filter(isStoredResponse)).toHaveLength(1);
    const literals = all.filter((l) => !isStoredResponse(l));
    const missing = literals.filter((l) => !l.purpose).map((l) => l.at);
    expect(missing).toEqual([]);
    // The senders the scan finds, per file: a new request literal (with or
    // without a purpose) changes this, so it is looked at.
    const perFile: Record<string, number> = {};
    for (const l of literals) {
      const file = l.at.split(':')[0]!;
      perFile[file] = (perFile[file] ?? 0) + 1;
    }
    expect(perFile).toEqual({
      'client/client.ts': 6,
      'inbox/client.ts': 1,
      'read/pages.ts': 3,
      'read/runtime-schemas.ts': 1,
      'read/time-zone.ts': 1,
    });
  });

  it('and the internal senders require one (a type error otherwise)', async () => {
    const budget = new Budget(async () => ({
      status: 200,
      headers: {},
      body: '[]',
    }));
    const request = {
      url: new URL('https://api.example.com/x'),
      method: 'GET' as const,
      headers: {},
    };
    // @ts-expect-error: Budget.send takes a PurposedRequest.
    void budget.send(request).catch(() => undefined);
    await expect(
      budget.send({ ...request, purpose: 'list' }),
    ).resolves.toMatchObject({
      status: 200,
    });
  });

  it('at run time, through a sync, an update and a paginate', async () => {
    const seen: (RequestPurpose | undefined)[] = [];
    const doc = prepareDocument({
      ...petsDocument,
      servers: [{ url: 'https://api.example.com' }],
    } as unknown as OpenApiDocument);
    const transport: Transport = async (request: TransportRequest) => {
      seen.push(request.purpose);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          request.method === 'GET'
            ? [{ id: '1', name: 'Rex' }]
            : { id: '1', name: 'Rex II' },
        ),
      };
    };
    const client = createApiClient(doc, { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.paginate('/pets');
    expect(seen).not.toContain(undefined);
    expect(new Set(seen)).toEqual(new Set(['list', 'write']));
  });
});

describe('a response a cache answered', () => {
  it('gives the pacer back the request it counted', () => {
    const pacer = new Pacer(
      new Map([['api', { requests: 2, seconds: 60, kind: 'sliding' }]]),
    );
    // 2 at 0.8 allows one a minute.
    pacer.take(['api'], 1000);
    expect(pacer.delay(['api'], 1000)).toBeGreaterThan(0);
    pacer.release(['api'], 1000);
    expect(pacer.delay(['api'], 1000)).toBe(0);
    // Nothing counted at that time: nothing changes.
    pacer.take(['api'], 2000);
    pacer.release(['api'], 3000);
    expect(pacer.delay(['api'], 3000)).toBeGreaterThan(0);
  });

  it('does not make the client wait for its quota', async () => {
    const throttling = {
      limits: {
        api: { requests: 2, window: { seconds: 60, kind: 'sliding' } },
      },
      applies: ['api'],
    };
    const run = async (fromCache: boolean): Promise<number[]> => {
      const slept: number[] = [];
      const client = createApiClient(
        prepareDocument(throttledPets(throttling)),
        {
          transport: async () => ({
            status: 200,
            headers: {},
            body: JSON.stringify([{ id: '1', name: 'Rex' }]),
            ...(fromCache ? { fromCache: true } : {}),
          }),
          sleep: async (ms) => {
            slept.push(ms);
          },
        },
      );
      await client.sync();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await client.sync();
      return slept;
    };
    expect(await run(false)).toHaveLength(1);
    expect(await run(true)).toEqual([]);
  });

  it('does not count against the read’s maxRequests', async () => {
    const budget = (fromCache: boolean): Budget =>
      new Budget(
        async () => ({
          status: 200,
          headers: {},
          body: '[]',
          ...(fromCache ? { fromCache: true } : {}),
        }),
        { maxRequests: 2 },
      );
    const request = {
      url: new URL('https://api.example.com/x'),
      method: 'GET' as const,
      headers: {},
      purpose: 'list' as const,
    };
    const counted = budget(false);
    await counted.send(request);
    await counted.send(request);
    await expect(counted.send(request)).rejects.toThrow(/2 requests/);
    const cached = budget(true);
    for (let i = 0; i < 5; i++) await cached.send(request);
  });

  it('is not taken for a 304 from the network, which the conditional cache answers', async () => {
    // Two collections, so one sync makes two requests against
    // maxRequests: 1, which only answers a cache gave back can pass.
    const pets = petsDocument as unknown as {
      paths: Record<string, unknown>;
    };
    const doc = prepareDocument({
      ...petsDocument,
      paths: {
        ...pets.paths,
        '/cats': pets.paths['/pets'],
        '/cats/{catId}': JSON.parse(
          JSON.stringify(pets.paths['/pets/{petId}']).replaceAll(
            'petId',
            'catId',
          ),
        ),
      },
      servers: [{ url: 'https://api.example.com' }],
    } as unknown as OpenApiDocument);
    let sent = 0;
    const transport: Transport = async (request) => {
      sent += 1;
      // A caching transport answered the first read; the second is a real
      // conditional request the server answers 304.
      return request.headers['if-none-match']
        ? { status: 304, headers: {}, body: '' }
        : {
            status: 200,
            headers: { etag: '"1"' },
            body: JSON.stringify([{ id: '1', name: 'Rex' }]),
            fromCache: true,
          };
    };
    const client = createApiClient(doc, {
      transport,
      limits: { maxRequests: 1 },
    });
    await client.sync();
    expect(sent).toBe(2);
    // Before, the 304 came back with the stored fromCache: true, so
    // neither request was counted.
    await expect(client.sync()).rejects.toThrow(/exceeds 1 requests/);
  });
});
