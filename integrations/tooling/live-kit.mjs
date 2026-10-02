/**
 * The live-check kit's shared parts (integrations/LIVE_TESTING.md, "The
 * live-check kit"): argument and guard-rail handling, credential intake,
 * redaction, a bounded provider client, and the evidence recorder. Each
 * app's scenario (`integrations/<app>/live/`) is built on these. Nothing
 * here knows about one provider.
 *
 * Guard rails, all enforced in code and unit-tested offline
 * (`live-kit.test.mjs`):
 *
 * - A run needs `--i-understand-this-writes-to <id>`, naming the one
 *   disposable calendar, workspace, repository or database it may write to.
 *   The scenario then checks that id's name looks disposable and that the
 *   resource is empty, and its `allow` hook refuses any request that
 *   addresses another resource.
 * - Credentials come from an environment variable, or from a hidden prompt
 *   on a terminal. They are never read from a file, never written to disk
 *   and never logged: every line the kit prints, and every byte of
 *   evidence, goes through `createRedactor`.
 * - A run stops after `maxMutations` provider writes or `maxMs`
 *   milliseconds, whichever comes first. A timeout is a failure.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const CONFIRM_FLAG = '--i-understand-this-writes-to';
export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/** A guard rail refused the run, or a request. The message says which and why. */
export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

/** The mutation or time budget is used up. A failure, never a skip. */
export class BudgetError extends GuardError {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

/* ---------------------------------------------------------------- args */

/**
 * `--key value`, `--key=value` and bare `--flag`. A name in `booleans` never
 * takes a value. Positionals are returned in order.
 */
export function parseArgs(argv, { booleans = [] } = {}) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (eq !== -1) flags[name] = arg.slice(eq + 1);
    else if (booleans.includes(name)) flags[name] = true;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--'))
      flags[name] = argv[++i];
    else flags[name] = true;
  }

  return { positional, flags };
}

/**
 * The id named by `--i-understand-this-writes-to`. Throws without it, and
 * for an empty value or one that is just another flag. `what` is "calendar
 * id", "workspace id", ...: it only words the message.
 */
export function confirmedTarget(flags, what) {
  const value = flags[CONFIRM_FLAG.slice(2)];
  if (value === undefined || value === true || String(value).trim() === '')
    throw new GuardError(
      `Refusing to run: this check writes to a real account. Create a disposable ${what} for it, ` +
        `then name it: ${CONFIRM_FLAG} <${what}>. Nothing was sent.`,
    );

  return String(value).trim();
}

const DISPOSABLE = /(^|[^a-z0-9])(test|testing|disposable|sandbox|scratch|throwaway|livecheck|live[ _-]check)([^a-z0-9]|$)/i;

/**
 * Whether a resource's own name says it is disposable: contains one of
 * test, testing, disposable, sandbox, scratch, throwaway or live-check as a
 * whole word. A name is a heuristic on top of the explicit confirm flag,
 * never a replacement for it.
 */
export function looksDisposable(name) {
  return typeof name === 'string' && DISPOSABLE.test(name);
}

/** Throws unless `name` looks disposable. */
export function requireDisposableName(what, name) {
  if (!looksDisposable(name))
    throw new GuardError(
      `Refusing to run: the ${what} is named ${JSON.stringify(name)}, which does not look disposable. ` +
        `Rename it so the name contains "test", "sandbox", "disposable", "scratch", "throwaway" or "live-check" ` +
        `as a whole word, or create a new one. Nothing was written.`,
    );
}

/* ------------------------------------------------------------- secrets */

/** Prompts on the terminal without echoing what is typed. */
export function promptHidden(question) {
  return new Promise((resolvePrompt, reject) => {
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, done) {
        if (!muted) process.stderr.write(chunk);
        done();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    rl.question(question, answer => {
      process.stderr.write('\n');
      rl.close();
      resolvePrompt(answer.trim());
    });
    muted = true;
    rl.on('error', reject);
    rl.on('close', () => reject(new GuardError('No credential entered.')));
  });
}

/**
 * A credential from the environment variable `name`, else from a hidden
 * prompt when stdin is a terminal. There is no third source: never a file,
 * never a flag (a flag lands in shell history and `ps`).
 */
export async function readSecret(
  name,
  {
    env = process.env,
    isTTY = Boolean(process.stdin.isTTY),
    prompt = promptHidden,
    label = name,
  } = {},
) {
  const fromEnv = env[name];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  if (!isTTY)
    throw new GuardError(
      `${name} is not set and there is no terminal to ask on. Set ${name} in the environment ` +
        `(it is read from the environment only, never from a file or a flag).`,
    );
  const typed = await prompt(`${label} (hidden; or set ${name}): `);
  if (!typed) throw new GuardError('No credential entered.');

  return typed;
}

/* ----------------------------------------------------------- redaction */

const PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]'],
  [/Basic\s+[A-Za-z0-9+/=]{8,}/g, 'Basic [redacted]'],
  [/ya29\.[A-Za-z0-9._-]{10,}/g, '[redacted-google-token]'],
  [/1\/\/[A-Za-z0-9._-]{20,}/g, '[redacted-google-refresh-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-github-token]'],
  [/(?:secret_|ntn_)[A-Za-z0-9]{20,}/g, '[redacted-notion-token]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [
    /((?:x-api-key|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi,
    '$1[redacted]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

/**
 * A function that removes credentials and personal data from a string.
 * `secrets` maps a name to its value; each is replaced everywhere it
 * occurs, also percent-encoded and base64-encoded, by `[redacted:<name>]`.
 * A value under 8 characters is refused, because replacing it everywhere
 * would mangle the output instead. Known token shapes (Bearer, Google,
 * GitHub, Notion, JWT), credential header values and email addresses are
 * redacted as well. Strings in `keep` (the ids the run was told to write
 * to) survive the email rule. `.deep` does the same to any JSON value, keys
 * included.
 */
export function createRedactor(secrets = {}, { keep = [] } = {}) {
  const exact = [];

  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || value.length < 8)
      throw new GuardError(
        `${name} is too short to be a credential (under 8 characters); not running.`,
      );
    const variants = new Set([
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString('base64'),
      Buffer.from(`:${value}`).toString('base64'),
      Buffer.from(`${value}:`).toString('base64'),
    ]);
    for (const variant of variants) exact.push([variant, `[redacted:${name}]`]);
  }
  // Longest first, so a value that contains another is not half-replaced.
  exact.sort((a, b) => b[0].length - a[0].length);
  const kept = [...new Set(keep.filter(k => typeof k === 'string' && k))];

  const redact = input => {
    let text = String(input);
    for (const [secret, replacement] of exact)
      text = text.split(secret).join(replacement);
    const holders = kept.map((k, i) => [k, `\u0000keep${i}\u0000`]);
    for (const [k, holder] of holders) text = text.split(k).join(holder);
    for (const [pattern, replacement] of PATTERNS)
      text = text.replace(pattern, replacement);
    for (const [k, holder] of holders) text = text.split(holder).join(k);

    return text;
  };

  redact.deep = value => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redact.deep);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [redact(k), redact.deep(v)]),
      );

    return value;
  };

  return redact;
}

/** A logger that prints to stderr, redacted, one line per call. */
export function createLogger(redact, write = line => process.stderr.write(line)) {
  return (...parts) =>
    write(`${redact(parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '))}\n`);
}

/* -------------------------------------------------------------- budget */

/** Counts provider writes and elapsed time; throws `BudgetError` past either limit. */
export function createBudget({
  maxMutations = 40,
  maxMs = 10 * 60_000,
  now = () => Date.now(),
} = {}) {
  const started = now();
  let mutations = 0;
  let mutationCap = maxMutations;
  let timeCap = maxMs;

  return {
    get maxMutations() {
      return mutationCap;
    },
    get maxMs() {
      return timeCap;
    },
    get mutations() {
      return mutations;
    },
    /** Call before every request. Writes are counted. */
    spend(method) {
      if (now() - started > timeCap)
        throw new BudgetError(
          `Stopped: the run took longer than ${Math.round(timeCap / 60_000)} minutes. A timeout is a failure.`,
        );
      if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        if (mutations >= mutationCap)
          throw new BudgetError(
            `Stopped: ${mutationCap} provider writes were used. Nothing more was sent.`,
          );
        mutations++;
      }
    },
    /**
     * Cleanup only: room for one delete per record this run created, and two
     * more minutes, so a run that hit a limit still removes what it made.
     */
    extendForCleanup(records) {
      mutationCap += records;
      timeCap = now() - started + 120_000;
    },
  };
}

/* ------------------------------------------------------------ provider */

const RESPONSE_HEADERS = ['link', 'retry-after', 'etag', 'content-type'];

/**
 * A bounded client for one provider's API: the only way a scenario reaches
 * the network. `allow({ who, method, pathname, query })` is the scenario's
 * scope; it throws `GuardError` for anything outside the one disposable
 * resource (or the few reads setup needs). Every request, allowed or not,
 * is checked against the budget first and recorded in `requests` without
 * credentials or bodies (a body is recorded as its key names).
 *
 * `who` is `'app'` for what the app's own code asks (through the relay
 * stand-in), `'driver'` for the kit's setup, check and cleanup calls.
 */
export function createProvider({
  baseUrl,
  authHeaders,
  allow,
  budget,
  redact,
  fetcher = globalThis.fetch,
  timeoutMs = 30_000,
  now = () => Date.now(),
}) {
  const base = new URL(baseUrl);
  const requests = [];

  async function request({ who, method = 'GET', path, query, body, ifMatch, headers = {} }) {
    const verb = method.toUpperCase();
    const url = new URL(base.href.replace(/\/$/, '') + path);
    if (url.origin !== base.origin || url.username || url.password || url.hash)
      throw new GuardError(`Refusing a request outside ${base.origin}: ${redact(path)}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    allow({ who, method: verb, pathname: url.pathname, query: Object.fromEntries(url.searchParams) });
    budget.spend(verb);

    const record = {
      n: requests.length + 1,
      who,
      method: verb,
      path: redact(url.pathname + url.search),
      ifMatch: Boolean(ifMatch),
      ...(body === undefined
        ? {}
        : { bodyKeys: Object.keys(JSON.parse(body)).sort() }),
      at: new Date(now()).toISOString(),
    };
    requests.push(record);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = now();

    try {
      const response = await fetcher(url.href, {
        method: verb,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(ifMatch ? { 'if-match': ifMatch } : {}),
          ...headers,
          ...authHeaders(),
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        // Not JSON: keep the text.
      }
      const out = {
        status: response.status,
        headers: Object.fromEntries(
          RESPONSE_HEADERS.flatMap(h => {
            const v = response.headers.get(h);

            return v === null ? [] : [[h, v]];
          }),
        ),
        body: parsed,
      };
      record.status = out.status;
      record.ms = now() - started;

      return out;
    } catch (error) {
      record.status = 'network-error';
      record.error = redact(error instanceof Error ? error.message : String(error));
      record.ms = now() - started;
      throw new Error(record.error);
    } finally {
      clearTimeout(timer);
    }
  }

  return { request, requests };
}

/**
 * The `store.proxy` a drive app's controller expects, over a provider
 * client: the relay stand-in. It names one connection, `live-check`, with no
 * credential; the client adds the credential to the request itself. It maps
 * the app's `{ path, query, method, body, ifMatch }` request to the
 * provider's, as the host's frame client and the integration proxy would.
 */
export function relayStandIn(provider, platform) {
  const connectionId = 'live-check';

  return {
    async request(req) {
      if (req.platform !== platform)
        throw new GuardError(`The app asked for platform ${req.platform}, not ${platform}.`);
      if (req.connectionId !== connectionId)
        throw new Error(`No ${platform} connection ${req.connectionId} is delegated to this app. Connect again.`);

      return provider.request({
        who: 'app',
        method: req.method ?? 'GET',
        path: req.path,
        query: req.query,
        body: req.body,
        ifMatch: req.ifMatch,
      });
    },
    async connections({ platform: asked }) {
      return asked === platform ? [{ connectionId, platform }] : [];
    },
    connect: () => new Promise(() => {}),
  };
}

/* ------------------------------------------------------------ evidence */

/** `<yyyy-mm-dd>T<hhmmss>Z` of a date, for file names. */
export function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** A short random id, so two runs on one day never share a record prefix. */
export function runId() {
  return randomBytes(3).toString('hex');
}

function tryGit(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/** What the evidence says about the code that ran: version, commit and the candidate bundle's hash. */
export function describeCandidate(app, { appId = app, root = REPO_ROOT } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'integrations', app, 'app/package.json'), 'utf8'));
  const bundle = join(root, 'apps', appId, pkg.version, 'ui.js');
  const dirty = tryGit(['status', '--porcelain', '--', `integrations/${app}`, 'ontology-kit']);

  return {
    app: appId,
    appVersion: pkg.version,
    sourceCommit: tryGit(['rev-parse', 'HEAD']),
    sourceDirty: dirty === undefined ? undefined : dirty !== '',
    bundlePath: `apps/${appId}/${pkg.version}/ui.js`,
    bundleSha256: existsSync(bundle)
      ? createHash('sha256').update(readFileSync(bundle)).digest('hex')
      : undefined,
    ranAgainst:
      "the app's controller and sync source, run from Node through a relay stand-in; not the published bundle and not the host's frame",
  };
}

/**
 * Records steps and assertions, then writes the evidence: one JSON file and
 * one short Markdown summary. Everything recorded passes through `redact`.
 */
export function createRecorder({ app, provider, apiVersion, candidate, target, redact, log = () => {}, now = () => new Date(), limits }) {
  const started = now();
  const steps = [];
  const prefix = `livecheck-${started.toISOString().slice(0, 10).replace(/-/g, '')}-${runId()}`;
  let halted = false;

  async function step(id, title, fn, { continueOnFailure = false } = {}) {
    const entry = { id, title, status: 'passed', assertions: [] };
    steps.push(entry);
    if (halted) {
      entry.status = 'skipped';
      entry.note = 'An earlier step failed.';
      log(`skip  ${id}  ${title}`);

      return;
    }

    const check = (name, ok, detail) => {
      entry.assertions.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail: redact.deep(detail) }) });
      log(`${ok ? '  ok' : 'FAIL'}  ${id}  ${name}`);

      return Boolean(ok);
    };
    const equal = (name, actual, expected) => {
      const ok = JSON.stringify(actual) === JSON.stringify(expected);

      return check(name, ok, ok ? undefined : { expected, actual });
    };

    const observe = (name, value) => {
      (entry.observations ??= []).push({ name, value: redact.deep(value) });
      log(`seen  ${id}  ${name}`);
    };

    log(`step  ${id}  ${title}`);
    try {
      await fn({
        check,
        equal,
        observe,
        note: text => (entry.note = redact(text)),
      });
    } catch (error) {
      entry.status = 'failed';
      entry.error = redact(error instanceof Error ? error.message : String(error));
      log(`FAIL  ${id}  ${entry.error}`);
    }
    if (entry.assertions.some(a => !a.ok)) entry.status = 'failed';
    if (entry.status === 'failed' && !continueOnFailure) halted = true;
  }

  function document({ cleanup, notCovered, preflightOnly, requests = [] }) {
    const ended = now();
    const failed = steps.some(s => s.status === 'failed') || cleanup.status === 'failed';

    return {
      schemaVersion: 1,
      kind: 'live-check',
      status: failed ? 'failed' : preflightOnly ? 'preflight-only' : 'passed',
      app: candidate.app,
      provider: provider,
      apiVersion,
      candidate,
      target: redact.deep(target),
      runPrefix: prefix,
      startedAt: started.toISOString(),
      endedAt: ended.toISOString(),
      limits: {
        maxMutations: limits.maxMutations,
        maxMs: limits.maxMs,
        mutations: limits.mutations,
      },
      steps,
      cleanup,
      notCovered,
      requests,
      note:
        'Credentials are read from the environment or a hidden prompt and are never written here. ' +
        'Request bodies are recorded as key names only. Declared capabilities become verified only for the assertions that passed, on this date, for this provider API.',
    };
  }

  return { prefix, steps, step, document };
}

/** The Markdown summary of an evidence document. */
export function renderMarkdown(doc) {
  const lines = [
    `# Live check: ${doc.app} ${doc.candidate.appVersion} against ${doc.provider}`,
    '',
    `- Result: **${doc.status}**`,
    `- Date: ${doc.startedAt.slice(0, 10)} (${doc.startedAt} to ${doc.endedAt})`,
    `- Target: ${doc.target.kind} \`${doc.target.id}\`${doc.target.name ? ` ("${doc.target.name}")` : ''}`,
    `- Provider API: ${doc.apiVersion}`,
    `- Source commit: ${doc.candidate.sourceCommit ?? 'unknown'}${doc.candidate.sourceDirty ? ' (uncommitted changes in the package)' : ''}`,
    `- Candidate bundle: \`${doc.candidate.bundlePath}\` ${doc.candidate.bundleSha256 ? `sha256 \`${doc.candidate.bundleSha256}\`` : '(not found)'}`,
    `- Ran against: ${doc.candidate.ranAgainst}`,
    `- Provider writes: ${doc.limits.mutations} of at most ${doc.limits.maxMutations}; time limit ${Math.round(doc.limits.maxMs / 60_000)} minutes`,
    `- Cleanup: ${doc.cleanup.status}${doc.cleanup.note ? ` (${doc.cleanup.note})` : ''}`,
    '',
    '| Step | Result | Assertions |',
    '| --- | --- | --- |',
    ...doc.steps.map(
      s =>
        `| ${s.id}: ${s.title} | ${s.status} | ${s.assertions.filter(a => a.ok).length}/${s.assertions.length}${s.error ? `; ${s.error.replace(/\|/g, '/')}` : ''} |`,
    ),
    '',
  ];
  const seen = doc.steps.flatMap(s =>
    (s.observations ?? []).map(o => `- ${s.id}: ${o.name}: \`${JSON.stringify(o.value)}\``),
  );
  if (seen.length)
    lines.push('Observed, not asserted (answers to open questions):', '', ...seen, '');
  const failures = doc.steps.flatMap(s => s.assertions.filter(a => !a.ok).map(a => `${s.id}: ${a.name}`));
  if (failures.length) lines.push('Failed assertions:', '', ...failures.map(f => `- ${f}`), '');
  lines.push('Not covered by this run:', '', ...doc.notCovered.map(n => `- ${n}`), '');
  lines.push(
    'No credentials and no personal data are recorded: the content is invented, and email addresses are replaced. A passing run supports only the assertions above, on this date.',
    '',
  );

  return lines.join('\n');
}

/**
 * Writes `<outDir>/<app>-<stamp>.json` and `.md`, redacted, and returns
 * their paths. The directory is created if needed. The caller chooses it
 * (default `integrations/live-evidence/<app>/`).
 */
export function writeEvidence(doc, outDir, redact) {
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${doc.app}-${stamp(new Date(doc.startedAt))}`);
  const clean = redact.deep(doc);
  writeFileSync(`${base}.json`, `${JSON.stringify(clean, null, 2)}\n`);
  writeFileSync(`${base}.md`, redact(renderMarkdown(clean)));

  return { json: `${base}.json`, markdown: `${base}.md` };
}

/** Where evidence goes unless `--out` says otherwise. */
export const defaultEvidenceDir = app => join(REPO_ROOT, 'integrations', 'live-evidence', app);

/**
 * What `live-check.mjs` hands a scenario process, through the environment
 * (never argv, which `ps` shows). Throws when the scenario was started some
 * other way: a scenario file must never be run bare.
 */
export function liveSettings(env = process.env) {
  const target = env.LIVE_CHECK_CONFIRMED;
  if (!target || !target.trim())
    throw new GuardError(
      `Refusing to run: start this through \`node integrations/tooling/live-check.mjs <app> ${CONFIRM_FLAG} <id>\`.`,
    );
  const number = name => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
      throw new GuardError(`${name} must be a positive whole number.`);

    return n;
  };
  const minutes = number('LIVE_CHECK_MAX_MINUTES');

  return {
    target: target.trim(),
    outDir: env.LIVE_CHECK_OUT || undefined,
    maxMutations: number('LIVE_CHECK_MAX_MUTATIONS'),
    maxMs: minutes === undefined ? undefined : minutes * 60_000,
    preflightOnly: env.LIVE_CHECK_PREFLIGHT_ONLY === '1',
  };
}
