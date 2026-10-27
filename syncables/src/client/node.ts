import type { OpenApiDocument } from '../openapi/types.js';
import {
  createApiClient as createClient,
  type ApiClient,
  type ApiClientOptions as CoreOptions,
} from './client.js';
import { credentialsFromEnv } from './credentials.js';

export interface ApiClientOptions extends CoreOptions {
  /** Defaults to SYNCABLES_. false disables environment loading. */
  credentialPrefix?: string | false;
}

/**
 * Node entry adds environment configuration; the browser entry uses the
 * same core directly. Credentials come from the environment only for an
 * `authenticate` adapter, the one thing that uses them: without one, a
 * `SYNCABLES_API_KEY` set for something else would otherwise make the
 * client refuse to start ("Credentials require an authenticate adapter").
 */
export function createApiClient(
  document: OpenApiDocument,
  options: ApiClientOptions = {},
): ApiClient {
  const { credentialPrefix, ...core } = options;
  return createClient(document, {
    ...core,
    credentials:
      credentialPrefix === false || !options.authenticate
        ? (options.credentials ?? {})
        : credentialsFromEnv(options.credentials, credentialPrefix),
  });
}
