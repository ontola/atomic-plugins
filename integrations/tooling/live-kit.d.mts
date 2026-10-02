export const CONFIRM_FLAG: string;
export const REPO_ROOT: string;
export class GuardError extends Error {}
export class BudgetError extends GuardError {}
export function parseArgs(
  argv: string[],
  options?: { booleans?: string[] },
): { positional: string[]; flags: Record<string, string | boolean> };
export function confirmedTarget(
  flags: Record<string, string | boolean>,
  what: string,
): string;
export function looksDisposable(name: unknown): boolean;
export function requireDisposableName(what: string, name: unknown): void;
export function promptHidden(question: string): Promise<string>;
export function readSecret(
  name: string,
  options?: {
    env?: Record<string, string | undefined>;
    isTTY?: boolean;
    prompt?: (question: string) => Promise<string>;
    label?: string;
  },
): Promise<string>;
export interface Redactor {
  (input: unknown): string;
  deep<T>(value: T): T;
}
export function createRedactor(
  secrets?: Record<string, string>,
  options?: { keep?: string[] },
): Redactor;
export function createLogger(
  redact: Redactor,
  write?: (line: string) => unknown,
): (...parts: unknown[]) => unknown;
export interface Budget {
  readonly maxMutations: number;
  readonly maxMs: number;
  readonly mutations: number;
  spend(method: string): void;
  extendForCleanup(records: number): void;
}
export function createBudget(options?: {
  maxMutations?: number;
  maxMs?: number;
  now?: () => number;
}): Budget;
export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export interface ProviderRequest {
  who: 'app' | 'driver';
  method?: string;
  path: string;
  query?: Record<string, string>;
  body?: string;
  ifMatch?: string;
  headers?: Record<string, string>;
}
export interface RequestRecord {
  n: number;
  who: string;
  method: string;
  path: string;
  ifMatch: boolean;
  /** Set when the scenario's `isRead` called this POST a read. */
  read?: true;
  bodyKeys?: string[];
  at: string;
  status?: number | 'network-error';
  ms?: number;
  error?: string;
}
export interface Provider {
  request(request: ProviderRequest): Promise<ProviderResponse>;
  requests: RequestRecord[];
}
export function createProvider(options: {
  baseUrl: string;
  authHeaders: () => Record<string, string>;
  allow: (request: {
    who: string;
    method: string;
    pathname: string;
    query: Record<string, string>;
  }) => void;
  /** For a provider whose reads are POSTs: counted as reads by the budget. */
  isRead?: (request: { method: string; pathname: string }) => boolean;
  budget: Budget;
  redact: Redactor;
  fetcher?: (
    url: string,
    init: Record<string, unknown>,
  ) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
  timeoutMs?: number;
  now?: () => number;
}): Provider;
export function relayStandIn(
  provider: Provider,
  platform: string,
): {
  request(req: {
    platform: string;
    connectionId: string;
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    query?: Record<string, string>;
    body?: string;
    ifMatch?: string;
  }): Promise<ProviderResponse>;
  connections(args: {
    platform: string;
  }): Promise<Array<{ connectionId: string; platform: string }>>;
  connect(): Promise<never>;
};
export function stamp(date: Date): string;
export function runId(): string;
export interface Candidate {
  app: string;
  appVersion: string;
  sourceCommit?: string;
  sourceDirty?: boolean;
  bundlePath: string;
  bundleSha256?: string;
  ranAgainst: string;
}
export function describeCandidate(
  app: string,
  options?: {
    appId?: string;
    root?: string;
    /** Repository-relative; default `integrations/<app>/app/package.json`. */
    packageFile?: string;
    /** Repository-relative; default `integrations/<app>`. */
    folder?: string;
  },
): Candidate;
export interface StepContext {
  check(name: string, ok: unknown, detail?: unknown): boolean;
  equal(name: string, actual: unknown, expected: unknown): boolean;
  /** Records what the provider did where nothing was asserted beforehand. */
  observe(name: string, value: unknown): void;
  note(text: string): void;
}
export interface EvidenceDocument {
  schemaVersion: 1;
  kind: 'live-check';
  status: 'passed' | 'failed' | 'preflight-only';
  app: string;
  provider: string;
  apiVersion: string;
  candidate: Candidate;
  target: { kind: string; id: string; name?: string };
  runPrefix: string;
  startedAt: string;
  endedAt: string;
  limits: { maxMutations: number; maxMs: number; mutations: number };
  steps: Array<{
    id: string;
    title: string;
    status: string;
    assertions: Array<{ name: string; ok: boolean; detail?: unknown }>;
    note?: string;
    error?: string;
    observations?: Array<{ name: string; value: unknown }>;
  }>;
  cleanup: { status: string; note?: string } & Record<string, unknown>;
  notCovered: string[];
  requests: RequestRecord[];
  note: string;
}
export function createRecorder(options: {
  app: string;
  provider: string;
  apiVersion: string;
  candidate: Candidate;
  target: { kind: string; id: string; name?: string };
  redact: Redactor;
  log?: (...parts: unknown[]) => unknown;
  now?: () => Date;
  limits: Budget;
}): {
  prefix: string;
  steps: EvidenceDocument['steps'];
  step(
    id: string,
    title: string,
    fn: (context: StepContext) => Promise<void>,
    options?: { continueOnFailure?: boolean },
  ): Promise<void>;
  document(options: {
    cleanup: EvidenceDocument['cleanup'];
    notCovered: string[];
    preflightOnly?: boolean;
    requests?: RequestRecord[];
  }): EvidenceDocument;
};
export function renderMarkdown(doc: EvidenceDocument): string;
export function writeEvidence(
  doc: EvidenceDocument,
  outDir: string,
  redact: Redactor,
): { json: string; markdown: string };
export function defaultEvidenceDir(app: string): string;
export function liveSettings(env?: Record<string, string | undefined>): {
  target: string;
  outDir: string | undefined;
  maxMutations: number | undefined;
  maxMs: number | undefined;
  preflightOnly: boolean;
};
