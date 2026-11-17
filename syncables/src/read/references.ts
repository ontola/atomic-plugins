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
import { resolveBoundIdentity } from './identity-path.js';
import { isRecord } from './model.js';

const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

export interface ResolvedReference {
  /** The referenced resource (a `crudResources` key). */
  resource: string;
  /** Its identity path, filled in: e.g. `/workspaces/42/projects/p-9`. */
  path: string;
  /** The value of each variable of the target's `identity.urlTemplate`. */
  values: Record<string, string>;
}

/**
 * Resolves `reference` of `resource` for `object`, reached through a
 * request whose path variables are `context`. Returns undefined when the
 * reference is not `required` (`required: false`) and a bound field is
 * absent or `null`: it then identifies no object. Bound fields are read
 * before the context, so that holds whatever the template's variable
 * order. An empty string is a value, not an absence: it throws, required
 * or not. Throws when the declaration cannot be read (no such resource or
 * reference, a target without an `identity.urlTemplate` that is a path
 * starting with one `/`, a binding without a `field`), when a required
 * reference's field is absent, when a value is neither a string nor a
 * safe integer (`Number.isSafeInteger`), when an unbound variable is not
 * in `context`, or when a value, bound or from `context`, is empty, `.`,
 * `..`, padded with whitespace, contains NUL or a lone surrogate.
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
  return resolveBoundIdentity(
    targetName,
    template,
    own(declared, 'bindings'),
    object,
    context,
    where,
    own(declared, 'required') !== false,
  );
}
