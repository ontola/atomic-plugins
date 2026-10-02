// @wc-ignore-file
/** Types for ./akkoma.mjs, the opt-in e2e's real Akkoma server. */
import type { Response, Traffic } from './stack.mjs';

export interface Akkoma {
  origin: string;
  domain: string;
  image: string;
  /** The release zip's URL or path, and its SHA-256. */
  release: string;
  sha256: string;
  /** `/api/v1/instance` `version`. */
  version: string;
  /** NodeInfo 2.1 `software.version`. */
  software?: string;
  ca: Buffer;
  stop(): void;
  call(
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: unknown;
      form?: Record<string, string>;
      headers?: Record<string, string>;
    },
  ): Promise<Response>;
  traffic(): Traffic[];
  logs(lines?: number): string;
  addUser(username: string): Promise<string>;
}

export const DEFAULT_RELEASE: string;
export const DEFAULT_IMAGE: string;
export const AKKOMA_HOST: string;
export function startAkkoma(options: {
  atomicHost: string;
  atomicPort: number | string;
  caPath: string;
  port?: number;
  webPort?: number;
  dbPort?: number;
  release?: string;
  image?: string;
  name?: string;
  timeoutMs?: number;
}): Promise<Akkoma>;
