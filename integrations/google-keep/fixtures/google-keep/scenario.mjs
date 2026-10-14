/**
 * Google Keep mock-proxy fixture, registered as `google-keep` in
 * integrations/localthought/fixtures/index.mjs. Its data is SYNTHETIC
 * (synthetic.mjs, hand-written from the Keep API v1 reference; read its
 * header): there is no recording.
 *
 * Served, like the four operations the catalog the real proxy composes for
 * this platform selects (overlays/catalog/2026-10-14-google-keep.json):
 *   GET    /proxy/google-keep/v1/notes[?pageToken=page-<n>]
 *          — notes not in the trash, PAGE_SIZE per page (3, so the five
 *            notes span two pages); an account with none gets `{}`.
 *   GET    /proxy/google-keep/v1/notes/<id>
 *          — the note as it stands, trashed or not; 404 once deleted.
 *   POST   /proxy/google-keep/v1/notes   — a new note owned by OWNER.
 *   DELETE /proxy/google-keep/v1/notes/<id>
 *          — gone for good (`{}`); 403 for a note OWNER does not own,
 *            404 for an unknown one.
 * Anything else is 404. `pageSize` and `filter` are ignored.
 *
 * Test drivers (POST /fixture/google-keep/<name> on the mock proxy, or the
 * instance's methods in-process) stand in for someone working in Keep and
 * for Google failing:
 *   editNote(id, title, text)  a text note's title and text edited in Keep.
 *   checkItem(id, index)       a list note's item checked in Keep.
 *   trashNote(id)              moved to the trash: gone from the list, by id
 *                              `trashed: true`.
 *   restoreNote(id)            out of the trash again.
 *   removeNote(id)             deleted for good: 404 by id.
 *   failNext(count, status = 503, only = 'any' | 'list' | 'lookup' | 'create' | 'delete')
 *   reset()                    back to synthetic.mjs's five notes (a retried
 *                              e2e starts from the same state).
 *   snapshot()                 every note, the trashed and deleted included.
 */
import * as synthetic from './synthetic.mjs';

export const PAGE_SIZE = 3;
const SCOPE = 'https://www.googleapis.com/auth/keep';
const security = [{ googleOffline: [SCOPE] }];

export const document = {
  openapi: '3.0.3',
  info: { title: 'Synthetic Google Keep', version: 'v1' },
  servers: [{ url: 'https://keep.googleapis.com/' }],
  paths: {
    '/v1/notes': {
      get: {
        operationId: 'keep.notes.list',
        parameters: ['filter', 'pageSize', 'pageToken'].map(name => ({
          name,
          in: 'query',
          schema: { type: 'string' },
        })),
        security,
        responses: { 200: { description: 'Notes' } },
      },
      post: {
        operationId: 'keep.notes.create',
        security,
        responses: { 200: { description: 'The new note' } },
      },
    },
    '/v1/notes/{note}': {
      get: {
        operationId: 'keep.notes.get',
        parameters: [
          {
            name: 'note',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        security,
        responses: { 200: { description: 'Note' } },
      },
      delete: {
        operationId: 'keep.notes.delete',
        parameters: [
          {
            name: 'note',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        security,
        responses: { 200: { description: 'Deleted' } },
      },
    },
  },
  components: {
    securitySchemes: {
      googleOffline: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {
              [SCOPE]:
                'See, edit, create and permanently delete all your Google Keep data',
            },
          },
        },
      },
    },
  },
};

const notFound = {
  status: 404,
  body: {
    error: {
      code: 404,
      message: 'Requested entity was not found.',
      status: 'NOT_FOUND',
    },
  },
};

export function googleKeepFixture() {
  let notes = structuredClone(synthetic.notes);
  /** Names `removeNote` or a DELETE took away: 404 by id. */
  const deleted = new Set();
  const failures = [];
  let created = 0;
  let tick = 0;
  /** A synthetic clock: every change is a second after the last. */
  const stamp = () =>
    new Date(Date.UTC(2026, 2, 1, 12, 0, tick++)).toISOString();

  const byName = name => notes.find(n => n.name === name && !deleted.has(name));

  const must = id => {
    const found = byName(id.startsWith('notes/') ? id : `notes/${id}`);
    if (!found) throw new Error(`no note ${id}`);

    return found;
  };

  const failure = kind => {
    const at = failures.findIndex(f => f.only === 'any' || f.only === kind);
    if (at === -1) return undefined;
    const found = failures[at];
    if (--found.count <= 0) failures.splice(at, 1);

    return {
      status: found.status,
      body:
        found.status === 429
          ? {
              error: {
                code: 429,
                message: 'Synthetic rate limit',
                status: 'RESOURCE_EXHAUSTED',
              },
            }
          : {
              error: {
                code: found.status,
                message: `Synthetic failure (${found.status})`,
              },
            },
    };
  };

  return {
    synthetic: true,
    pageSize: PAGE_SIZE,

    request(method, url, input = {}) {
      const match = url.pathname.match(
        /^\/proxy\/google-keep\/v1\/notes(?:\/([^/]+))?$/,
      );
      if (!match) return notFound;
      const id =
        match[1] === undefined
          ? undefined
          : `notes/${decodeURIComponent(match[1])}`;
      const kind =
        id === undefined
          ? method === 'GET'
            ? 'list'
            : method === 'POST'
              ? 'create'
              : undefined
          : method === 'GET'
            ? 'lookup'
            : method === 'DELETE'
              ? 'delete'
              : undefined;
      if (!kind) return notFound;
      const failed = failure(kind);
      if (failed) return failed;

      if (kind === 'list') {
        const rows = notes.filter(n => !n.trashed && !deleted.has(n.name));
        const token = url.searchParams.get('pageToken');
        const page = token ? Number(/^page-(\d+)$/.exec(token)?.[1]) : 1;
        if (!Number.isInteger(page) || page < 1)
          return {
            status: 400,
            body: { error: { code: 400, message: 'Invalid page token' } },
          };
        const start = (page - 1) * PAGE_SIZE;
        const body = {};
        const items = rows.slice(start, start + PAGE_SIZE);
        if (items.length) body.notes = structuredClone(items);
        if (start + PAGE_SIZE < rows.length)
          body.nextPageToken = `page-${page + 1}`;

        return { status: 200, body };
      }

      if (kind === 'lookup') {
        const found = byName(id);

        return found ? { status: 200, body: structuredClone(found) } : notFound;
      }

      if (kind === 'delete') {
        const found = byName(id);
        if (!found) return notFound;
        const own = (found.permissions ?? []).some(
          p => p.role === 'OWNER' && p.email === synthetic.OWNER,
        );
        if (!own)
          return {
            status: 403,
            body: {
              error: {
                code: 403,
                message: 'The caller does not own the note.',
              },
            },
          };
        deleted.add(id);

        return { status: 200, body: {} };
      }

      // create
      if (!input || typeof input !== 'object' || !input.body)
        return {
          status: 400,
          body: { error: { code: 400, message: 'A note needs a body.' } },
        };
      const name = `notes/synthetic-new-${++created}`;
      const at = stamp();
      const made = {
        name,
        createTime: at,
        updateTime: at,
        trashed: false,
        ...(typeof input.title === 'string' && input.title
          ? { title: input.title }
          : {}),
        body: structuredClone(input.body),
        permissions: [synthetic.owner(name.slice('notes/'.length))],
      };
      notes.push(made);

      return { status: 200, body: structuredClone(made) };
    },

    // Drivers.
    editNote(id, title, text) {
      const found = must(id);
      found.title = title;
      found.body = { text: { text } };
      found.updateTime = stamp();

      return structuredClone(found);
    },
    checkItem(id, index) {
      const found = must(id);
      found.body.list.listItems[index].checked = true;
      found.updateTime = stamp();

      return structuredClone(found);
    },
    trashNote(id) {
      const found = must(id);
      found.trashed = true;
      found.trashTime = stamp();
      found.updateTime = found.trashTime;

      return structuredClone(found);
    },
    restoreNote(id) {
      const name = id.startsWith('notes/') ? id : `notes/${id}`;
      deleted.delete(name);
      const found = must(id);
      found.trashed = false;
      delete found.trashTime;

      return structuredClone(found);
    },
    removeNote(id) {
      const found = must(id);
      deleted.add(found.name);

      return { name: found.name, status: 404 };
    },
    failNext(count = 1, status = 503, only = 'any') {
      if (!['any', 'list', 'lookup', 'create', 'delete'].includes(only))
        throw new Error(
          'failNext: only must be any, list, lookup, create or delete',
        );
      failures.push({ count, status, only });

      return { failures: failures.map(f => ({ ...f })) };
    },
    reset() {
      notes = structuredClone(synthetic.notes);
      deleted.clear();
      failures.length = 0;
      created = 0;

      return { notes: notes.length };
    },
    snapshot() {
      return { notes: structuredClone(notes), deleted: [...deleted] };
    },
  };
}

export default {
  title: 'Google Keep',
  document,
  jsonBody: true,
  create: googleKeepFixture,
  drivers: [
    'editNote',
    'checkItem',
    'trashNote',
    'restoreNote',
    'removeNote',
    'failNext',
    'reset',
    'snapshot',
  ],
};
