// @wc-ignore-file
/** Types for ./mastodon.mjs, the opt-in e2e's real Mastodon server. */

export interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One request the TLS proxy forwarded. */
export interface Traffic {
  at: string;
  to: 'mastodon' | 'atomic';
  method: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  status: number;
  responseType?: string;
  response?: string;
  error?: string;
}

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
export function issueCertificate(
  caPath: string,
  names: string[],
): { ca: Buffer; key: Buffer; cert: Buffer };
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
export function request(
  ca: Buffer,
  port: number,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response>;
