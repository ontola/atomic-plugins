import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  prepareDocument,
  readCollections,
  type Transport,
} from '../../syncables/src/browser.js';
import type { OpenApiDocument } from '../../syncables/src/openapi/types.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const compose = (catalog: string): OpenApiDocument =>
  prepareDocument(JSON.parse(execFileSync(
    'python3', ['overlays/tests/compose_gitlab_platform.py', 'notion'],
    {
      cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ONBOARDING_CATALOG_PATH: `overlays/catalog/${catalog}` },
    },
  )) as OpenApiDocument);

const reply = (body: unknown) => ({
  status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// Exact catalog composition, with synthetic provider responses. No live account.
function server(capped: boolean) {
  const cursors: unknown[] = [];
  const transport: Transport = async ({ url, body }) => {
    if (url.pathname.endsWith('/search')) {
      return reply({ results: [{ object: 'data_source', id: 'ds1' }], next_cursor: null, has_more: false });
    }
    if (url.pathname.endsWith('/data_sources/ds1/query')) {
      const input = JSON.parse(body ?? '{}');
      cursors.push(input.start_cursor ?? null);
      const second = input.start_cursor === 'next';
      return reply({
        results: [{ object: 'page', id: second ? 'page2' : 'page1' }],
        next_cursor: second ? null : 'next', has_more: !second,
        ...(capped ? { request_status: { type: 'incomplete', incomplete_reason: 'query_result_limit_reached' } } : {}),
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { transport, cursors };
}

describe('Notion cap detection through dated catalogs', () => {
  it('shows the old catalog treating a capped traversal as complete', async () => {
    const fake = server(true);
    const result = await readCollections(compose('2026-10-30-production-keep-writes.json'), { transport: fake.transport });
    expect(result.errors).toEqual([]);
    const pages = result.collections.find((entry) => entry.collection.resource === 'page');
    expect(pages?.complete).toBe(true);
    expect(pages?.items.map((item) => item['id'])).toEqual(['page1', 'page2']);
    expect(fake.cursors).toEqual([null, 'next']);
  });

  it('keeps the records but marks the candidate traversal incomplete', async () => {
    const fake = server(true);
    const result = await readCollections(compose('2026-11-06-overlay-fixes.json'), { transport: fake.transport });
    expect(result.errors).toEqual([]);
    const pages = result.collections.find((entry) => entry.collection.resource === 'page');
    expect(pages?.items.map((item) => item['id'])).toEqual(['page1', 'page2']);
    expect(pages?.complete).toBe(false);
    expect(pages?.notComplete).toMatch(/server marked the result incomplete/);
    expect(fake.cursors).toEqual([null, 'next']);
  });

  it('completes the candidate traversal when no page is capped', async () => {
    const fake = server(false);
    const result = await readCollections(compose('2026-11-06-overlay-fixes.json'), { transport: fake.transport });
    expect(result.errors).toEqual([]);
    const pages = result.collections.find((entry) => entry.collection.resource === 'page');
    expect(pages?.complete).toBe(true);
    expect(pages?.items).toHaveLength(2);
  });
});
