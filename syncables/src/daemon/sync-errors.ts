// @wc-ignore-file
/** Classify access failures without reflecting token/provider diagnostics. */
export function isSyncAuthError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; message?: unknown };
  return (
    value.status === 401 ||
    value.status === 403 ||
    (typeof value.message === 'string' &&
      /login required|authorization needs attention|owner mismatch|connection is not approved|invalid stored token/i.test(
        value.message,
      ))
  );
}
