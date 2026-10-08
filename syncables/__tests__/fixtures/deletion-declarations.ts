// @wc-ignore-file
/**
 * The deletion declarations of the draft Deletion Feeds (0.2.0-draft) and
 * Collection Completeness (0.2.0-draft) extensions, as their READMEs give
 * them (`openapi-extensions/spec/deletion-feeds/README.md`,
 * `openapi-extensions/spec/collection-completeness/README.md`), each
 * completed into a small OpenAPI document that syncables can run against a
 * fake transport. The `x-deletion-feed`, `x-read-tombstone` and
 * `x-completeness` objects, and the overlays, are copied from the specs;
 * the paths, schemas and servers around them are the minimum the examples
 * imply. Every provider is invented, as the specs say; nothing here is a
 * declaration for a real API.
 */
import type { OpenApiDocument, OverlayDocument } from '../../src/browser.js';
import type { OperationObject } from '../../src/openapi/types.js';

const ok = (description: string): OperationObject['responses'] => ({
  '200': { description },
});

/** An item path with GET, PUT and DELETE, so that updates can be held and deletes sent. */
const item = (name: string): Record<string, OperationObject> => ({
  get: { responses: { ...ok(`A ${name}`), '404': { description: 'Gone' } } },
  put: {
    requestBody: { content: { 'application/json': { schema: {} } } },
    responses: ok(`The updated ${name}`),
  },
  delete: { responses: { '204': { description: 'Deleted' } } },
});

/** A collection path with a list GET (`operationId`) and a POST create. */
const collection = (
  operationId: string,
  parameters: OperationObject['parameters'] = [],
): Record<string, OperationObject> => ({
  get: { operationId, parameters, responses: ok('The list') },
  post: {
    requestBody: { content: { 'application/json': { schema: {} } } },
    responses: { '201': { description: 'Created' } },
  },
});

const query = (name: string): NonNullable<OperationObject['parameters']> => [
  { name, in: 'query', schema: { type: 'string' } },
];

/**
 * Deletion Feeds §2: a change list whose feed is the collection's own list
 * operation, with a numeric cursor and tombstones at `deleted: true`. The
 * list body is `{ data: { transactions: [...], server_knowledge } }`.
 */
export const transactionsFeed: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Deletion Feeds §2', version: '1.0.0' },
  servers: [{ url: 'https://budgets.example/v1' }],
  paths: {
    '/budgets/{budgetId}/transactions': collection(
      'listTransactions',
      query('last_knowledge_of_server'),
    ),
    '/budgets/{budgetId}/transactions/{transactionId}': item('transaction'),
  },
  components: {
    crudResources: {
      transaction: {
        identity: {
          urlTemplate: '/budgets/{budgetId}/transactions/{transactionId}',
          bindings: { transactionId: { field: 'id' } },
        },
        collections: {
          transactions: {
            urlTemplate: '/budgets/{budgetId}/transactions',
            // The list's own envelope (CRUD Causality §4.2); the feed below
            // is the same operation, so the two declare the same path, as
            // CRUD Causality §5 says they should.
            envelope: { itemsField: 'data.transactions' },
            'x-deletion-feed': {
              operationId: 'listTransactions',
              envelope: { itemsField: 'data.transactions' },
              cursor: {
                parameter: 'last_knowledge_of_server',
                responseField: 'data.server_knowledge',
              },
              tombstone: { field: 'deleted', values: [true] },
            },
          },
        },
      },
    },
  },
};

/**
 * Deletion Feeds §7.1: an invented calendar whose event list takes a
 * `syncToken`, returns `nextSyncToken`, answers 410 for an expired token and
 * lists deleted events with `status: cancelled`; their own GET answers 404.
 * The feed is the list itself, so a list read's body is
 * `{ items, nextSyncToken }`.
 */
export const calendarChangeList: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Deletion Feeds §7.1', version: '1.0.0' },
  servers: [{ url: 'https://calendar.example/v3' }],
  paths: {
    '/calendars/{calendarId}/events': collection(
      'listEvents',
      query('syncToken'),
    ),
    '/calendars/{calendarId}/events/{eventId}': item('event'),
  },
  components: {
    crudResources: {
      event: {
        identity: {
          urlTemplate: '/calendars/{calendarId}/events/{eventId}',
          bindings: { eventId: { field: 'id' } },
        },
        collections: {
          events: {
            urlTemplate: '/calendars/{calendarId}/events',
            'x-deletion-feed': {
              operationId: 'listEvents',
              envelope: { itemsField: 'items' },
              cursor: {
                parameter: 'syncToken',
                responseField: 'nextSyncToken',
                expiredStatuses: [410],
              },
              tombstone: { field: 'status', values: ['cancelled'] },
            },
          },
        },
      },
    },
  },
};

/**
 * Deletion Feeds §7.2: an invented project tool whose
 * `GET /projects/{projectId}/events?sync=` returns
 * `{ data: [{ action, resource: { gid } }], sync }` and answers 412 with a
 * fresh `sync` for a missing or expired token. The collection is the
 * project's tasks; a task's own URL is `/tasks/{taskId}`.
 */
export const projectEventLog: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Deletion Feeds §7.2', version: '1.0.0' },
  servers: [{ url: 'https://projects.example/api' }],
  paths: {
    '/projects/{projectId}/tasks': collection('listProjectTasks'),
    '/projects/{projectId}/events': {
      get: {
        operationId: 'getProjectEvents',
        parameters: query('sync'),
        responses: {
          ...ok('Events since the token'),
          '412': { description: 'Token missing or expired; a fresh one' },
        },
      },
    },
    '/tasks/{taskId}': item('task'),
  },
  components: {
    crudResources: {
      task: {
        identity: {
          urlTemplate: '/tasks/{taskId}',
          bindings: { taskId: { field: 'gid' } },
        },
        collections: {
          projectTasks: {
            urlTemplate: '/projects/{projectId}/tasks',
            'x-deletion-feed': {
              operationId: 'getProjectEvents',
              envelope: { itemsField: 'data' },
              idField: 'resource.gid',
              cursor: {
                parameter: 'sync',
                responseField: 'sync',
                expiredStatuses: [412],
              },
              tombstone: { field: 'action', values: ['deleted'] },
            },
          },
        },
      },
    },
  },
};

/**
 * Deletion Feeds §7.3: an invented to-do API whose
 * `GET /deleted-tasks?since=<token>` returns `{ items: [{ id }], next }`,
 * every item a deleted task (no `tombstone`).
 */
export const deletedItemsEndpoint: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Deletion Feeds §7.3', version: '1.0.0' },
  servers: [{ url: 'https://todo.example/api' }],
  paths: {
    '/tasks': collection('listTasks'),
    '/tasks/{taskId}': item('task'),
    '/deleted-tasks': {
      get: {
        operationId: 'listDeletedTasks',
        parameters: query('since'),
        responses: ok('Deleted tasks since the token'),
      },
    },
  },
  components: {
    crudResources: {
      task: {
        identity: {
          urlTemplate: '/tasks/{taskId}',
          bindings: { taskId: { field: 'id' } },
        },
        collections: {
          tasks: {
            urlTemplate: '/tasks',
            'x-deletion-feed': {
              operationId: 'listDeletedTasks',
              envelope: { itemsField: 'items' },
              cursor: { parameter: 'since', responseField: 'next' },
            },
          },
        },
      },
    },
  },
};

/**
 * Deletion Feeds §7.4: an invented calendar whose event GET answers 200
 * with `{ id, status: "cancelled" }` for a deleted event, and whose list
 * leaves cancelled events out. No feed.
 */
export const readTombstoneCalendar: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Deletion Feeds §7.4', version: '1.0.0' },
  servers: [{ url: 'https://calendar.example/v3' }],
  paths: {
    '/calendars/{calendarId}/events': collection('listEvents'),
    '/calendars/{calendarId}/events/{eventId}': item('event'),
  },
  components: {
    crudResources: {
      event: {
        identity: {
          urlTemplate: '/calendars/{calendarId}/events/{eventId}',
          bindings: { eventId: { field: 'id' } },
        },
        'x-read-tombstone': { field: 'status', values: ['cancelled'] },
        collections: {
          events: { urlTemplate: '/calendars/{calendarId}/events' },
        },
      },
    },
  },
};

/** Collection Completeness §2, on the Collection Object. */
export const completePets: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Collection Completeness §2', version: '1.0.0' },
  servers: [{ url: 'https://pets.example/api' }],
  paths: {
    '/pets': collection('listPets'),
    '/pets/{petId}': item('pet'),
  },
  components: {
    crudResources: {
      pet: {
        identity: {
          urlTemplate: '/pets/{petId}',
          bindings: { petId: { field: 'id' } },
        },
        collections: {
          pets: {
            urlTemplate: '/pets',
            'x-completeness': { absent: 'deleted' },
          },
        },
      },
    },
  },
};

/** Collection Completeness §2, on the list operation of a document without `crudResources`. */
export const completePetsLegacy: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Collection Completeness §2 (operation)', version: '1.0.0' },
  servers: [{ url: 'https://pets.example/api' }],
  paths: {
    '/pets': {
      ...collection('listPets'),
      get: {
        ...collection('listPets').get,
        'x-completeness': { absent: 'deleted' },
      } as OperationObject,
    },
    '/pets/{petId}': item('pet'),
  },
};

/**
 * Collection Completeness §6: a to-do API whose
 * `GET /projects/{projectId}/tasks` returns every task of a project, where a
 * task's own URL is `/tasks/{taskId}` and a task only leaves the list by
 * being deleted.
 */
export const completeProjectTasks: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Collection Completeness §6', version: '1.0.0' },
  servers: [{ url: 'https://todo.example/api' }],
  paths: {
    '/projects/{projectId}/tasks': collection('listProjectTasks'),
    '/tasks/{taskId}': item('task'),
  },
  components: {
    crudResources: {
      task: {
        identity: {
          urlTemplate: '/tasks/{taskId}',
          bindings: { taskId: { field: 'id' } },
        },
        collections: {
          projectTasks: {
            urlTemplate: '/projects/{projectId}/tasks',
            'x-completeness': { absent: 'deleted' },
          },
        },
      },
    },
  },
};

/**
 * Collection Completeness §6.1 (0.2.0): task lists at `/users/me/lists` and
 * a list's tasks at `/lists/{listId}/tasks`, shaped like Google Tasks. A
 * task can move between lists; a task read by id answers 200 with
 * `deleted: true` for a while after its deletion, and 404 later or when the
 * caller cannot reach it. Both collections declare `absent: removed` and
 * `notFound: unavailable`; the tasks declare `parentAbsent: unavailable`.
 * The spec's `examples/nested-tasks.yaml`, with PUT on a task.
 */
export const nestedTaskLists: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Collection Completeness §6.1', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/users/me/lists': {
      get: {
        'x-crud': {
          action: 'list',
          resource: 'taskList',
          collection: 'taskLists',
        },
        responses: ok("The user's task lists."),
      } as OperationObject,
    },
    '/users/me/lists/{listId}': {
      get: {
        parameters: [
          {
            name: 'listId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        'x-crud': { action: 'read', resource: 'taskList' },
        responses: {
          ...ok('One task list.'),
          '404': { description: 'Not found, or not readable by this caller.' },
        },
      } as OperationObject,
    },
    '/lists/{listId}/tasks': {
      get: {
        parameters: [
          {
            name: 'listId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        'x-crud': { action: 'list', resource: 'task', collection: 'listTasks' },
        responses: ok("The list's tasks."),
      } as OperationObject,
    },
    '/lists/{listId}/tasks/{taskId}': {
      get: {
        parameters: [
          {
            name: 'listId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'taskId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        'x-crud': { action: 'read', resource: 'task' },
        responses: {
          ...ok('The task, possibly with deleted true.'),
          '404': { description: 'Not found, or not readable by this caller.' },
        },
      } as OperationObject,
      put: {
        requestBody: { content: { 'application/json': { schema: {} } } },
        responses: ok('The updated task'),
      },
    },
  },
  components: {
    crudResources: {
      taskList: {
        identity: {
          urlTemplate: '/users/me/lists/{listId}',
          bindings: { listId: { field: 'id' } },
        },
        collections: {
          taskLists: {
            urlTemplate: '/users/me/lists',
            'x-completeness': { absent: 'removed', notFound: 'unavailable' },
          },
        },
      },
      task: {
        identity: {
          urlTemplate: '/lists/{listId}/tasks/{taskId}',
          bindings: { taskId: { field: 'id' } },
        },
        'x-read-tombstone': { field: 'deleted', values: [true] },
        collections: {
          listTasks: {
            urlTemplate: '/lists/{listId}/tasks',
            'x-completeness': {
              absent: 'removed',
              notFound: 'unavailable',
              parentAbsent: 'unavailable',
            },
          },
        },
      },
    },
  },
};

/**
 * Collection Completeness §6, second paragraph: an issue tracker whose list
 * returns open issues by default; a collection with the fixed query
 * `state=all` can declare completeness, while the same declaration on the
 * list operation does not apply to that collection (§4.1).
 */
export function issuesDocument(options: {
  /** Where `x-completeness` is declared. */
  on: 'collection' | 'operation';
  absent: 'deleted' | 'removed';
}): OpenApiDocument {
  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 'Collection Completeness §6 (issues)', version: '1.0.0' },
    servers: [{ url: 'https://tracker.example/api' }],
    paths: {
      '/projects/{projectId}/issues': collection('listIssues', query('state')),
      '/projects/{projectId}/issues/{issueId}': item('issue'),
    },
    components: {
      crudResources: {
        issue: {
          identity: {
            urlTemplate: '/projects/{projectId}/issues/{issueId}',
            bindings: { issueId: { field: 'id' } },
          },
          collections: {
            allIssues: {
              urlTemplate: '/projects/{projectId}/issues',
              'x-list-query': { state: 'all' },
              ...(options.on === 'collection'
                ? { 'x-completeness': { absent: options.absent } }
                : {}),
            },
          },
        },
      },
    },
  };
  if (options.on === 'operation')
    doc.paths['/projects/{projectId}/issues']!.get!['x-completeness'] = {
      absent: options.absent,
    };
  return doc;
}

/** Deletion Feeds §6, first overlay, for `transactionsFeed` without its declaration. */
export const transactionsFeedOverlay: OverlayDocument = {
  overlay: '1.0.0',
  info: {
    title: 'Declare the deletion feed of the transactions collection',
    version: '1.0.0',
  },
  actions: [
    {
      target: '$.components.crudResources.transaction.collections.transactions',
      update: {
        'x-deletion-feed': {
          operationId: 'listTransactions',
          envelope: { itemsField: 'data.transactions' },
          cursor: {
            parameter: 'last_knowledge_of_server',
            responseField: 'data.server_knowledge',
          },
          tombstone: { field: 'deleted', values: [true] },
        },
      },
    },
  ],
};

/** Deletion Feeds §6, second overlay, for `readTombstoneCalendar` without its declaration. */
export const readTombstoneOverlay: OverlayDocument = {
  overlay: '1.0.0',
  info: { title: 'Declare the event read tombstone', version: '1.0.0' },
  actions: [
    {
      target: '$.components.crudResources.event',
      update: {
        'x-read-tombstone': { field: 'status', values: ['cancelled'] },
      },
    },
  ],
};

/** Collection Completeness §5, for `completePets` without its declaration. */
export const completePetsOverlay: OverlayDocument = {
  overlay: '1.0.0',
  info: { title: 'Declare the pets collection complete', version: '1.0.0' },
  actions: [
    {
      target: '$.components.crudResources.pet.collections.pets',
      update: { 'x-completeness': { absent: 'deleted' } },
    },
  ],
};

/** `document` with the extension field `name` removed wherever it is declared. */
export function withoutDeclaration(
  document: OpenApiDocument,
  name: 'x-deletion-feed' | 'x-read-tombstone' | 'x-completeness',
): OpenApiDocument {
  const copy = structuredClone(document);
  const strip = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(strip);
    else if (node && typeof node === 'object') {
      delete (node as Record<string, unknown>)[name];
      Object.values(node).forEach(strip);
    }
  };
  strip(copy);
  return copy;
}
