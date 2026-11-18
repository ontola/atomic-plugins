import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  describePlatform,
  prepareDocument,
  readCollections,
  type OpenApiDocument,
  type OverlayDocument,
  type Transport,
  type TransportResponse,
} from '../../../src/browser.js';

const overlay = JSON.parse(
  readFileSync(
    new URL(
      '../../../../overlays/APIs/github.com/github-issues/1.1.4/builtin-read-model-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as OverlayDocument;

// A configured proxy's older composed OAD: unrelated collections remain
// available, but organization discovery and canonical issue params are absent.
const configuredDocument: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Configured GitHub API', version: '1' },
  servers: [{ url: 'https://api.github.com' }],
  paths: {
    '/other/{workspace}/records': {
      get: { responses: { '200': { description: 'Unrelated records.' } } },
    },
  },
  components: {
    crudResources: {
      other: {
        identity: {
          urlTemplate: '/other/{workspace}/records/{record_id}',
          bindings: { record_id: { field: 'id' } },
        },
        collections: {
          unrelated: { urlTemplate: '/other/{workspace}/records' },
        },
      },
    },
  },
};

const document = prepareDocument(configuredDocument, [overlay]);
const reply = (items: unknown[], next?: string): TransportResponse => ({
  status: 200,
  headers: next ? { link: `<${next}>; rel="next"` } : {},
  body: JSON.stringify(items),
});
const repo = (id: number): Record<string, unknown> => ({
  id,
  name: 'repository-' + id,
  owner: { id: 123, login: 'organization', type: 'Organization' },
});

const issue = (number: number): Record<string, unknown> => ({
  id: 1000 + number,
  number,
  title: 'Issue ' + number,
  state: 'open',
  updated_at: '2026-11-18T10:00:00Z',
});

describe('bundled GitHub read model through the actual browser reader', () => {
  it('discovers opt-in collections without replacing the configured document', () => {
    expect(describePlatform(document).collections).toEqual([
      'unrelated',
      'githubOrganizations',
      'githubRepositories',
      'repositoryIssues',
    ]);
    expect(describePlatform(document).upstream).toBe('https://api.github.com/');
    expect(configuredDocument.paths['/user/orgs']).toBeUndefined();
    expect(document.paths['/user/orgs']?.get).toBeDefined();
  });

  it('walks only selected repositories and retains raw owner metadata', async () => {
    const next = 'https://api.github.com/user/repos?per_page=100&page=2';
    const transport = vi.fn<Transport>(async (request) =>
      request.url.searchParams.has('page')
        ? reply([repo(457)])
        : reply([repo(456)], next),
    );
    const result = await readCollections(document, {
      transport,
      collectionNames: ['githubRepositories'],
    });
    expect(result.errors).toEqual([]);
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]?.complete).toBe(true);
    expect(result.collections[0]?.items).toEqual([repo(456), repo(457)]);
    expect(transport.mock.calls.map(([request]) => request.url.href)).toEqual([
      'https://api.github.com/user/repos?per_page=100',
      next,
    ]);
  });

  it('reads canonical Issues directly with fixed history query and cursor links', async () => {
    const next =
      'https://api.github.com/repositories/456/issues?per_page=100&state=all&page=2&after=Y3Vyc29yJTNE';
    const transport = vi.fn<Transport>(async (request) =>
      request.url.searchParams.has('after')
        ? reply([issue(2)])
        : reply([issue(1)], next),
    );
    const result = await readCollections(document, {
      transport,
      collectionNames: ['repositoryIssues'],
      constants: { repository_id: '456' },
    });
    expect(result.errors).toEqual([]);
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]?.complete).toBe(true);
    expect(result.collections[0]?.items).toEqual([issue(1), issue(2)]);
    expect(transport.mock.calls.map(([request]) => request.url.href)).toEqual([
      'https://api.github.com/repositories/456/issues?per_page=100&state=all',
      next,
    ]);
  });

  it('discovers repository bindings only when a selected Issues read needs them', async () => {
    const transport = vi.fn<Transport>(async (request) =>
      reply(request.url.pathname === '/user/repos' ? [repo(456)] : [issue(1)]),
    );
    const result = await readCollections(document, {
      transport,
      collectionNames: ['repositoryIssues'],
    });
    expect(result.errors).toEqual([]);
    expect(
      result.collections.map((snapshot) => snapshot.collection.name),
    ).toEqual(['githubRepositories', 'repositoryIssues']);
    expect(
      transport.mock.calls.map(([request]) => request.url.pathname),
    ).toEqual(['/user/repos', '/repositories/456/issues']);
  });

  it('keeps the accepted snapshot when its request budget stops pagination', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply(
        [repo(456)],
        'https://api.github.com/user/repos?per_page=100&page=2',
      ),
    );
    const result = await readCollections(document, {
      transport,
      collectionNames: ['githubRepositories'],
      limits: { maxRequests: 1 },
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.collections[0]?.items).toEqual([repo(456)]);
    expect(result.collections[0]?.complete).toBe(false);
    expect(result.errors[0]).toContain('exceeds 1 requests');
  });

  it('refuses a cross-origin next link before sending it and keeps accepted rows', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply([repo(456)], 'https://other.example/user/repos?page=2'),
    );
    const result = await readCollections(document, {
      transport,
      collectionNames: ['githubRepositories'],
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.collections[0]?.items).toEqual([repo(456)]);
    expect(result.collections[0]?.complete).toBe(false);
    expect(result.errors[0]).toContain('left the API origin');
  });
});
