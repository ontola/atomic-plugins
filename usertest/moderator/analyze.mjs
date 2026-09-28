#!/usr/bin/env node
/**
 * Turns one finished session into anonymized findings, and (when a token is
 * configured) files them as issues in the private triage repo.
 *
 *   node analyze.mjs <session-id> [--file]     # in the moderator container
 *
 * server.mjs runs it when a session ends. It reads the session folder
 * (meta.json, transcript.jsonl and up to MAX_SHOTS of its screen-NNN.jpg),
 * asks Claude for findings, and writes findings.json and findings.md next to
 * them. With GITHUB_FINDINGS_TOKEN set (/etc/github-findings.env: a
 * fine-grained token with Issues read/write on GITHUB_FINDINGS_REPO only),
 * it files one issue per finding there. Nothing is ever filed in a public
 * repository: that takes Michiel's `approved` label and a person or Claude
 * session acting on it.
 *
 * Anonymized means: no tester name, email address, calendar or other
 * personal content, and no verbatim quotes longer than a few words. The
 * prompt asks for it and scrub() removes the tester's name and anything
 * shaped like an email address or a URL query before anything is written.
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSIONS_DIR = process.env.SESSIONS_DIR ?? '/sessions';
const MODEL = process.env.ANALYSIS_MODEL ?? 'claude-opus-5';
const REPO = process.env.GITHUB_FINDINGS_REPO ?? 'ontola/usertest-findings';
const MAX_SHOTS = 12;

const INSTRUCTIONS = `You analyze one remote usability test of Atomic (a personal data app) and its drive apps, plugins that import data from services like Google Calendar, GitHub, Notion and Clockify. A voice moderator (also Claude) ran the session; you get its transcript (speech-to-text, so expect recognition errors), the app's log lines each turn saw, and some screenshots of the tester's screen.

Find what should change. Two kinds:
- "app": a problem in Atomic or a drive app: confusion, a dead end, a wrong expectation, an error, missing feedback. Give "repo": "atomic-plugins" for a drive app (integrations/<plugin>/, the catalog) and "atomic-server" for the host (drive, navigation, Integrations page, settings, tables).
- "tooling": a problem with the test setup itself: the moderator, the voice, speech recognition, the session page. Give "repo": "tooling".

Only report what the session shows. One finding per distinct problem; merge repeats. Skip praise, and skip things that worked as intended.

Anonymize strictly. Never write the tester's name, email addresses, calendar names, event titles, or other personal content; say "the tester", "a calendar", "an event". Quote at most a few words at a time.

Reply with only a JSON array, no prose around it. Each element:
{"title": "<under 90 characters, says what is wrong>", "kind": "app" | "tooling", "repo": "atomic-plugins" | "atomic-server" | "tooling", "plugin": "<integrations folder, e.g. calendar, if any>", "severity": "blocker" | "major" | "minor", "happened": "<what the tester did and saw, 1-4 sentences>", "expected": "<what they expected or needed>", "evidence": ["<turn time hh:mm:ss, screenshot file name, or log line>", ...], "suggestion": "<a concrete improvement, 1-2 sentences>"}
Return [] if there is nothing to report.`;

function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/** The session as text the analyst can read. */
function transcriptText(entries) {
  const lines = [];

  for (const e of entries) {
    const time = e.t.slice(11, 19);
    if (e.role === 'tester') {
      if (e.log?.length) lines.push(`${time} [log] ${e.log.join(' | ')}`);
      lines.push(`${time} TESTER: ${e.said}`);
    } else if (e.role === 'moderator')
      lines.push(`${time} MODERATOR: ${e.say || '(stayed silent)'}`);
    else if (e.event) lines.push(`${time} (${e.event})`);
  }

  return lines.join('\n');
}

/** Evenly spread screenshots, at most MAX_SHOTS. */
function pickShots(dir) {
  const shots = readdirSync(dir)
    .filter(name => /^screen-\d+\.jpg$/.test(name))
    .sort();
  if (shots.length <= MAX_SHOTS) return shots;
  const step = shots.length / MAX_SHOTS;

  return Array.from(
    { length: MAX_SHOTS },
    (_, i) => shots[Math.floor(i * step)],
  );
}

export function scrub(text, name) {
  let out = String(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/(https?:\/\/[^\s?"]+)\?[^\s"]*/g, '$1');
  const first = String(name ?? '').trim();
  if (first.length >= 2)
    out = out.replace(
      new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'),
      'the tester',
    );

  return out;
}

function markdown(findings, meta) {
  const parts = [
    `# Findings: session ${meta.id}`,
    '',
    `Started ${meta.started}. ${findings.length} finding(s).`,
  ];

  for (const f of findings)
    parts.push('', `## ${f.title}`, '', issueBody(f, meta));

  return parts.join('\n') + '\n';
}

function issueBody(f, meta) {
  return [
    `**Where:** ${f.repo}${f.plugin ? ` (${f.plugin})` : ''} · **Severity:** ${f.severity} · **Kind:** ${f.kind}`,
    '',
    `**What happened:** ${f.happened}`,
    '',
    `**Expected:** ${f.expected}`,
    '',
    `**Suggestion:** ${f.suggestion}`,
    '',
    '**Evidence:**',
    ...(f.evidence ?? []).map(e => `- ${e}`),
    '',
    `Session \`${meta.id}\` (${meta.started.slice(0, 10)}), found by automatic analysis. The transcript, screenshots and recording stay on the droplet in \`/var/lib/usertest-sessions/${meta.id}/\`.`,
  ].join('\n');
}

export async function analyze(id, { client = new Anthropic() } = {}) {
  const dir = join(SESSIONS_DIR, id);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const entries = existsSync(join(dir, 'transcript.jsonl'))
    ? readJsonl(join(dir, 'transcript.jsonl'))
    : [];
  if (!entries.some(e => e.role === 'tester' && e.said !== '(silence)'))
    return [];

  const content = [];
  for (const name of pickShots(dir))
    content.push(
      { type: 'text', text: `Screenshot ${name}:` },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: readFileSync(join(dir, name)).toString('base64'),
        },
      },
    );
  content.push({
    type: 'text',
    text: `Session ${id}, started ${meta.started}. Transcript:\n\n${transcriptText(entries)}`,
  });

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high' },
    system: INSTRUCTIONS,
    messages: [{ role: 'user', content }],
  });

  const text =
    response.stop_reason === 'refusal'
      ? '[]'
      : response.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
          .trim();
  let findings;

  try {
    findings = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(findings)) throw new Error('not an array');
  } catch {
    // Keep what came back for a person to read; file nothing.
    writeFileSync(join(dir, 'findings.md'), scrub(text, meta.name) + '\n');
    throw new Error(`Session ${id}: the analysis was not a JSON array`);
  }

  findings = JSON.parse(scrub(JSON.stringify(findings), meta.name));
  writeFileSync(
    join(dir, 'findings.json'),
    JSON.stringify({ usage: response.usage, findings }, null, 2) + '\n',
  );
  writeFileSync(join(dir, 'findings.md'), markdown(findings, meta));

  return findings;
}

/** Files each finding as an issue in the private triage repo. */
export async function fileFindings(id, findings) {
  const token = process.env.GITHUB_FINDINGS_TOKEN;
  if (!token || !findings.length) return [];
  const meta = JSON.parse(
    readFileSync(join(SESSIONS_DIR, id, 'meta.json'), 'utf8'),
  );
  const urls = [];

  for (const f of findings) {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/issues`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: f.title,
          body: issueBody(f, meta),
          labels: [f.kind === 'tooling' ? 'tooling' : f.repo].filter(label =>
            ['tooling', 'atomic-plugins', 'atomic-server'].includes(label),
          ),
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Filing "${f.title}": GitHub answered ${response.status}`,
      );
    urls.push((await response.json()).html_url);
  }

  writeFileSync(
    join(SESSIONS_DIR, id, 'filed.json'),
    JSON.stringify(urls, null, 2) + '\n',
  );

  return urls;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, flag] = process.argv.slice(2);
  if (!id) throw new Error('usage: node analyze.mjs <session-id> [--file]');
  const findings = await analyze(id);
  process.stdout.write(`${findings.length} finding(s) in ${id}/findings.md\n`);
  if (flag === '--file')
    for (const url of await fileFindings(id, findings))
      process.stdout.write(`${url}\n`);
}
