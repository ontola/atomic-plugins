// @wc-ignore-file
/** Types for ./mastodon.mjs, the opt-in e2e's real Mastodon server. */
import type { Response, Traffic } from './stack.mjs';

export type { Response, Traffic } from './stack.mjs';
export { issueCertificate, request } from './stack.mjs';

export interface Mastodon {
  origin: string;
  domain: string;
  image: string;
  version: string;
  ca: Buffer;
  stop(): void;
  call(
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
  traffic(): Traffic[];
  logs(lines?: number): string;
  addUser(username: string): string;
}

export const DEFAULT_IMAGE: string;
export const MASTODON_HOST: string;
export function startMastodon(options: {
  atomicHost: string;
  atomicPort: number | string;
  caPath: string;
  port?: number;
  webPort?: number;
  dbPort?: number;
  redisPort?: number;
  image?: string;
  name?: string;
  timeoutMs?: number;
}): Promise<Mastodon>;
