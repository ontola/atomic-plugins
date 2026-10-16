import type { Credentials } from './auth.js';

/** Node-only environment loading. Explicit fields win; undefined falls back. */
export function credentialsFromEnv(
  explicit: Credentials = {},
  prefix = 'SYNCABLES_',
): Credentials {
  const credentials: Credentials = {};
  const fields = {
    clientId: 'OAUTH_CLIENT_ID',
    clientSecret: 'OAUTH_CLIENT_SECRET',
    apiKey: 'API_KEY',
    accessToken: 'ACCESS_TOKEN',
  } as const;
  for (const field of Object.keys(fields) as (keyof Credentials)[]) {
    const value = explicit[field] ?? process.env[`${prefix}${fields[field]}`];
    if (value !== undefined) credentials[field] = value;
  }
  return credentials;
}
