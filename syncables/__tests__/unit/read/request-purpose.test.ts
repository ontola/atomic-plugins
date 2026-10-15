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
function requestLiterals(): { at: string; purpose: boolean }[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk(src);
  const found: { at: string; purpose: boolean }[] = [];
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
    const literals = requestLiterals();
    // A stored response record (`storeResponse`), not a request.
    const notRequests = new Set(['read/responses.ts']);
    const missing = literals
      .filter((l) => !notRequests.has(l.at.split(':')[0]!))
      .filter((l) => !l.purpose)
      .map((l) => l.at);
    expect(missing).toEqual([]);
    // The scan finds the senders it should: pages, describers, zones,
    // records, writes, preconditions and the inbox.
    expect(literals.length).toBeGreaterThanOrEqual(10);
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
});
