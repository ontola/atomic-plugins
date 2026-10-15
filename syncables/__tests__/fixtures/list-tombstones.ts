// @wc-ignore-file
/**
 * Deletion Feeds 0.3.0-draft §7.5 (`openapi-extensions/spec/deletion-feeds/examples/list-tombstones.yaml`),
 * transcribed: an event list read with showDeleted=true whose cancelled
 * events are list tombstones, except cancelled exceptions of a recurring
 * event (recurringEventId present). Synthetic, shaped like Google
 * Calendar; not a declaration for it.
 */
import type { OpenApiDocument } from '../../src/browser.js';

export const listTombstones = {
  openapi: '3.0.3',
  info: {
    title: 'Illustrative list tombstones',
    version: '1.0.0',
    description:
      "Synthetic, shaped like Google Calendar's event list with showDeleted=true (Deletion Feeds §7.5): deleted events come back with status cancelled among the others, and a cancelled exception of a recurring event (an item with recurringEventId) is one occurrence not to present, which clients store. Not a declaration for Google Calendar.",
  },
  servers: [
    {
      url: 'https://api.example.com',
    },
  ],
  paths: {
    '/calendars/{calendarId}/events': {
      get: {
        operationId: 'listEvents',
        parameters: [
          {
            name: 'calendarId',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
            },
          },
          {
            name: 'showDeleted',
            in: 'query',
            schema: {
              type: 'boolean',
            },
          },
        ],
        responses: {
          '200': {
            description:
              'Events, deleted ones included when showDeleted is true.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        $ref: '#/components/schemas/Event',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/calendars/{calendarId}/events/{eventId}': {
      get: {
        operationId: 'getEvent',
        parameters: [
          {
            name: 'calendarId',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
            },
          },
          {
            name: 'eventId',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
            },
          },
        ],
        responses: {
          '200': {
            description: 'The event.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Event',
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Event: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
          },
          status: {
            type: 'string',
            enum: ['confirmed', 'tentative', 'cancelled'],
          },
          recurringEventId: {
            type: 'string',
          },
          summary: {
            type: 'string',
          },
        },
      },
    },
    crudResources: {
      event: {
        identity: {
          urlTemplate: '/calendars/{calendarId}/events/{eventId}',
          bindings: {
            eventId: {
              field: 'id',
            },
          },
        },
        collections: {
          eventsWithDeleted: {
            urlTemplate: '/calendars/{calendarId}/events',
            listQuery: {
              showDeleted: 'true',
            },
            envelope: {
              itemsField: 'items',
            },
            'x-list-tombstone': {
              field: 'status',
              values: ['cancelled'],
              except: [
                {
                  field: 'recurringEventId',
                  present: true,
                },
              ],
              description:
                'A cancelled event is deleted; a cancelled exception of a recurring event is an occurrence not to present, kept as a member.',
            },
          },
        },
      },
    },
  },
} as unknown as OpenApiDocument;
