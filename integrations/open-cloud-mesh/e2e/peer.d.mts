// @wc-ignore-file
/** Types for ./peer.mjs, the e2e's OCM peer fixture. */
import type { KeyObject } from 'node:crypto';

export interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface Received {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  verified?: { domain: string; keyId: string; discovery: unknown };
  refused?: string;
}

export interface PeerFile {
  body: string | Buffer;
  type: string;
  secret: string;
}

export interface Peer {
  origin: string;
  domain: string;
  received: Received[];
  keyId(): string;
  sendShare(
    url: string,
    share: unknown,
  ): Promise<{ status: number; body: string }>;
  sendNotification(
    url: string,
    notification: unknown,
  ): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

export const PEER_CA_PATH: string;
export function contentDigest(body: string | Buffer): string;
export function issueCertificate(caPath?: string): {
  ca: Buffer;
  key: Buffer;
  cert: Buffer;
};
export function signOcm(options: {
  privateKey: KeyObject;
  keyId: string;
  method: string;
  url: string;
  body: string;
  created: number;
}): Record<string, string>;
export function send(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response>;
export function fetchJson(url: string): Promise<any>;
export function discover(
  domain: string,
  fetch?: (url: string) => Promise<any>,
): Promise<any>;
export function startPeer(options?: {
  port?: number;
  files?: Record<string, PeerFile>;
  caPath?: string;
}): Promise<Peer>;
