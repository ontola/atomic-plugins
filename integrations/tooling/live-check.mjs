/**
 * The live-check kit's one command per app (integrations/LIVE_TESTING.md,
 * "The live-check kit"):
 *
 *   node integrations/tooling/live-check.mjs calendar \
 *     --i-understand-this-writes-to <calendar id>
 *
 * It refuses to run without `--i-understand-this-writes-to <id>`, reads the
 * credential from the environment (or a hidden prompt on a terminal), and
 * starts the app's scenario (`integrations/<app>/live/`) in a child Vitest
 * process whose output is redacted line by line. Nothing is read from a file
 * in the repo, and nothing but the evidence files is written.
 *
 * Options: `--out <dir>` (default integrations/live-evidence/<app>),
 * `--max-mutations <n>` (default 40), `--max-minutes <n>` (default 10),
 * `--preflight-only` (checks the credential and the target with reads only).
 * It needs the AGENTS.md layout: `node integrations/tooling/link-atomic-server.mjs`.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONFIRM_FLAG,
  GuardError,
  REPO_ROOT,
  confirmedTarget,
  createRedactor,
  parseArgs,
  readSecret,
} from './live-kit.mjs';

/**
 * Each app: where its scenario lives (`dir`, or `config` when the plugin
 * folder holds more than one app), its credential, and what its target is
 * called.
 */
export const APPS = {
  calendar: {
    dir: 'calendar',
    provider: 'Google Calendar',
    secret: 'GOOGLE_CALENDAR_ACCESS_TOKEN',
    secretLabel:
      'Google OAuth access token (scopes calendar.events and calendar.calendarlist.readonly)',
    target: 'calendar id',
  },
  timesheets: {
    dir: 'timesheets',
    provider: 'Clockify',
    secret: 'CLOCKIFY_API_KEY',
    secretLabel: "Clockify API key of the test workspace's own account",
    target: 'workspace id',
  },
  'issue-tracker': {
    dir: 'issue-tracker',
    provider: 'GitHub',
    secret: 'GITHUB_TOKEN',
    secretLabel:
      'GitHub fine-grained token for the one sandbox repository (Issues: read and write)',
    target: 'repository (owner/name)',
  },
  notion: {
    dir: 'notion',
    provider: 'Notion',
    secret: 'NOTION_TOKEN',
    secretLabel:
      'Notion internal integration secret, shared with the one test data source only',
    target: 'data source id',
  },
  moneybird: {
    dir: 'money',
    config: 'integrations/money/vitest.live.config.ts',
    provider: 'Moneybird',
    secret: 'MONEYBIRD_API_TOKEN',
    secretLabel:
      "Moneybird personal API token of the test administration's account (contacts: read and write)",
    target: 'administration id',
  },
  todoist: {
    dir: 'issue-tracker',
    config: 'integrations/issue-tracker/vitest.live.todoist.config.ts',
    provider: 'Todoist',
    secret: 'TODOIST_API_TOKEN',
    secretLabel:
      'Todoist API token of a dedicated test account (data:read_write)',
    target: 'project id',
  },
};

/** The Vitest config that holds an app's live scenario, relative to the repo root. */
export const configOf = app =>
  app.config ?? `integrations/${app.dir}/vitest.live.config.ts`;

export const USAGE = `Usage: node integrations/tooling/live-check.mjs <app> ${CONFIRM_FLAG} <id> [options]

Apps:
${Object.entries(APPS)
  .map(
    ([name, a]) =>
      `  ${name.padEnd(14)} ${a.provider}; target: ${a.target}; credential: ${a.secret}`,
  )
  .join('\n')}

Options:
  --out <dir>            where evidence goes (default integrations/live-evidence/<app>)
  --max-mutations <n>    stop after n provider writes (default 40)
  --max-minutes <n>      stop after n minutes (default 10)
  --preflight-only       check the credential and the target with reads only
`;

/** Redacts a stream line by line, so a secret split across chunks is still caught. */
export function redactingWriter(redact, write) {
  let pending = '';

  return {
    push(chunk) {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) write(`${redact(line)}\n`);
    },
    end() {
      if (pending) write(`${redact(pending)}\n`);
      pending = '';
    },
  };
}

/**
 * Runs the command. `deps` lets the tests replace what touches the world:
 * the environment, the terminal prompt, `spawn` and the output.
 */
export async function main(argv, deps = {}) {
  const {
    env = process.env,
    spawn = nodeSpawn,
    out = line => process.stdout.write(line),
    err = line => process.stderr.write(line),
    prompt,
    isTTY,
    root = REPO_ROOT,
  } = deps;

  try {
    const { positional, flags } = parseArgs(argv, {
      booleans: ['preflight-only', 'help'],
    });

    if (flags.help || positional.length === 0) {
      out(USAGE);

      return flags.help ? 0 : 2;
    }

    const app = APPS[positional[0]];
    if (!app || positional.length > 1)
      throw new GuardError(
        `Unknown app ${JSON.stringify(positional.join(' '))}.\n${USAGE}`,
      );
    const known = [
      CONFIRM_FLAG.slice(2),
      'out',
      'max-mutations',
      'max-minutes',
      'preflight-only',
      'help',
    ];
    for (const name of Object.keys(flags))
      if (!known.includes(name))
        throw new GuardError(`Unknown option --${name}.\n${USAGE}`);

    // 1. The explicit confirmation, before anything else (before the credential).
    const target = confirmedTarget(flags, app.target);
    // 2. The credential: environment or a hidden prompt.
    const secret = await readSecret(app.secret, {
      env,
      label: app.secretLabel,
      ...(prompt ? { prompt } : {}),
      ...(isTTY === undefined ? {} : { isTTY }),
    });
    const redact = createRedactor({ [app.secret]: secret }, { keep: [target] });

    const vitest = join(root, 'browser/node_modules/.bin/vitest');
    const config = configOf(app);
    if (!existsSync(vitest) || !existsSync(join(root, config)))
      throw new GuardError(
        'The browser/ layout is missing. Run: node integrations/tooling/link-atomic-server.mjs',
      );

    err(
      `live-check ${positional[0]}: ${app.provider}, ${app.target} ${redact(target)}. ` +
        `Writes to that one resource only; credential taken from ${app.secret} (not shown).\n`,
    );

    const child = spawn(vitest, ['run', '--config', config], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        [app.secret]: secret,
        LIVE_CHECK_APP: positional[0],
        LIVE_CHECK_CONFIRMED: target,
        LIVE_CHECK_OUT: typeof flags.out === 'string' ? flags.out : '',
        LIVE_CHECK_MAX_MUTATIONS:
          typeof flags['max-mutations'] === 'string'
            ? flags['max-mutations']
            : '',
        LIVE_CHECK_MAX_MINUTES:
          typeof flags['max-minutes'] === 'string' ? flags['max-minutes'] : '',
        LIVE_CHECK_PREFLIGHT_ONLY: flags['preflight-only'] ? '1' : '',
        VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
        NO_COLOR: '1',
      },
    });
    const stdout = redactingWriter(redact, out);
    const stderr = redactingWriter(redact, err);
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stderr?.on('data', chunk => stderr.push(chunk));

    return await new Promise(done => {
      child.on('error', error => {
        err(`${redact(error.message)}\n`);
        done(1);
      });
      child.on('close', code => {
        stdout.end();
        stderr.end();
        done(code ?? 1);
      });
    });
  } catch (error) {
    if (error instanceof GuardError) {
      err(`${error.message}\n`);

      return 2;
    }

    err(`${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = await main(process.argv.slice(2));
