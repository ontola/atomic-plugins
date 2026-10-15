// @wc-ignore-file
/**
 * CRUD Causality §4.1.3 Reference Objects: an object of one resource
 * identifies an object of another by carrying its identifying values (a
 * foreign key). `resolveReference` fills the target resource's
 * `identity.urlTemplate` from the referring object's fields, as the spec's
 * §7.6 example does, and from the request context for a variable the
 * reference does not bind (a shared parent such as `{workspaceId}`).
 *
 * A reference asserts identity only: the path it gives need not exist, be
 * readable with the same credentials, or be an operation the document
 * declares. Nothing is fetched.
 */
import type { OpenApiDocument } from '../openapi/types.js';
import { bindPath } from './pages.js';

export interface ResolvedReference {
  /** The referenced resource (a `crudResources` key). */
  resource: string;
  /** Its identity path, filled in: e.g. `/workspaces/42/projects/p-9`. */
  path: string;
  /** The value of each variable of the target's `identity.urlTemplate`. */
  values: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

/** A dot-path's value in an object: own properties, names split on `.`. */
function fieldValue(object: unknown, path: string): unknown {
  let current: unknown = object;
  for (const name of path.split('.'))
    current = isRecord(current) ? own(current, name) : undefined;
  return current;
}

/**
 * Why `value` cannot fill a path segment, or undefined when it can. `.`
 * and `..` survive percent-encoding and would move the path to another
 * resource (`/projects/..` normalises to `/`), and a value padded with
 * whitespace is not the identifier it looks like.
 */
function segmentProblem(value: string): string | undefined {
  if (value === '') return 'empty';
  if (value === '.' || value === '..') return 'a dot segment';
  if (value.trim() !== value) return 'padded with whitespace';
  return undefined;
}

/**
 * Resolves `reference` of `resource` for `object`, reached through a
 * request whose path variables are `context`. Returns undefined when the
 * reference is not `required` (`required: false`) and a bound field is
 * absent or `null`: it then identifies no object. Throws when the
 * declaration cannot be read (no such resource or reference, a target
 * without an `identity.urlTemplate`, a binding without a `field`), when a
 * required reference's field is absent, when a value is neither a string
 * nor an integer, when an unbound variable is not in `context`, or when a
 * value, bound or from `context`, is `.`, `..` or padded with whitespace.
 */
export function resolveReference(
  document: OpenApiDocument,
  resource: string,
  reference: string,
  object: Record<string, unknown>,
  context: Record<string, string> = {},
): ResolvedReference | undefined {
  const resources = (
    document.components as Record<string, unknown> | undefined
  )?.['crudResources'];
  const where = `crudResources.${resource}.references.${reference}`;
  const source = isRecord(resources) ? own(resources, resource) : undefined;
  if (!isRecord(source))
    throw new Error(`${resource} is not a crudResources key`);
  const references = own(source, 'references');
  const declared = isRecord(references)
    ? own(references, reference)
    : undefined;
  if (!isRecord(declared)) throw new Error(`${where} is not declared`);
  const targetName = own(declared, 'resource');
  const target =
    typeof targetName === 'string' && isRecord(resources)
      ? own(resources, targetName)
      : undefined;
  const identity = isRecord(target) ? own(target, 'identity') : undefined;
  const template = isRecord(identity)
    ? own(identity, 'urlTemplate')
    : undefined;
  if (typeof targetName !== 'string' || typeof template !== 'string')
    throw new Error(
      `${where}.resource names no resource with an identity.urlTemplate`,
    );
  const bindings = own(declared, 'bindings');
  if (!isRecord(bindings)) throw new Error(`${where}.bindings is required`);
  const required = own(declared, 'required') !== false;
  const values: Record<string, string> = {};
  for (const [, variable] of template.matchAll(/\{([^}]+)\}/g)) {
    const name = variable as string;
    const binding = own(bindings, name);
    if (binding === undefined) {
      const carried = own(context, name);
      if (typeof carried !== 'string' || carried === '')
        throw new Error(
          `${where}: {${name}} is not bound and not in the request context`,
        );
      const problem = segmentProblem(carried);
      if (problem !== undefined)
        throw new Error(
          `${where}: {${name}} from the request context is ${JSON.stringify(carried)}, ${problem}`,
        );
      values[name] = carried;
      continue;
    }
    const field = isRecord(binding) ? own(binding, 'field') : undefined;
    if (typeof field !== 'string' || field === '')
      throw new Error(`${where}.bindings.${name}.field is required`);
    const value = fieldValue(object, field);
    if (value === undefined || value === null) {
      if (!required) return undefined;
      throw new Error(`${where}: the required field ${field} is absent`);
    }
    if (typeof value === 'string' && value !== '') {
      const problem = segmentProblem(value);
      if (problem !== undefined)
        throw new Error(
          `${where}: ${field} is ${JSON.stringify(value)}, ${problem}`,
        );
      values[name] = value;
    } else if (typeof value === 'number' && Number.isInteger(value))
      values[name] = String(value);
    else
      throw new Error(
        `${where}: ${field} is ${JSON.stringify(value)}, not a string or an integer`,
      );
  }
  return { resource: targetName, path: bindPath(template, values), values };
}
