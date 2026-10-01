// @wc-ignore-file
/** Types for ./nextcloud.mjs, the opt-in e2e's Nextcloud in Docker. */

export interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Nextcloud {
  origin: string;
  domain: string;
  name: string;
  version: string;
  image: string;
  ca: Buffer;
  occ(...args: string[]): string;
  stop(): void;
  addUser(user: string, displayName: string): string;
  upload(
    user: string,
    password: string,
    path: string,
    body: string,
  ): Promise<Answer>;
  ocs(
    user: string,
    password: string,
    method: string,
    path: string,
    form?: Record<string, string>,
  ): Promise<Answer>;
  log(lines?: number): string;
}

export const DEFAULT_IMAGE: string;
export function startNextcloud(options?: {
  port?: number;
  image?: string;
  name?: string;
  timeoutMs?: number;
}): Promise<Nextcloud>;
export function request(
  ca: Buffer,
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Answer>;
