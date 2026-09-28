#!/usr/bin/env node
/**
 * The voice moderator of a user-testing session (../page/ is its front end).
 * Each turn gets what the tester said (speech-to-text in their browser) plus
 * the collector's log lines since the previous turn, asks Claude for the next
 * thing to say (script.md is the interview script), and returns it for the
 * browser to speak.
 *
 * Per session it keeps, under SESSIONS_DIR/<id>/: meta.json, transcript.jsonl
 * (both sides, with the log lines each turn saw) and recording.webm (screen
 * and microphone, uploaded by the page in chunks).
 *
 * The endpoints spend API money and are public, so every request needs the
 * invite code (USERTEST_CODE, sent as `x-usertest-code`), a session takes at
 * most MAX_TURNS turns, and at most MAX_SESSIONS_PER_DAY sessions start per
 * UTC day. ANTHROPIC_API_KEY comes from the environment (/etc/anthropic.env
 * on the droplet, passed by run.sh) and never leaves this process.
 */
import Anthropic from '@anthropic-ai/sdk';
import { randomBytes } from 'node:crypto';
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

if (!CODE || CODE.length < 12)
  throw new Error('USERTEST_CODE must be set (at least 12 characters)');

const SCRIPT = readFileSync(join(here, 'script.md'), 'utf8');
const client = new Anthropic();
/** id -> { dir, started, cursor, messages, turns, done } */
const sessions = new Map();

mkdirSync(SESSIONS_DIR, { recursive: true });

const today = () => new Date().toISOString().slice(0, 10);

function sessionsToday() {
  return readdirSync(SESSIONS_DIR).filter(name => name.startsWith(today()))
    .length;
}

/** The collector's lines after `cursor` (an ISO time), made short enough to
 * read: errors, warnings, feedback and sync outcomes only. */
function logSince(cursor) {
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

function record(session, entry) {
  appendFileSync(
    join(session.dir, 'transcript.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n',
  );
}

/** Asks Claude for the next thing to say. */
async function nextLine(session, said, screenshot) {
  const now = new Date().toISOString();
  const log = logSince(session.cursor);
  session.cursor = now;
  const heard = said.trim() || '(silence)';
  const shot =
    typeof screenshot === 'string' && /^[A-Za-z0-9+/=]+$/.test(screenshot)
      ? screenshot
      : undefined;
  const content = [
    log.length ? `[Log]\n${log.join('\n')}` : '[Log]\n(nothing new)',
    `[Tester]\n${session.turns === 0 ? '(the session starts now)' : heard}`,
  ].join('\n\n');

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
  record(session, { role: 'tester', said: heard, log, screenshot: !!shot });

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
    system: SCRIPT,
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
    : text.replace('[END]', '').replace('[WAIT]', '').trim() ||
      'Sorry, I lost my train of thought. Could you tell me what you are doing now?';

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

  try {
    if (req.method === 'POST' && url.pathname === '/sessions') {
      if (sessionsToday() >= MAX_SESSIONS_PER_DAY)
        return reply(429, { error: 'No more sessions today' });
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString());
      const id = `${today()}-${randomBytes(4).toString('hex')}`;
      const dir = join(SESSIONS_DIR, id);
      mkdirSync(dir);
      const started = new Date().toISOString();
      writeFileSync(
        join(dir, 'meta.json'),
        JSON.stringify(
          {
            id,
            started,
            name: String(body.name ?? '').slice(0, 80),
            lang: String(body.lang ?? '').slice(0, 20),
            userAgent: req.headers['user-agent'],
            model: MODEL,
          },
          null,
          2,
        ),
      );
      sessions.set(id, {
        dir,
        started,
        cursor: started,
        messages: [],
        turns: 0,
        done: false,
      });

      return reply(200, { id });
    }

    const match = url.pathname.match(
      /^\/sessions\/([\w-]+)\/(turn|recording|end|news)$/,
    );
    const session = match && sessions.get(match[1]);
    if (!session) return reply(404, { error: 'Unknown session' });

    // Errors logged since the last turn, so the page can let the moderator
    // react to them without waiting for the tester to speak.
    if (req.method === 'GET' && match[2] === 'news')
      return reply(200, {
        errors: logSince(session.cursor).filter(line => / error: /.test(line))
          .length,
      });

    if (req.method === 'POST' && match[2] === 'turn') {
      if (session.done || session.turns >= MAX_TURNS)
        return reply(200, { say: '', done: true });
      // Room for a 1280-pixel JPEG screenshot, base64-encoded.
      const body = JSON.parse(
        (await readBody(req, 4 * 1024 * 1024)).toString(),
      );

      return reply(
        200,
        await nextLine(session, String(body.said ?? ''), body.screenshot),
      );
    }

    if (req.method === 'POST' && match[2] === 'recording') {
      appendFileSync(
        join(session.dir, 'recording.webm'),
        await readBody(req, MAX_CHUNK),
      );

      return reply(204);
    }

    if (req.method === 'POST' && match[2] === 'end') {
      record(session, { role: 'page', event: 'end' });
      session.done = true;

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
