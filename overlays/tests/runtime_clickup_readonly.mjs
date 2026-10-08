#!/usr/bin/env node
// Runs the pinned and composed ClickUp document through the shipped Syncables
// consumer with synthetic provider responses. It makes no provider requests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const catalog = 'overlays/catalog/2026-10-08-gitlab-tasks-clickup.json';
const composed = execFileSync(
  'python3',
  ['overlays/tests/compose_gitlab_platform.py', 'clickup'],
  {
    cwd: repo,
    env: { ...process.env, ONBOARDING_CATALOG_PATH: catalog },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  },
);
const { prepareDocument, describePlatform, readPlatform } = await import(
  '../../syncables/build/src/browser.js'
);
const document = prepareDocument(JSON.parse(composed), []);
const description = describePlatform(document);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

assert(
  JSON.stringify(description.collections) ===
    JSON.stringify(['workspaces', 'workspaceTasks']),
  `Expected root workspace and child task collections; got ${description.collections}`,
);
assert(
  description.parameters.length === 0,
  `Workspace ID should be supplied by the root workspace records; got ${description.parameters}`,
);
assert(
  description.upstream === 'https://api.clickup.com/api',
  `Unexpected upstream base: ${description.upstream}`,
);

const requests = [];
const tasks = Array.from({ length: 100 }, (_, index) => ({
  id: `task-${index}`,
  name: `Task ${index}`,
  team_id: '1234',
  parent: null,
}));
const result = await readPlatform(document, {
  platform: 'clickup',
  constants: {},
  limits: { maxPages: 4, maxRecords: 1000 },
  transport: async ({ url, method }) => {
    assert(method === 'GET', `Expected GET; got ${method}`);
    const request = new URL(url.href);
    requests.push(request);
    if (request.pathname === '/api/v2/team') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ teams: [{ id: '1234', name: 'Workspace' }] }),
      };
    }
    if (request.pathname === '/api/v2/team/1234/task') {
      assert(request.searchParams.get('page') === '0', 'The first ClickUp task request must use page 0');
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tasks }),
      };
    }
    throw new Error(`Unexpected ClickUp request ${request.href}`);
  },
});

assert(requests.length === 2, `Expected workspace traversal and one task page; got ${requests.length} requests`);
assert(requests[0].href === 'https://api.clickup.com/api/v2/team', 'Workspace request lost the server base path');
assert(
  requests[1].href === 'https://api.clickup.com/api/v2/team/1234/task?page=0',
  `Task child must inherit the workspace ID and base path: ${requests[1].href}`,
);
assert(result.errors.length === 0, `Syncables reported errors: ${result.errors.join('; ')}`);
assert(
  result.records.filter((record) => record.resource === 'task').length === 100,
  'Syncables must import the 100 tasks returned on the first page',
);

// ClickUp documents a 100-task response cap, but neither its official
// reference nor the pinned OAD declares a continuation/terminal field. The
// consumer consequently stops after this page. Pagination Schemes gives the
// page role 1-based semantics, so the ClickUp 0-based parameter is left as a
// fixed list query and cannot be incremented by this consumer.
console.log(JSON.stringify({
  collections: description.collections,
  inputs: description.parameters,
  importedTaskCount: result.records.filter((record) => record.resource === 'task').length,
  requests: requests.map(({ href }) => href),
  pageIndexIssue: 'ClickUp page is 0-based; the supported pageNumber role is 1-based, so the page parameter cannot be incremented.',
  paginationLimit: 'No declared continuation field; Syncables stops after the first page.',
}, null, 2));
