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

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * A payload's base64 body as UTF-8 text, with no `Buffer`, `atob` or
 * `TextDecoder`: none of them is certain in atomic-server's QuickJS
 * sandbox. `undefined` for anything that is not padded standard base64 of
 * well-formed UTF-8 (a payload that is not JSON text asks for no reads).
 */
export function decodeBase64Utf8(base64: string): string | undefined {
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    return undefined;
  }
  const bytes: number[] = [];
  for (let i = 0; i < base64.length; i += 4) {
    const quad = base64.slice(i, i + 4);
    const n = [...quad].map((c) => (c === '=' ? 0 : BASE64.indexOf(c)));
    const value = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!;
    bytes.push((value >> 16) & 0xff);
    if (quad[2] !== '=') bytes.push((value >> 8) & 0xff);
    if (quad[3] !== '=') bytes.push(value & 0xff);
  }
  let text = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!;
    const length = b0 < 0x80 ? 1 : b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : 2;
    if (b0 >= 0x80 && b0 < 0xc2) return undefined;
    if (b0 > 0xf4 || i + length > bytes.length) return undefined;
    let code = length === 1 ? b0 : b0 & (0xff >> (length + 1));
    for (let k = 1; k < length; k++) {
      const b = bytes[i + k]!;
      if ((b & 0xc0) !== 0x80) return undefined;
      code = (code << 6) | (b & 0x3f);
    }
    const min = [0, 0, 0x80, 0x800, 0x10000][length]!;
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return undefined;
    }
    text += String.fromCodePoint(code);
    i += length;
  }
  return text;
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

/**
 * One path segment (Webhook Deliveries §4.4.1, RFC 3986 §3.3): every
 * character outside `unreserved` (`A-Z a-z 0-9 - . _ ~`) percent-encoded,
 * `!'()*` included, which `encodeURIComponent` leaves alone. `.` and `..`
 * are refused: encoded or not, they would reach another path.
 */
export function pathSegment(value: string): string | undefined {
  if (value === '.' || value === '..') return undefined;
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Fills `{name}` variables with values, each encoded as one segment. */
function fill(
  template: string,
  values: Record<string, string>,
): string | undefined {
  let refused = false;
  const path = template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const value = values[name];
    const segment = value === undefined ? undefined : pathSegment(value);
    if (segment === undefined) {
      refused = true;
      return '';
    }
    return segment;
  });
  return refused ? undefined : path;
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
    const text = decodeBase64Utf8(event.payload.body);
    if (text === undefined) return [];
    body = JSON.parse(text);
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
