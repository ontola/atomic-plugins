#!/usr/bin/env node
// Exercises the composed GitLab catalog entry with Syncables and synthetic pages.
// No GitLab API calls or credentials are used.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const catalogPath = process.env.GITLAB_CATALOG_PATH ?? 'overlays/catalog/2026-10-08-gitlab.json';
const catalog = JSON.parse(readFileSync(resolve(repo, catalogPath), 'utf8'));
const entry = catalog.platforms.find(({ name }) => name === 'gitlab');
if (!entry) throw new Error('GitLab is missing from the candidate catalog');
const { describePlatform, prepareDocument, readPlatform } = await import(
  '../../syncables/build/src/browser.js'
);
const document = prepareDocument(JSON.parse(execFileSync(
  'python3', ['overlays/tests/compose_gitlab_platform.py'],
  { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
)));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const description = describePlatform(document);
assert(description.upstream === 'https://gitlab.com/api/v4', `unexpected upstream: ${description.upstream}`);
assert(JSON.stringify(description.collections) === JSON.stringify(['projects', 'projectIssues']),
  `unexpected collections: ${description.collections}`);
assert(JSON.stringify(description.parameters) === JSON.stringify([]),
  `projectId should be supplied by the projects collection: ${description.parameters}`);

const requests = [];
const selection = entry.selection;
const imported = await readPlatform(document, {
  platform: 'gitlab',
  constants: {},
  selection,
  limits: { maxPages: 8, maxRecords: 20 },
  transport: async ({ url, method }) => {
    assert(method === 'GET', `unexpected method ${method}`);
    const request = new URL(url.href);
    requests.push(request);
    const page = request.searchParams.get('page');
      if (request.pathname === '/api/v4/projects') {
      assert(request.searchParams.get('membership') === 'true', 'catalog must retain membership=true');
      if (!page || page === '1') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json', Link: '<https://gitlab.com/api/v4/projects?membership=true&page=2>; rel="next"' },
          body: JSON.stringify([{ id: 41, name: 'Alpha' }]),
        };
      }
      if (page === '2') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: 42, name: 'Beta' }]) };
      }
    }
    const match = request.pathname.match(/^\/api\/v4\/projects\/(\d+)\/issues$/);
    if (match) {
      const projectId = match[1];
      if (!page || page === '1') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json', Link: `<https://gitlab.com/api/v4/projects/${projectId}/issues?per_page=2&page=2>; rel="next"` },
          body: JSON.stringify([{ id: Number(`${projectId}01`), iid: 1, project_id: Number(projectId), title: `Issue ${projectId}-1` }]),
        };
      }
      if (page === '2') {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: Number(`${projectId}02`), iid: 2, project_id: Number(projectId), title: `Issue ${projectId}-2` }]) };
      }
    }
    throw new Error(`unexpected request ${request.href}`);
  },
});

assert(imported.errors.length === 0, `read returned errors: ${imported.errors.join('; ')}`);
assert(imported.records.filter(({ resource }) => resource === 'project').length === 2,
  'both project pages must import');
assert(imported.records.filter(({ resource }) => resource === 'issue').length === 4,
  'issue pages for both projects must import');
assert(requests.filter(({ pathname }) => pathname === '/api/v4/projects').length === 2,
  'project listing must stop after its terminal page');
assert(requests.filter(({ pathname }) => /\/issues$/.test(pathname)).length === 4,
  'each project issue listing must stop after its terminal page');
assert(requests.some(({ pathname, searchParams }) => pathname.endsWith('/projects/41/issues') && searchParams.get('page') === '2'),
  'project path binding and next-link pagination must be retained');
assert(requests.every(({ origin }) => origin === 'https://gitlab.com'), 'requests must stay on the GitLab origin');

console.log(JSON.stringify({
  pin: entry.openapi.match(/\/([0-9a-f]{40})\/APIs\//)?.[1],
  collections: description.collections,
  rootInputs: description.parameters,
  importedProjects: imported.records.filter(({ resource }) => resource === 'project').map(({ id }) => id),
  importedIssues: imported.records.filter(({ resource }) => resource === 'issue').map(({ id, namespace }) => ({ id, namespace })),
  requests: requests.map(({ href }) => href),
}, null, 2));
