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

/** Node entry adds environment configuration; the browser entry uses the same core directly. */
export function createApiClient(
  document: OpenApiDocument,
  options: ApiClientOptions = {},
): ApiClient {
  return createClient(document, {
    ...options,
    credentials:
      options.credentialPrefix === false
        ? (options.credentials ?? {})
        : credentialsFromEnv(options.credentials, options.credentialPrefix),
  });
}
