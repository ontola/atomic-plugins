// @wc-ignore-file
/** Types for ./stack.mjs, shared by the opt-in real-server e2es. */
import type { Server } from 'node:https';

export interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One request the TLS proxy forwarded. */
export interface Traffic {
  at: string;
  /** The route's label (`mastodon`, `akkoma`), `atomic`, or `tls` for a failed handshake. */
  to: string;
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

export function docker(
  args: string[],
  options?: Record<string, unknown>,
): string;
export function issueCertificate(
  caPath: string,
  names: string[],
): { ca: Buffer; key: Buffer; cert: Buffer };
export function startProxy(options: {
  key: Buffer;
  cert: Buffer;
  port: number;
  atomicPort: number | string;
  routes: Record<
    string,
    { label: string; port: number; headers?: Record<string, string> }
  >;
  log: Traffic[];
}): Promise<Server>;
export function until(
  check: () => unknown,
  what: string,
  timeoutMs: number,
  explain?: () => string,
): Promise<void>;
export function request(
  ca: Buffer,
  port: number,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response>;
