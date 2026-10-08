/**
 * What an inbox event says may have changed (Webhook Deliveries §4.6): the
 * resource and collection paths its event type names in the document's
 * `x-webhook-deliveries`, filled from the event's payload. A delivery is a
 * hint, not state: the caller reads these through the API.
 */
import type { InboxEvent } from './client.js';

export interface ScopedRead {
  kind: 'resource' | 'collection';
  resource: string;
  collection?: string;
  /** The path to read, relative to the document's server URL. */
  path: string;
}

type Json = unknown;

function pointer(expression: string): string[] | undefined {
  const prefix = '$request.body#';
  if (!expression.startsWith(prefix)) return undefined;
  const rest = expression.slice(prefix.length);
  if (rest === '') return [];
  if (!rest.startsWith('/')) return undefined;
  return rest
    .slice(1)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** A string, or a non-negative integer as text (Webhook Deliveries §3). */
function key(value: Json): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function select(body: Json, expression: string): string | undefined {
  const segments = pointer(expression);
  if (!segments) return undefined;
  let current: Json = body;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, Json>)[segment];
  }
  return key(current);
}

/** Fills `{name}` variables with values, each percent-encoded as one segment. */
function fill(
  template: string,
  values: Record<string, string>,
): string | undefined {
  let missing = false;
  const path = template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return encodeURIComponent(value);
  });
  return missing ? undefined : path;
}

interface Binding {
  resource: string;
  collection?: string;
  bindings?: Record<string, string>;
}

/** The reads `event` asks for, given the composed document. */
export function scopedReads(document: Json, event: InboxEvent): ScopedRead[] {
  const doc = document as {
    'x-webhook-deliveries'?: {
      events?: Record<
        string,
        { resources?: Binding[]; collections?: Binding[] }
      >;
    };
    components?: {
      crudResources?: Record<
        string,
        {
          identity?: { urlTemplate?: string };
          collections?: Record<string, { urlTemplate?: string }>;
        }
      >;
    };
  };
  const declared = doc['x-webhook-deliveries']?.events?.[event.eventType];
  const resources = doc.components?.crudResources;
  if (!declared || !resources) return [];
  let body: Json;
  try {
    body = JSON.parse(
      Buffer.from(event.payload.body, 'base64').toString('utf8'),
    );
  } catch {
    return [];
  }
  const values = (
    bindings: Record<string, string> = {},
  ): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const [name, expression] of Object.entries(bindings)) {
      const value = select(body, expression);
      if (value === undefined) return undefined;
      out[name] = value;
    }
    return out;
  };
  const reads: ScopedRead[] = [];
  for (const read of declared.resources ?? []) {
    const template = resources[read.resource]?.identity?.urlTemplate;
    const bound = values(read.bindings);
    const path = template && bound ? fill(template, bound) : undefined;
    if (path) reads.push({ kind: 'resource', resource: read.resource, path });
  }
  for (const read of declared.collections ?? []) {
    const template = read.collection
      ? resources[read.resource]?.collections?.[read.collection]?.urlTemplate
      : undefined;
    const bound = values(read.bindings);
    const path = template && bound ? fill(template, bound) : undefined;
    if (path) {
      reads.push({
        kind: 'collection',
        resource: read.resource,
        ...(read.collection ? { collection: read.collection } : {}),
        path,
      });
    }
  }
  return reads;
}
