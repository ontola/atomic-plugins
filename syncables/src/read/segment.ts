// @wc-ignore-file
/**
 * Why `value` cannot fill a path segment, or undefined when it can. Shared
 * by `resolveReference` and `createdIdentity`, so neither binds a value
 * the other refuses. `.` and `..` survive percent-encoding and would move
 * the path to another resource (`/projects/..` normalises to `/`); a value
 * padded with whitespace is not the identifier it looks like; NUL is
 * refused outright; and a lone surrogate cannot be percent-encoded.
 */
export function segmentProblem(value: string): string | undefined {
  if (value === '') return 'empty';
  if (value === '.' || value === '..') return 'a dot segment';
  if (value.trim() !== value) return 'padded with whitespace';
  if (value.includes('\0')) return 'contains NUL';
  try {
    encodeURIComponent(value);
  } catch {
    return 'not well-formed Unicode (a lone surrogate)';
  }
  return undefined;
}
