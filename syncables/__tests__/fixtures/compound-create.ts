// @wc-ignore-file
/**
 * A GitHub-issues-shaped document with a CRUD Causality 0.5.0 compound
 * create, after the held overlay `claude/github-compound-create-overlay`
 * (`overlays/APIs/github.com/github-issues/1.1.4/compound-create-…`): the
 * issue create sends `labels` (`create: include`, silently dropped without
 * push access), compared through `itemKey: name`, and
 * `issues-add-labels` adds what is missing. A second follow-up,
 * `assignees` with `create: omit` and an invented `issues-add-assignees`,
 * exercises the order of follow-ups. Hand-made, not the composed GitHub
 * document; not verified against a live account.
 */
import type { OpenApiDocument } from '../../src/browser.js';

const pathParams = ['owner', 'repo'].map((name) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string' },
}));

const ok = { '200': { description: 'OK' } };

export function compoundDocument(
  followUps: unknown[] = [
    {
      field: 'labels',
      create: 'include',
      itemKey: 'name',
      operation: 'issues-add-labels',
      bind: {
        'path.issue_number': { from: 'created', field: 'number' },
        'body.labels': { from: 'missing', field: 'labels' },
      },
    },
    {
      field: 'assignees',
      create: 'omit',
      itemKey: 'login',
      operation: 'issues-add-assignees',
      bind: {
        'path.issue_number': { from: 'created', field: 'number' },
        'body.assignees': { from: 'missing', field: 'assignees' },
      },
    },
  ],
): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Issues with a compound create', version: '1.0.0' },
    servers: [{ url: 'https://api.github.example' }],
    paths: {
      '/repos/{owner}/{repo}/issues': {
        parameters: pathParams,
        get: { operationId: 'issues-list-for-repo', responses: ok },
        post: {
          operationId: 'issues-create',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { '201': { description: 'Created' } },
          'x-crud': {
            action: 'create',
            resource: 'issue',
            url: { source: 'template' },
            addedFields: { number: { source: 'generated' } },
            followUps,
          },
        },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}': {
        parameters: [
          ...pathParams,
          {
            name: 'issue_number',
            in: 'path',
            required: true,
            schema: { type: 'integer' },
          },
        ],
        get: { operationId: 'issues-get', responses: ok },
        patch: {
          operationId: 'issues-update',
          responses: ok,
          'x-crud': { action: 'update', resource: 'issue', mode: 'patch' },
        },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}/labels': {
        post: {
          operationId: 'issues-add-labels',
          parameters: [
            ...pathParams,
            {
              name: 'issue_number',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: ok,
          'x-crud': { action: 'update', resource: 'issue', mode: 'patch' },
        },
      },
      '/repos/{owner}/{repo}/issues/{issue_number}/assignees': {
        post: {
          operationId: 'issues-add-assignees',
          parameters: [
            ...pathParams,
            {
              name: 'issue_number',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { '201': { description: 'Created' } },
          'x-crud': { action: 'update', resource: 'issue', mode: 'patch' },
        },
      },
    },
    components: {
      crudResources: {
        issue: {
          identity: {
            urlTemplate: '/repos/{owner}/{repo}/issues/{issue_number}',
            bindings: { issue_number: { field: 'number' } },
          },
          collections: {
            issues: { urlTemplate: '/repos/{owner}/{repo}/issues' },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}
