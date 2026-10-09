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
const { prepareDocument, describePlatform, readPlatform, readCollections } = await import(
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

// 250 synthetic tasks: pages 0 and 1 full (100 each), page 2 short (50).
const TOTAL = 250;
const PAGE = 100;
const taskPage = (page) =>
  Array.from({ length: Math.max(0, Math.min(PAGE, TOTAL - page * PAGE)) }, (_, i) => {
    const index = page * PAGE + i;
    return { id: `task-${index}`, name: `Task ${index}`, team_id: '1234', parent: null };
  });

const requests = [];
const transport = async ({ url, method }) => {
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
    const page = Number(request.searchParams.get('page'));
    assert(Number.isInteger(page) && page >= 0, `Bad page ${request.searchParams.get('page')}`);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: taskPage(page) }),
    };
  }
  throw new Error(`Unexpected ClickUp request ${request.href}`);
};

const result = await readPlatform(document, {
  platform: 'clickup',
  constants: {},
  limits: { maxRecords: 1000 },
  transport,
});

const base = 'https://api.clickup.com/api/v2';
assert(
  JSON.stringify(requests.map(({ href }) => href)) ===
    JSON.stringify([
      `${base}/team`,
      `${base}/team/1234/task?page=0`,
      `${base}/team/1234/task?page=1`,
      `${base}/team/1234/task?page=2`,
    ]),
  `Expected the workspace read, then task pages 0, 1 and 2 (Pagination Schemes 0.6.0 start: 0, ended by the short page 2); got ${requests.map(({ href }) => href)}`,
);
assert(result.errors.length === 0, `Syncables reported errors: ${result.errors.join('; ')}`);
const imported = result.records.filter((record) => record.resource === 'task').length;
assert(imported === TOTAL, `Syncables must import all ${TOTAL} tasks; got ${imported}`);

// The short-page end is assumed (ClickUp documents only the 100-task cap),
// so the read is not complete: no absence may be inferred from it.
requests.length = 0;
const collections = await readCollections(document, { transport, constants: {} });
const taskRead = collections.collections.find((snapshot) => snapshot.collection.name === 'workspaceTasks');
assert(taskRead && taskRead.items.length === TOTAL, 'readCollections must return every task');
assert(taskRead.complete === false, 'An assumed short-page end must not make the task read complete');
assert(/assumed, not documented/.test(taskRead.notComplete ?? ''), `Unexpected notComplete: ${taskRead.notComplete}`);

console.log(JSON.stringify({
  collections: description.collections,
  inputs: description.parameters,
  importedTaskCount: imported,
  taskPagesRequested: [0, 1, 2],
  taskReadComplete: taskRead.complete,
  notComplete: taskRead.notComplete,
}, null, 2));
