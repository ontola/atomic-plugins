#!/usr/bin/env node
/**
 * The user-testing log collector: one JSON line per event, in a file per UTC
 * day under LOG_DIR, so a session can be followed with `tail -f` and read
 * back afterwards. No dependencies; see ../README.md, "Logs".
 *
 * Two ways in:
 *
 * - POST /api/<project>/envelope/ — Sentry's envelope endpoint. atomic-server
 *   (SENTRY_DSN, project 1) and the data-browser it serves
 *   (SENTRY_DSN_BROWSER, project 2) report here once server.sh sets those.
 *   Each item becomes one line: events are summarised (level, message,
 *   exception, top frames, URL), feedback keeps its message and contact.
 * - POST /log — a JSON object, or an array of them, from anything else: a
 *   drive app in its sandboxed (null-origin) frame, or the /usertest page.
 *   Stored as sent, under `data`.
 *
 * Every line has `t` (receive time, ISO), `via` and `source`. Nothing checks
 * who sends: like a Sentry DSN, the endpoint is public. Bodies over
 * MAX_BODY bytes are refused, and a stored line is cut at MAX_LINE bytes.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';

const PORT = Number(process.env.PORT ?? 8081);
const LOG_DIR = process.env.LOG_DIR ?? '/logs';
const MAX_BODY = 1024 * 1024;
const MAX_LINE = 64 * 1024;
/** Sentry project ids, as in the DSNs server.sh passes. */
const PROJECTS = { 1: 'atomic-server', 2: 'data-browser' };

mkdirSync(LOG_DIR, { recursive: true });

function write(entry) {
  const t = new Date().toISOString();
  let line = JSON.stringify({ t, ...entry });
  if (Buffer.byteLength(line) > MAX_LINE)
    line = JSON.stringify({
      t,
      via: entry.via,
      source: entry.source,
      truncated: line.slice(0, MAX_LINE),
    });
  appendFileSync(join(LOG_DIR, `${t.slice(0, 10)}.jsonl`), line + '\n');
}

const frames = exception =>
  (exception?.stacktrace?.frames ?? [])
    .slice(-5)
    .reverse()
    .map(f => `${f.function ?? '?'} (${f.filename ?? '?'}:${f.lineno ?? '?'})`);

/** The parts of a Sentry event worth reading in a log line. */
function summarise(event) {
  const exceptions = event.exception?.values ?? [];

  return {
    level: event.level,
    message:
      event.message?.formatted ??
      (typeof event.message === 'string' ? event.message : undefined) ??
      event.logentry?.message,
    exceptions: exceptions.map(e => ({
      type: e.type,
      value: e.value,
      frames: frames(e),
    })),
    url: event.request?.url,
    release: event.release,
    environment: event.environment,
    tags: event.tags,
    breadcrumbs: (event.breadcrumbs?.values ?? event.breadcrumbs ?? [])
      .slice?.(-10)
      .map(b => ({ category: b.category, message: b.message, data: b.data })),
  };
}

/** Splits an envelope into items: a header line, then header/payload pairs,
 * where a payload is `length` bytes when the item header says so. */
function* items(body) {
  let at = body.indexOf(0x0a);
  if (at < 0) return;
  at++;

  while (at < body.length) {
    const end = body.indexOf(0x0a, at);
    const header = JSON.parse(
      body.subarray(at, end < 0 ? body.length : end).toString(),
    );
    if (end < 0) return;
    at = end + 1;
    let payload;

    if (typeof header.length === 'number') {
      payload = body.subarray(at, at + header.length);
      at += header.length + 1;
    } else {
      const next = body.indexOf(0x0a, at);
      payload = body.subarray(at, next < 0 ? body.length : next);
      at = next < 0 ? body.length : next + 1;
    }

    yield { header, payload };
  }
}

function envelope(project, body) {
  const source = PROJECTS[project] ?? `sentry-${project}`;

  for (const { header, payload } of items(body)) {
    const type = header.type;
    // Sessions, client reports and attachments are not stored.
    if (!['event', 'feedback', 'user_report'].includes(type)) continue;
    const item = JSON.parse(payload.toString());
    if (type === 'feedback')
      write({
        via: 'sentry',
        source,
        type,
        feedback: item.contexts?.feedback,
        url: item.request?.url ?? item.contexts?.feedback?.url,
      });
    else write({ via: 'sentry', source, type, ...summarise(item) });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const encoding = req.headers['content-encoding'];
      resolve(
        encoding === 'gzip'
          ? gunzipSync(raw)
          : encoding === 'deflate'
            ? inflateSync(raw)
            : raw,
      );
    });
    req.on('error', reject);
  });
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers':
    'content-type, content-encoding, x-sentry-auth, sentry-trace, baggage',
  'access-control-max-age': '600',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://collector');
  const done = (status, body = '') => {
    res.writeHead(status, { ...cors, 'content-type': 'application/json' });
    res.end(body);
  };

  if (req.method === 'OPTIONS') return done(204);
  if (req.method === 'GET' && url.pathname === '/health')
    return done(200, '{"ok":true}');
  if (req.method !== 'POST') return done(405);

  try {
    const body = await readBody(req);
    const sentry = url.pathname.match(/^\/api\/(\d+)\/envelope\/?$/);

    if (sentry) {
      envelope(sentry[1], body);

      return done(200, '{}');
    }
    if (url.pathname === '/log') {
      const parsed = JSON.parse(body.toString());
      for (const data of Array.isArray(parsed) ? parsed : [parsed])
        write({
          via: 'log',
          source: typeof data?.source === 'string' ? data.source : 'unknown',
          data,
        });

      return done(204);
    }

    return done(404);
  } catch (error) {
    write({ via: 'collector', source: 'collector', error: String(error) });

    return done(400);
  }
}).listen(PORT, () => {
  process.stdout.write(`collector on :${PORT}, writing to ${LOG_DIR}\n`);
});
