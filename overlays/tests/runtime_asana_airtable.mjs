#!/usr/bin/env node
// Exercises composed provider metadata with the shipped Syncables browser
// consumer. No provider credentials or network API calls are used.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const { describePlatform, paginate, prepareDocument, readPlatform } = await import(
  '../../syncables/build/src/browser.js'
);

function compose(platform) {
  const catalog = JSON.parse(
    readFileSync(join(repo, 'overlays/catalog/2026-10-08-asana-airtable.json'), 'utf8'),
  );
  const entry = catalog.platforms.find((candidate) => candidate.name === platform);
  if (!entry) throw new Error(`Platform ${platform} is missing from the dated catalog`);
  const source = entry.openapi.match(/\/([0-9a-f]{40})\/(APIs\/.*\/openapi\.yaml)$/);
  if (!source) throw new Error(`${platform} catalog OAD URL must pin a full revision`);
  const [, pin] = source;
  const raw = execFileSync('python3', ['overlays/tests/compose_catalog_platform.py', platform], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { document: prepareDocument(JSON.parse(raw), []), pin };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exercise({ label, document, path, pathParams, pageSize, envelope, cursorField, cursorValue, rows }) {
  const requests = [];
  const transport = async ({ url, method }) => {
    assert(method === 'GET', `${label}: consumer must use GET`);
    requests.push(new URL(url.href));
    const index = requests.length - 1;
    if (index === 0) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [envelope]: rows.slice(0, 1), [cursorField]: cursorValue }),
      };
    }
    if (index === 1) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [envelope]: rows.slice(1), [cursorField]: null }),
      };
    }
    throw new Error(`${label}: unexpected request after terminal page`);
  };

  const result = await paginate(document, {
    transport,
    path,
    pathParams,
    pageSize,
    limits: { maxPages: 4, maxRecords: 10 },
  });
  assert(JSON.stringify(result) === JSON.stringify(rows), `${label}: pages must return all synthetic rows`);
  assert(requests.length === 2, `${label}: expected exactly two requests, got ${requests.length}`);
  assert(!requests[0].searchParams.has('offset'), `${label}: first request must not include a cursor`);
  assert(requests[1].searchParams.get('offset') === 'opaque-next', `${label}: next request must use opaque cursor`);
  return requests;
}

const asana = compose('asana');
const asanaDescription = describePlatform(asana.document);
assert(asanaDescription.collections.includes('workspaces'), 'Asana workspaces collection missing');
assert(asanaDescription.collections.includes('workspaceProjects'), 'Asana workspace projects collection missing');
assert(asanaDescription.collections.includes('projectTasks'), 'Asana project tasks collection missing');
assert(asanaDescription.parameters.length === 0, `Asana should discover no root inputs: ${asanaDescription.parameters}`);
const asanaRequests = await exercise({
  label: 'Asana',
  document: asana.document,
  path: '/workspaces/{workspace_gid}/projects',
  pathParams: { workspace_gid: 'ws-1' },
  pageSize: 2,
  envelope: 'data',
  cursorField: 'next_page',
  cursorValue: { offset: 'opaque-next' },
  rows: [{ gid: 'p-1' }, { gid: 'p-2' }],
});
assert(asanaRequests[0].pathname.endsWith('/workspaces/ws-1/projects'), 'Asana path binding or server base path lost');
assert(asanaRequests[0].searchParams.get('limit') === '2', 'Asana page size must be sent as limit');
assert(asanaRequests[1].searchParams.get('limit') === '2', 'Asana page size must persist on next page');

const airtable = compose('airtable');
const airtableDescription = describePlatform(airtable.document);
assert(airtableDescription.collections.includes('tableRecords'), 'Airtable table records collection missing');
assert(
  JSON.stringify(airtableDescription.parameters) === JSON.stringify(['baseId', 'tableIdOrName']),
  `Airtable requires explicit base and table inputs: ${airtableDescription.parameters}`,
);
const airtableRequests = await exercise({
  label: 'Airtable',
  document: airtable.document,
  path: '/v0/{baseId}/{tableIdOrName}',
  pathParams: { baseId: 'base-1', tableIdOrName: 'Tasks' },
  pageSize: 2,
  envelope: 'records',
  cursorField: 'offset',
  cursorValue: 'opaque-next',
  rows: [{ id: 'rec-1' }, { id: 'rec-2' }],
});
assert(airtableRequests[0].pathname === '/v0/base-1/Tasks', 'Airtable request must retain /v0 server path');
assert(airtableRequests[1].searchParams.get('pageSize') === '2', 'Airtable page size must persist on next page');

const airtableCollectionRequests = [];
const imported = await readPlatform(airtable.document, {
  platform: 'airtable',
  constants: { baseId: 'base-1', tableIdOrName: 'Tasks' },
  limits: { maxPages: 4, maxRecords: 10 },
  transport: async ({ url }) => {
    const request = new URL(url.href);
    airtableCollectionRequests.push(request);
    const page = request.searchParams.has('offset') ? 2 : 1;
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(page === 1
        ? { records: [{ id: 'rec-1' }], offset: 'collection-cursor' }
        : { records: [{ id: 'rec-2' }] }),
    };
  },
});
assert(imported.records.map((record) => record.id).join(',') === 'rec-1,rec-2', 'Airtable collection reader must import both records');
assert(airtableCollectionRequests.length === 2, 'Airtable collection reader must stop after the terminal page');
assert(airtableCollectionRequests[1].searchParams.get('offset') === 'collection-cursor', 'Airtable collection reader must request the next page');

console.log(JSON.stringify({
  asana: { pin: asana.pin, collections: asanaDescription.collections, inputs: asanaDescription.parameters, requests: asanaRequests },
  airtable: { pin: airtable.pin, collections: airtableDescription.collections, inputs: airtableDescription.parameters, requests: airtableRequests, imported: imported.records.map(({ id }) => id), collectionRequests: airtableCollectionRequests.map(({ href }) => href) },
}, null, 2));
