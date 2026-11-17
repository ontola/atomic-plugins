// @wc-ignore-file
/** Shared path safety and field binding for identities and identity references. */
import { bindPath } from './pages.js';
import { segmentProblem } from './segment.js';

export interface ResolvedIdentity {
  resource: string;
  path: string;
  values: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;

/** The longest value `show` writes, in UTF-16 code units, before `…`. */
const SHOWN = 200;

/**
 * A value for an error message. `JSON.stringify` throws on a bigint (and
 * on a cycle), which would replace the message with a bare `TypeError`.
 * A long value is cut at `SHOWN` characters.
 */
function show(value: unknown): string {
  let text: string | undefined;
  if (typeof value === 'bigint') text = `${String(value)}n`;
  else if (typeof value === 'number') text = String(value);
  else
    try {
      text = JSON.stringify(value);
    } catch {
      // a cycle or a nested bigint: named by its type below
    }
  if (text === undefined) {
    const type = typeof value;
    return `${type === 'object' || type === 'undefined' ? 'an' : 'a'} ${type}`;
  }
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text;
}

/** A dot-path's value in an object: own properties, names split on `.`. */
export function fieldValue(object: unknown, path: string): unknown {
  let current: unknown = object;
  for (const name of path.split('.'))
    current = isRecord(current) ? own(current, name) : undefined;
  return current;
}

/** Assert the same safe relative identity template used by references. */
export function validateIdentityTemplate(
  template: string,
  targetName: string,
  where: string,
): void {
  // A path only: an absolute URL, or a variable in the host, could send
  // the caller anywhere, and `//` would start a host. So would `/\`: the
  // WHATWG URL parser reads a backslash as a slash in a special scheme's
  // URL, so `/\evil.example/` resolves to that host. It also strips tab,
  // LF and CR anywhere, so `/\t/evil.example/` does too. No backslash, C0
  // control character, space or DEL at all.
  if (
    !template.startsWith('/') ||
    template.startsWith('//') ||
    [...template].some(
      (char) => char <= ' ' || char === '\u007f' || char === '\\',
    )
  )
    throw new Error(
      `${where}: ${targetName}'s identity.urlTemplate ${show(template)} is not a path starting with one /, without a backslash, control character or space`,
    );
}

/** Fill explicit bindings, carrying only unbound variables from request context. */
export function resolveBoundIdentity(
  targetName: string,
  template: string,
  bindings: unknown,
  object: Record<string, unknown>,
  context: Record<string, string>,
  where: string,
  required = true,
): ResolvedIdentity | undefined {
  validateIdentityTemplate(template, targetName, where);
  if (!isRecord(bindings)) throw new Error(`${where}.bindings is required`);
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map(
    ([, variable]) => variable as string,
  );

  // First pass: the bound fields. An optional reference with an absent or
  // null field identifies no object, whatever else is missing.
  const bound = new Map<string, { field: string; value: unknown }>();
  for (const name of names) {
    const binding = own(bindings, name);
    if (binding === undefined) continue;
    const field = isRecord(binding) ? own(binding, 'field') : undefined;
    if (typeof field !== 'string' || field === '')
      throw new Error(`${where}.bindings.${name}.field is required`);
    const value = fieldValue(object, field);
    if (value === undefined || value === null) {
      if (!required) return undefined;
      throw new Error(`${where}: the required field ${field} is absent`);
    }
    bound.set(name, { field, value });
  }

  // Second pass: every value, bound or from the context.
  const values: Record<string, string> = {};
  for (const name of names) {
    const entry = bound.get(name);
    if (entry === undefined) {
      const carried = own(context, name);
      if (typeof carried !== 'string' || carried === '')
        throw new Error(
          `${where}: {${name}} is not bound and not in the request context`,
        );
      const problem = segmentProblem(carried);
      if (problem !== undefined)
        throw new Error(
          `${where}: {${name}} from the request context is ${show(carried)}, ${problem}`,
        );
      values[name] = carried;
      continue;
    }
    const { field, value } = entry;
    if (typeof value === 'string') {
      const problem = segmentProblem(value);
      if (problem !== undefined)
        throw new Error(`${where}: ${field} is ${show(value)}, ${problem}`);
      values[name] = value;
    } else if (typeof value === 'number' && Number.isSafeInteger(value))
      values[name] = String(value);
    else if (typeof value === 'number' && Number.isInteger(value))
      throw new Error(
        `${where}: ${field} is ${String(value)}, not a safe integer: beyond 2^53 - 1 a number may not be the id it was`,
      );
    else
      throw new Error(
        `${where}: ${field} is ${show(value)}, not a string or an integer`,
      );
  }
  return { resource: targetName, path: bindPath(template, values), values };
}
