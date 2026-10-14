// @wc-ignore-file
/**
 * The webhook inbox classes of #369 step 4b: a delivery (its raw payload,
 * stored before the receiver is told it may forget it), a work item (what
 * that delivery, or a gap, still asks of the sync), and a gap in history.
 *
 * Coordinator decision (2026-10-12, option A, reversible): these classes
 * stay in the GitHub issues pilot's folder. They are not GitHub-specific, so
 * they are expected to move to shared code (`ontology-kit/source.json`) once
 * the generic runner exists (docs/design/pieces.md D2/D5: generic
 * integrations straight from the catalog). Nothing in this file may name a
 * provider.
 *
 * Type-only import: plugin.ts bundles this file into the sandbox plugin.js,
 * so it must not pull the lib's runtime in. Every value is an exact string.
 */
import type { Datatype, SchemaSpec } from '../../../browser/lib/src/index.js';

const STRING = 'https://atomicdata.dev/datatypes/string' as Datatype;

export const DELIVERY_FIELDS = [
  ['webhook-delivery-id', 'Delivery id', "The provider's delivery id."],
  ['webhook-event-type', 'Event type', 'The event type the provider sent.'],
  ['webhook-action', 'Action', 'The action within the event type, if any.'],
  [
    'webhook-received-at',
    'Received at',
    'When the receiver accepted the delivery (RFC 3339).',
  ],
  ['webhook-source-kind', 'Source kind', 'The kind of source it is about.'],
  ['webhook-source-key', 'Source key', 'The key of that source.'],
  ['webhook-subscription', 'Subscription', 'The receiver subscription id.'],
  ['webhook-generation', 'Generation', 'The subscription generation.'],
  ['webhook-cursor', 'Cursor', "The receiver's cursor for this event."],
  ['webhook-media-type', 'Media type', "The payload's media type."],
  [
    'webhook-payload-bytes',
    'Payload bytes',
    'Size of the raw payload in bytes, as a decimal string.',
  ],
  [
    'webhook-payload-sha256',
    'Payload SHA-256',
    'SHA-256 of the raw payload, as the receiver reported it (hex).',
  ],
  [
    'webhook-payload',
    'Payload',
    'The raw payload, base64, exactly as the receiver handed it over.',
  ],
] as const;

export const WORK_FIELDS = [
  ['webhook-work-kind', 'Work kind', '`delivery` or `reconcile`.'],
  [
    'webhook-work-status',
    'Work status',
    '`pending` until the sync has done what it asks, then `done` or `failed`.',
  ],
  ['webhook-delivery', 'Delivery', 'The delivery row a `delivery` item is for.'],
  [
    'webhook-gap-key',
    'Gap key',
    'Identifies one gap: the subscription, generation, detection time and reason.',
  ],
] as const;

export const GAP_FIELDS = [
  ['webhook-gap-reason', 'Gap reason', "The receiver's reason for the gap."],
  ['webhook-detected-at', 'Detected at', 'When the receiver detected it.'],
  [
    'webhook-last-acknowledged',
    'Last acknowledged',
    'The last cursor acknowledged before the gap, if any.',
  ],
  [
    'webhook-earliest-available',
    'Earliest available',
    'The earliest cursor still available after it, if any.',
  ],
] as const;

export const CLASSES = {
  delivery: 'webhook-delivery',
  work: 'webhook-work-item',
  gap: 'webhook-gap',
} as const;

export function inboxSchema(): SchemaSpec {
  const all = [...DELIVERY_FIELDS, ...WORK_FIELDS, ...GAP_FIELDS];
  return {
    properties: all.map(([shortname, name, description]) => ({
      shortname,
      name,
      description,
      datatype: STRING,
    })),
    classes: [
      {
        shortname: CLASSES.delivery,
        name: 'Webhook delivery',
        description:
          'One event a webhook receiver handed over, with its raw payload. A hint that something changed, not state: the sync reads the API.',
        requires: [
          'webhook-delivery-id',
          'webhook-event-type',
          'webhook-subscription',
          'webhook-cursor',
          'webhook-payload',
        ],
        recommends: DELIVERY_FIELDS.map((f) => f[0]),
      },
      {
        shortname: CLASSES.work,
        name: 'Webhook work item',
        description:
          'What a delivery or a gap still asks of the sync: scoped reads, or a full reconciliation.',
        requires: ['webhook-work-kind', 'webhook-work-status'],
        recommends: WORK_FIELDS.map((f) => f[0]),
      },
      {
        shortname: CLASSES.gap,
        name: 'Webhook gap',
        description:
          'A stretch of history the receiver could not keep; only a full reconciliation restores state after it.',
        requires: ['webhook-gap-key', 'webhook-gap-reason'],
        recommends: [
          'webhook-subscription',
          'webhook-generation',
          ...GAP_FIELDS.map((f) => f[0]),
        ],
      },
    ],
  };
}
