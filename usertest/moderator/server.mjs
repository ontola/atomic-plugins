#!/usr/bin/env node
/**
 * The voice moderator of a user-testing session (../page/ is its front end).
 * Each turn gets what the tester said (speech-to-text in their browser) plus
 * the collector's log lines since the previous turn, asks Claude for the next
 * thing to say, and returns it for the browser to speak. The system prompt is
 * script.md (how to moderate) followed by one session plan from sessions/
 * (which tasks), picked by the invite link's `session` parameter.
 *
 * Per session it keeps, under SESSIONS_DIR/<id>/: meta.json, transcript.jsonl
 * (both sides, with the log lines each turn saw) and recording.webm (screen
 * and microphone, uploaded by the page in chunks).
 *
 * A tester who can't talk types instead: such a turn arrives with
 * `input: 'typed'`, reaches Claude marked "[Tester, typed]", is recorded with
 * `input: 'typed'` in transcript.jsonl and counted in meta.json's
 * `typedTurns`. meta.json's `input` says how the session started: `voice`,
 * or `typed` when the page had no microphone or speech recognition.
 *
 * The tester picks the language on the page (English by default, see
 * LANGUAGES) and can switch mid-session (`POST /sessions/<id>/lang`). Every
 * turn tells Claude the language to speak in a `[Language]` line, so the
 * system prompt (script and plan, in English) stays the same and cached.
 * meta.json keeps the current `lang` and every switch in `langChanges`.
 *
 * The endpoints spend API money and are public, so every request needs the
 * invite code (USERTEST_CODE, sent as `x-usertest-code`), a session takes at
 * most MAX_TURNS turns, and at most MAX_SESSIONS_PER_DAY sessions start per
 * UTC day. A wrong or missing code gets 403 (and nothing else does), which
 * the page reports as a code problem; `GET /check` lets it test the code
 * when it loads. ANTHROPIC_API_KEY comes from the environment (/etc/anthropic.env
 * on the droplet, passed by run.sh) and never leaves this process.
 *
 * A turn only sees its own tester's log lines: the collector tags each line
 * with a salted hash of the sender's address, and a session remembers the
 * hashes its page came from (atomic-server's own lines are always included).
 * When a session ends, analyze.mjs turns it into anonymized findings and, if
 * a token is configured, files them in the private triage repo.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, fileFindings } from './analyze.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8082);
const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/sessions';
const LOG_DIR = process.env.LOG_DIR ?? '/logs';
const CODE = process.env.USERTEST_CODE;
const MODEL = process.env.MODERATOR_MODEL ?? 'claude-opus-5';
const MAX_TURNS = 120;
const MAX_SESSIONS_PER_DAY = 20;
const MAX_CHUNK = 32 * 1024 * 1024;
const MAX_LOG_LINES = 15;
/** The page's languages (../page/i18n.js), by the BCP 47 tag it sends. */
const LANGUAGES = {
  'en-US': {
    name: 'English',
    lost: 'Sorry, I lost my train of thought. Could you tell me what you are doing now?',
  },
  'nl-NL': {
    name: 'Dutch (Nederlands)',
    lost: 'Sorry, ik ben de draad even kwijt. Kun je vertellen wat je nu aan het doen bent?',
  },
};
const DEFAULT_LANG = 'en-US';

if (!CODE || CODE.length < 12)
  throw new Error('USERTEST_CODE must be set (at least 12 characters)');
const SALT = process.env.USERTEST_SALT;
if (!SALT) throw new Error('USERTEST_SALT must be set');

/** The collector's hash of a request's sender (collector/server.mjs). */
const clientOf = req =>
  createHash('sha256')
    .update(
      SALT +
        (String(req.headers['x-forwarded-for'] ?? '')
          .split(',')[0]
          .trim() ||
          req.socket.remoteAddress ||
          ''),
    )
    .digest('hex')
    .slice(0, 16);

const SCRIPT = readFileSync(join(here, 'script.md'), 'utf8');
/** Session plans by name: sessions/<name>.md (README.md is not a plan). */
const PLANS = Object.fromEntries(
  readdirSync(join(here, 'sessions'))
    .filter(file => file.endsWith('.md') && file !== 'README.md')
    .map(file => [
      file.slice(0, -3),
      readFileSync(join(here, 'sessions', file), 'utf8'),
    ]),
);
/** The plan an invite link without `session` gets: the first one we ran. */
const DEFAULT_PLAN = 'calendar';
if (!PLANS[DEFAULT_PLAN])
  throw new Error(`sessions/${DEFAULT_PLAN}.md is missing`);
const client = new Anthropic();
/** id -> { dir, meta, lang, langChanged, started, plan, cursor, clients, messages, turns, done, analyzed } */
const sessions = new Map();

mkdirSync(SESSIONS_DIR, { recursive: true });

const today = () => new Date().toISOString().slice(0, 10);

function sessionsToday() {
  return readdirSync(SESSIONS_DIR).filter(name => name.startsWith(today()))
    .length;
}

/** The collector's lines after `cursor` (an ISO time) from `clients` (and
 * atomic-server), made short enough to read: errors, warnings, feedback and
 * sync outcomes only. */
function logSince(cursor, clients) {
  const days = [...new Set([cursor.slice(0, 10), today()])];
  const lines = [];

  for (const day of days) {
    const file = join(LOG_DIR, `${day}.jsonl`);
    if (!existsSync(file)) continue;

    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw) continue;
      let entry;

      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }

      if (entry.t <= cursor) continue;
      if (entry.source !== 'atomic-server' && !clients.has(entry.client))
        continue;
      const data = entry.data ?? {};
      const level = entry.level ?? data.level;
      const message =
        entry.type === 'feedback'
          ? `feedback: ${entry.feedback?.message ?? ''}`
          : (data.message ??
            entry.message ??
            entry.exceptions?.map(e => `${e.type}: ${e.value}`).join('; '));
      if (!message || !['error', 'warn', 'info', undefined].includes(level))
        continue;
      if (level === 'info' && data.message !== 'Sync finished') continue;
      const detail =
        data.message === 'Sync finished'
          ? ` (imported ${data.total}, unreadable ${data.skipped?.unreadable ?? 0})`
          : '';
      lines.push(
        `${entry.t.slice(11, 19)} ${entry.source} ${level ?? ''}: ${String(message).slice(0, 300)}${detail}`,
      );
    }
  }

  return lines.slice(-MAX_LOG_LINES);
}

function writeMeta(session) {
  writeFileSync(
    join(session.dir, 'meta.json'),
    JSON.stringify(session.meta, null, 2),
  );
}

function record(session, entry) {
  appendFileSync(
    join(session.dir, 'transcript.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n',
  );
}

/** Asks Claude for the next thing to say. */
async function nextLine(session, said, screenshot, typed) {
  const now = new Date().toISOString();
  const log = logSince(session.cursor, session.clients);
  session.cursor = now;
  const heard = said.trim() || '(silence)';
  const shot =
    typeof screenshot === 'string' && /^[A-Za-z0-9+/=]+$/.test(screenshot)
      ? screenshot
      : undefined;
  const language = LANGUAGES[session.lang];
  const opening =
    session.meta.input === 'typed'
      ? '(the session starts now; the tester has no working microphone or speech recognition and types their answers)'
      : '(the session starts now)';
  const content = [
    `[Language] ${language.name}${session.langChanged ? '. The tester just switched to it: speak it from now on.' : ''}`,
    log.length ? `[Log]\n${log.join('\n')}` : '[Log]\n(nothing new)',
    `[Tester${typed ? ', typed' : ''}]\n${session.turns === 0 ? opening : heard}`,
  ].join('\n\n');
  if (typed) {
    session.meta.typedTurns++;
    writeMeta(session);
  }

  // History keeps the text only; the screenshot goes with this turn alone,
  // so the conversation does not grow by an image per turn.
  session.messages.push({
    role: 'user',
    content: shot
      ? `[Screen] (screenshot shown at the time)\n\n${content}`
      : content,
  });
  if (shot)
    writeFileSync(
      join(session.dir, `screen-${String(session.turns).padStart(3, '0')}.jpg`),
      Buffer.from(shot, 'base64'),
    );
  session.langChanged = false;
  record(session, {
    role: 'tester',
    said: heard,
    input: typed ? 'typed' : 'voice',
    lang: session.lang,
    log,
    screenshot: !!shot,
  });

  const messages = shot
    ? [
        ...session.messages.slice(0, -1),
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: shot },
            },
            { type: 'text', text: `[Screen] (the image above)\n\n${content}` },
          ],
        },
      ]
    : session.messages;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Spoken turns are short; low effort keeps the pause before each reply
    // short too.
    output_config: { effort: 'low' },
    cache_control: { type: 'ephemeral' },
    system: `${SCRIPT}\n\n${PLANS[session.plan]}`,
    messages,
  });

  const text =
    response.stop_reason === 'refusal'
      ? ''
      : response.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join(' ')
          .trim();
  const done = text.includes('[END]');
  const wait = !done && /^\[WAIT\]$/.test(text);
  const say = wait
    ? ''
    : text.replace('[END]', '').replace('[WAIT]', '').trim() || language.lost;

  session.messages.push({ role: 'assistant', content: wait ? '[WAIT]' : say });
  session.turns++;
  session.done = done;
  record(session, {
    role: 'moderator',
    say,
    done,
    stop: response.stop_reason,
    usage: response.usage,
  });

  return { say, done };
}

/** Analyzes a finished session once, in the background: the tester's page
 * does not wait for it. */
function finishLater(id, session) {
  if (session.analyzed) return;
  session.analyzed = true;
  // Give the page's last recording chunk a moment to arrive.
  setTimeout(async () => {
    try {
      const findings = await analyze(id, { client });
      const urls = await fileFindings(id, findings);
      record(session, {
        role: 'analysis',
        findings: findings.length,
        filed: urls.length,
      });
    } catch (error) {
      record(session, { role: 'analysis', error: String(error) });
      process.stderr.write(
        `${new Date().toISOString()} ${error.stack ?? error}\n`,
      );
    }
  }, 5000);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://moderator');

  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  };

  if (req.method === 'GET' && url.pathname === '/health')
    return reply(200, { ok: true });
  if (req.headers['x-usertest-code'] !== CODE)
    return reply(403, { error: 'Unknown invite code' });
  // The page checks its invite code when it loads, so a wrong code is
  // reported before the tester shares a screen or tests a microphone.
  if (req.method === 'GET' && url.pathname === '/check')
    return reply(200, { ok: true });

  try {
    if (req.method === 'POST' && url.pathname === '/sessions') {
      if (sessionsToday() >= MAX_SESSIONS_PER_DAY)
        return reply(429, { error: 'No more sessions today' });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString());
      const plan = body.session ?? DEFAULT_PLAN;
      // A mistyped link fails here, not by silently running another plan.
      if (typeof plan !== 'string' || !Object.hasOwn(PLANS, plan))
        return reply(400, {
          error: `Unknown session plan; known: ${Object.keys(PLANS).join(', ')}`,
        });
      const id = `${today()}-${randomBytes(4).toString('hex')}`;
      const dir = join(SESSIONS_DIR, id);
      mkdirSync(dir);
      const started = new Date().toISOString();
      const lang = Object.hasOwn(LANGUAGES, body.lang)
        ? body.lang
        : DEFAULT_LANG;
      const session = {
        dir,
        meta: {
          id,
          started,
          name: String(body.name ?? '').slice(0, 80),
          lang,
          // Every switch after the start: [{ t, lang }].
          langChanges: [],
          plan,
          // How the page started: `typed` without a microphone or speech
          // recognition. Typed turns are counted either way.
          input: body.input === 'typed' ? 'typed' : 'voice',
          typedTurns: 0,
          userAgent: req.headers['user-agent'],
          model: MODEL,
        },
        lang,
        langChanged: false,
        started,
        plan,
        cursor: started,
        clients: new Set([clientOf(req)]),
        messages: [],
        turns: 0,
        done: false,
        analyzed: false,
      };
      writeMeta(session);
      sessions.set(id, session);

      return reply(200, { id });
    }

    const match = url.pathname.match(
      /^\/sessions\/([\w-]+)\/(turn|recording|end|news|lang)$/,
    );
    const session = match && sessions.get(match[1]);
    if (!session) return reply(404, { error: 'Unknown session' });
    // A tester's address can change during a session (another network).
    session.clients.add(clientOf(req));

    // Errors logged since the last turn, so the page can let the moderator
    // react to them without waiting for the tester to speak.
    if (req.method === 'GET' && match[2] === 'news')
      return reply(200, {
        errors: logSince(session.cursor, session.clients).filter(line =>
          / error: /.test(line),
        ).length,
      });

    if (req.method === 'POST' && match[2] === 'turn') {
      if (session.done || session.turns >= MAX_TURNS)
        return reply(200, { say: '', done: true });
      // Room for a 1280-pixel JPEG screenshot, base64-encoded.
      const body = JSON.parse(
        (await readBody(req, 4 * 1024 * 1024)).toString(),
      );

      const next = await nextLine(
        session,
        String(body.said ?? ''),
        body.screenshot,
        body.input === 'typed',
      );
      if (next.done) finishLater(match[1], session);

      return reply(200, next);
    }

    if (req.method === 'POST' && match[2] === 'recording') {
      appendFileSync(
        join(session.dir, 'recording.webm'),
        await readBody(req, MAX_CHUNK),
      );

      return reply(204);
    }

    if (req.method === 'POST' && match[2] === 'lang') {
      const { lang } = JSON.parse((await readBody(req, 1024)).toString());
      if (!Object.hasOwn(LANGUAGES, lang))
        return reply(400, {
          error: `Unknown language; known: ${Object.keys(LANGUAGES).join(', ')}`,
        });

      if (lang !== session.lang) {
        session.lang = lang;
        session.langChanged = true;
        session.meta.lang = lang;
        session.meta.langChanges.push({ t: new Date().toISOString(), lang });
        writeMeta(session);
        record(session, { role: 'page', event: 'lang', lang });
      }

      return reply(200, { lang });
    }

    if (req.method === 'POST' && match[2] === 'end') {
      record(session, { role: 'page', event: 'end' });
      session.done = true;
      finishLater(match[1], session);

      return reply(200, { ok: true });
    }

    return reply(404, { error: 'Not found' });
  } catch (error) {
    const status =
      error.status === 413
        ? 413
        : error instanceof Anthropic.RateLimitError
          ? 503
          : error instanceof Anthropic.APIError
            ? 502
            : 500;
    process.stderr.write(
      `${new Date().toISOString()} ${error.stack ?? error}\n`,
    );

    return reply(status, { error: 'The moderator could not answer' });
  }
}).listen(PORT, () => {
  process.stdout.write(`moderator on :${PORT} using ${MODEL}\n`);
});
