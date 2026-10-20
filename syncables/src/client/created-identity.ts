// @wc-ignore-file
import type { OpenApiDocument } from '../openapi/types.js';
import { readNestedField } from '../pagination/response-parser.js';
import { isRecord } from '../read/model.js';
import { segmentProblem } from '../read/segment.js';
import { withoutOmitted, type FollowUp } from './compound-create.js';

/**
 * CRUD Causality create results (§4.3.2 Url Source Object, §4.4–4.5 Added
 * Field Objects) for one resource's declared `create` operation: where the
 * created object's identity comes from, and which fields the server
 * generates.
 */
export interface CreateDeclaration {
  /** `x-crud.url.source`; absent: the response body's bound fields. */
  source?: 'header' | 'bodyField' | 'template';
  /** The header name (`header`, default `location`) or body dot-path (`bodyField`). */
  name?: string;
  /** The resource's `identity.urlTemplate`. */
  template: string;
  /** Template variable → the object field it binds (`identity.bindings`). */
  bindings: Record<string, string>;
  /** `addedFields` whose `source` is `generated`: never sent in the create body. */
  generated: string[];
  /** `followUps` (CRUD Causality 0.5.0 §4.7): a compound create. */
  followUps?: FollowUp[];
}

/** The create declaration of `resource` from an operation's `x-crud`, if usable. */
export function createDeclaration(
  document: OpenApiDocument,
  crud: Record<string, unknown>,
): CreateDeclaration | undefined {
  const resources = document.components?.['crudResources'];
  const resource = isRecord(resources)
    ? resources[String(crud['resource'])]
    : undefined;
  const identity = isRecord(resource) ? resource['identity'] : undefined;
  const template = isRecord(identity) ? identity['urlTemplate'] : undefined;
  const rawBindings = isRecord(identity) ? identity['bindings'] : undefined;
  if (typeof template !== 'string' || !isRecord(rawBindings)) return undefined;
  const bindings: Record<string, string> = {};
  for (const [variable, binding] of Object.entries(rawBindings))
    if (isRecord(binding) && typeof binding['field'] === 'string')
      bindings[variable] = binding['field'];
  if (!Object.keys(bindings).length) return undefined;
  const url = crud['url'];
  const source = isRecord(url) ? url['source'] : undefined;
  const name = isRecord(url) ? url['name'] : undefined;
  const added = crud['addedFields'];
  const generated = isRecord(added)
    ? Object.entries(added)
        .filter(
          ([, field]) => isRecord(field) && field['source'] === 'generated',
        )
        .map(([field]) => field)
    : [];
  return {
    ...(source === 'header' || source === 'bodyField' || source === 'template'
      ? { source }
      : {}),
    ...(typeof name === 'string' && name ? { name } : {}),
    template,
    bindings,
    generated,
  };
}

/** The create body without the fields the server generates. */
export function createBody(
  declaration: CreateDeclaration | undefined,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const sent = withoutOmitted(declaration?.followUps, data);
  if (!declaration?.generated.length) return sent;
  const body = { ...sent };
  for (const field of declaration.generated) delete body[field];
  return body;
}

/**
 * Whether `value` can be a record's identity: a string `segmentProblem`
 * accepts (nonempty, not `.` or `..`, not padded with whitespace, no NUL,
 * no lone surrogate), or a safe integer. `.` and `..` would move the
 * record's path (`/pets/..` normalises to `/`), a lone surrogate makes
 * every later path to the record throw `URIError`, and an object, a
 * boolean or a fraction would become a record id such as
 * `[object Object]`. A numeric string past 2^53 is kept, as a string.
 */
function identityValue(value: unknown): boolean {
  if (typeof value === 'string') return segmentProblem(value) === undefined;
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * §4.3.2, after the reference `created_identity()` (CRUD Causality 0.5.0
 * `validate.py`): the identity fields of a created object, or undefined when
 * they cannot be determined (the object is then unbound). With `header` or
 * `bodyField`, the URL found there is matched against the identity
 * template, anywhere in it and ending at its end, `?` or `#`; the values
 * read back are decoded strings. Otherwise each bound field is read from the
 * response body, and one that is absent or null leaves it undetermined.
 * So does a value that cannot be an identity (`identityValue`): a dot
 * segment, an empty string, an object, a boolean or a fraction, and a
 * URL value that does not percent-decode.
 */
export function createdIdentity(
  declaration: CreateDeclaration,
  created: unknown,
  headers: Record<string, string>,
): Record<string, unknown> | undefined {
  const body = isRecord(created) ? created : {};
  if (declaration.source === 'header' || declaration.source === 'bodyField') {
    const url =
      declaration.source === 'header'
        ? headers[(declaration.name ?? 'location').toLowerCase()]
        : readNestedField(body, declaration.name ?? '');
    if (typeof url !== 'string') return undefined;
    const variables: string[] = [];
    const pattern = declaration.template
      .split(/(\{[^{}]+\})/)
      .map((part) => {
        if (!part.startsWith('{')) return escape(part);
        variables.push(part.slice(1, -1));
        return '([^/?#]+)';
      })
      .join('');
    const match = new RegExp(`${pattern}(?:[?#]|$)`).exec(url);
    if (!match) return undefined;
    const values: Record<string, unknown> = {};
    for (const [variable, field] of Object.entries(declaration.bindings)) {
      const at = variables.indexOf(variable);
      const raw = at < 0 ? undefined : match[at + 1];
      if (raw === undefined) return undefined;
      let value: string;
      try {
        value = decodeURIComponent(raw);
      } catch {
        return undefined;
      }
      if (!identityValue(value)) return undefined;
      values[field] = value;
    }
    return values;
  }
  const values: Record<string, unknown> = {};
  for (const field of Object.values(declaration.bindings)) {
    const value = readNestedField(body, field);
    if (!identityValue(value)) return undefined;
    values[field] = value;
  }
  return values;
}
