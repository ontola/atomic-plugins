// @wc-ignore-file
const connectionGrantErrors = {
  expired:
    'Connection grant expired; import a fresh grant with syncables import-connection-grant',
  invalid:
    'Stored connection grant is invalid; import a fresh grant with syncables import-connection-grant',
  keychain:
    'Could not read the connection grant from Keychain; check Keychain access and re-import the grant if needed',
};

export class ConnectionGrantAuthError extends Error {
  constructor(reason: keyof typeof connectionGrantErrors) {
    super(connectionGrantErrors[reason]);
  }
}

/** Classify access failures without reflecting token/provider diagnostics. */
export function isSyncAuthError(error: unknown): boolean {
  if (error instanceof ConnectionGrantAuthError) return true;
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
