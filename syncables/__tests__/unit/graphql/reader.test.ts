// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import {
  readGraphQLCollection,
  type GraphQLCollection,
  type GraphQLExecutor,
} from '../../../src/graphql/reader.js';

const collection = (kind = 'relay'): GraphQLCollection =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../openapi-extensions/spec/graphql-integration/examples/${kind}-collections.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ).collections[0] as GraphQLCollection;
const response = (
  nodes: unknown[] = [],
  more = false,
  cursor: string | null = null,
): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify({
    data: {
      repository: {
        issues: { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } },
      },
    },
  }),
});

describe('GraphQL collection reader using the contract fixtures', () => {
  it('uses operation IDs, preserves inputs and accepts an empty terminal page', async () => {
    const execute = vi
      .fn<GraphQLExecutor>()
      .mockResolvedValueOnce(response([{ id: 'a' }], true, 'next'))
      .mockResolvedValueOnce(response());
    const variables = { name: 'demo', first: 2 };
    const result = await readGraphQLCollection(collection(), {
      execute,
      variables,
    });
    expect(result).toEqual({
      items: [{ id: 'a' }],
      traversalComplete: true,
      absenceEvidence: false,
    });
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      {
        operationId: 'RepositoryIssues',
        variables: { name: 'demo', first: 2, after: null },
      },
      {
        operationId: 'RepositoryIssues',
        variables: { name: 'demo', first: 2, after: 'next' },
      },
    ]);
    expect(variables).toEqual({ name: 'demo', first: 2 });
  });

  it('continues offset short pages by requested size until empty', async () => {
    const execute = vi
      .fn<GraphQLExecutor>()
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ data: { rows: [{ id: 'a' }] } }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ data: { rows: [{ id: 'b' }] } }),
      })
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({ data: { rows: [] } }),
      });
    const result = await readGraphQLCollection(collection('offset'), {
      execute,
      variables: { limit: 2 },
    });
    expect(result.traversalComplete).toBe(true);
    expect(result.absenceEvidence).toBe(false);
    expect(
      execute.mock.calls.map(([request]) => request.variables['offset']),
    ).toEqual([0, 2, 4]);
  });

  it('rejects HTTP 200 partial errors and preserves earlier accepted pages', async () => {
    const execute = vi
      .fn<GraphQLExecutor>()
      .mockResolvedValueOnce(response([{ id: 'a' }], true, 'next'))
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          data: { repository: null },
          errors: [{ message: 'private provider diagnostic' }],
        }),
      });
    const result = await readGraphQLCollection(collection(), {
      execute,
      variables: { first: 2 },
    });
    expect(result).toEqual({
      items: [{ id: 'a' }],
      traversalComplete: false,
      absenceEvidence: false,
      error: 'GraphQL response contains errors',
    });
  });

  it.each([
    response([], true, 'next'),
    response([], true, null),
    response([{ id: 'a' }]),
    response([{ title: 'missing id' }]),
  ])(
    'rejects repeated/missing cursors and duplicate/missing identities',
    async (second) => {
      const execute = vi
        .fn<GraphQLExecutor>()
        .mockResolvedValueOnce(response([{ id: 'a' }], true, 'next'))
        .mockResolvedValueOnce(second);
      const result = await readGraphQLCollection(collection(), {
        execute,
        variables: { first: 2 },
      });
      expect(result.traversalComplete).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.items).toEqual([{ id: 'a' }]);
    },
  );

  it.each([
    { status: 429, body: '{}' },
    { status: 200, body: 'invalid JSON' },
    { status: 200, body: JSON.stringify({ data: null }) },
    { status: 200, body: JSON.stringify({ data: { repository: null } }) },
    { status: 200, body: JSON.stringify([{ data: {} }]) },
    { status: 200, body: JSON.stringify({ data: {}, errors: null }) },
  ])('fails closed on invalid responses and rate exhaustion', async (reply) => {
    const result = await readGraphQLCollection(collection(), {
      execute: async () => reply,
      variables: { first: 2 },
    });
    expect(result.traversalComplete).toBe(false);
    expect(result.absenceEvidence).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects starting-position overrides before calling the executor', async () => {
    const execute = vi.fn<GraphQLExecutor>();
    const result = await readGraphQLCollection(collection(), {
      execute,
      variables: { first: 2, after: null },
    });
    expect(result.error).toMatch(/traversal position/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('enforces page, item and UTF-8 byte budgets', async () => {
    for (const limits of [
      { maxPages: 1 },
      { maxItems: 1 },
      { maxResponseBytes: 1 },
    ]) {
      const execute = vi
        .fn<GraphQLExecutor>()
        .mockResolvedValueOnce(response([{ id: 'a' }], true, 'next'))
        .mockResolvedValueOnce(response([{ id: 'b' }]));
      const result = await readGraphQLCollection(collection(), {
        execute,
        variables: { first: 2 },
        limits,
      });
      expect(result.traversalComplete).toBe(false);
      expect(result.error).toBeDefined();
    }
  });

  it('rejects oversized pages and invalid explicit page sizes', async () => {
    const result = await readGraphQLCollection(collection(), {
      execute: async () => response([{ id: 'a' }, { id: 'b' }]),
      variables: { first: 1 },
    });
    expect(result.error).toMatch(/page size/);
    for (const first of [0, true, '2', null, undefined]) {
      const execute = vi.fn<GraphQLExecutor>();
      const invalid = await readGraphQLCollection(collection(), {
        execute,
        variables: { first },
      });
      expect(invalid.error).toBeDefined();
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('sanitizes executor exceptions', async () => {
    const result = await readGraphQLCollection(collection(), {
      execute: async () => {
        throw new Error('credential-bearing exception');
      },
      variables: { first: 2 },
    });
    expect(result.error).toBe('GraphQL executor failed');
  });

  it('bundles for the browser without Node built-ins or a GraphQL parser', async () => {
    const bundle = await build({
      entryPoints: ['src/graphql/reader.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
    });
    expect(bundle.outputFiles[0]!.text).toContain('readGraphQLCollection');
  });
});
