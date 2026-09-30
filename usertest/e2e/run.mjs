#!/usr/bin/env node
// Headless checks of the session page (../page/): the sound check and the
// separate start errors, in English and Dutch. Self-contained: it runs
// ../moderator/server.mjs with a dummy invite code and key against a local
// stand-in for the Claude API, serves the page the way Caddy does
// (/usertest/ and /usertest/api/), and drives headless Chromium with fake
// media devices or with permissions denied. Nothing opens a visible browser
// or asks a real permission prompt.
//
//   npm ci --prefix usertest/moderator
//   npm ci --prefix usertest/e2e && npx --prefix usertest/e2e playwright install chromium
//   node usertest/e2e/run.mjs
//
// Not covered, as headless Chromium cannot do it: real speech recognition
// (the optional speech check), whether the speaker test is audible, and the
// browser's own permission prompts.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(here, '..', 'page');
const MODERATOR = join(here, '..', 'moderator', 'server.mjs');
const CODE = 'e2e-invite-code-0001';
const STUB_LINE = 'Hello from the stub moderator.';
const { TEXT } = await import('../page/i18n.js');
const EN = TEXT['en-US'];
const NL = TEXT['nl-NL'];

const listen = server =>
  new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );

// The Claude API, as far as server.mjs uses it: every message gets one line.
const claude = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_e2e',
        type: 'message',
        role: 'assistant',
        model: 'stub',
        content: [{ type: 'text', text: STUB_LINE }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
});
const claudePort = await listen(claude);

const dataDir = mkdtempSync(join(tmpdir(), 'usertest-e2e-'));
// A free port for the moderator: taken, then released for it.
const probe = createServer();
const moderatorTarget = await listen(probe);
await new Promise(resolve => probe.close(resolve));
const moderator = spawn(process.execPath, [MODERATOR], {
  env: {
    ...process.env,
    PORT: String(moderatorTarget),
    USERTEST_CODE: CODE,
    USERTEST_SALT: 'e2e-salt',
    ANTHROPIC_API_KEY: 'sk-ant-e2e-dummy',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${claudePort}`,
    SESSIONS_DIR: join(dataDir, 'sessions'),
    LOG_DIR: join(dataDir, 'logs'),
    GITHUB_FINDINGS_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let moderatorLog = '';
moderator.stdout.on('data', d => (moderatorLog += d));
moderator.stderr.on('data', d => (moderatorLog += d));
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`moderator did not start:\n${moderatorLog}`)),
    10000,
  );
  moderator.stdout.on('data', () => {
    if (moderatorLog.includes('moderator on')) {
      clearTimeout(timer);
      resolve();
    }
  });
  moderator.on('exit', code =>
    reject(new Error(`moderator exited ${code}:\n${moderatorLog}`)),
  );
});

// Caddy's part: the page at /usertest/, the moderator at /usertest/api/
// (prefix stripped). `moderatorDown` answers 502, as Caddy does when the
// moderator is not running.
let moderatorDown = false;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };
const front = createServer((req, res) => {
  const url = new URL(req.url, 'http://front');

  if (url.pathname.startsWith('/usertest/api/')) {
    if (moderatorDown) {
      res.writeHead(502);
      return res.end();
    }
    const upstream = request(
      {
        host: '127.0.0.1',
        port: moderatorTarget,
        method: req.method,
        path: url.pathname.slice('/usertest/api'.length) + url.search,
        headers: req.headers,
      },
      reply => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    return req.pipe(upstream);
  }

  if (url.pathname.startsWith('/usertest/')) {
    const file = normalize(
      url.pathname.slice('/usertest/'.length) || 'index.html',
    );
    if (file.startsWith('..')) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const body = readFileSync(join(PAGE_DIR, file));
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'text/plain',
      });
      return res.end(body);
    } catch {
      res.writeHead(404);
      return res.end();
    }
  }

  // The data-browser's drive popup.
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>drive</title>');
});
const frontPort = await listen(front);
const BASE = `http://localhost:${frontPort}/usertest/`;

// Chromium's new headless mode (channel 'chromium'): the old headless shell
// answers every getUserMedia with NotSupportedError, which no real browser
// gives a tester. With fake UI it grants the microphone and shares a fake
// screen without a prompt. Without it, a microphone the context was not
// granted is denied with NotAllowedError, as when a tester clicks Block.
// Screen sharing cannot be denied headlessly (the picker just waits), so
// that test makes getDisplayMedia reject the way a cancelled picker does.
// CHROMIUM_PATH: a Chromium other than the one this Playwright downloads.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const fakeUi = await chromium.launch({
  channel: 'chromium',
  executablePath,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const denying = await chromium.launch({
  channel: 'chromium',
  executablePath,
  args: ['--use-fake-device-for-media-stream', '--deny-permission-prompts'],
});

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push([name, 'ok']);
    process.stdout.write(`ok    ${name}\n`);
  } catch (error) {
    results.push([name, 'FAIL']);
    process.stdout.write(
      `FAIL  ${name}\n      ${error.message.split('\n').join('\n      ')}\n`,
    );
  }
}

async function open(browser, query, { permissions = [], init } = {}) {
  const context = await browser.newContext({ permissions });
  if (Array.isArray(init)) await context.addInitScript(...init);
  else if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.goto(`${BASE}?${query}`);
  return { page, close: () => context.close() };
}

/** What Chrome's getDisplayMedia does when the tester cancels the picker. */
function cancelScreen() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    throw new DOMException('Permission denied', 'NotAllowedError');
  };
}

const text = (page, selector) => page.locator(selector).innerText();

async function expectText(page, selector, wanted, timeout = 5000) {
  const locator = page.locator(selector);
  const deadline = Date.now() + timeout;
  let got;
  while (Date.now() < deadline) {
    got = (await locator.isVisible()) ? await locator.innerText() : '(hidden)';
    if (got.trim() === wanted.trim()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`${selector}: expected\n  ${wanted}\ngot\n  ${got}`);
}

async function expectNotCodeMessage(page, texts = EN) {
  const error = (await page.locator('#error').isVisible())
    ? await text(page, '#error')
    : '';
  if ([texts.errors.wrongCode, texts.errors.noCode].includes(error.trim()))
    throw new Error(`#error shows a code message: ${error}`);
}

await check(
  'happy path: fake mic moves the meter, Start enables, session starts',
  async () => {
    const { page, close } = await open(fakeUi, `code=${CODE}`, {
      permissions: ['microphone'],
    });
    if (!(await page.locator('#start').isDisabled()))
      throw new Error('Start enabled before the check');
    await page.check('#agree');
    if (!(await page.locator('#start').isDisabled()))
      throw new Error('Start enabled before the mic check');
    await expectText(page, '#need-check', EN.check.needCheck);
    await page.click('#mic-test');
    await expectText(page, '#mic-status', EN.check.micOk, 8000);
    const level = Number(
      await page.locator('#level').getAttribute('aria-valuenow'),
    );
    // The fake device beeps; between beeps the level can be 0, so the pass
    // (which needs readings >= HEARD_LEVEL) is the evidence that it moved.
    process.stdout.write(`      meter reading at pass check: ${level}\n`);
    if (await page.locator('#start').isDisabled())
      throw new Error('Start still disabled after the mic check passed');
    await page.click('#start');
    await expectText(page, '#log p', STUB_LINE, 10000);
    if (!(await page.locator('#check').isHidden()))
      throw new Error('check still shown');
    await close();
  },
);

await check('type instead enables Start without a mic check', async () => {
  const { page, close } = await open(denying, `code=${CODE}`);
  await page.check('#agree');
  await page.click('#type-instead');
  await expectText(page, '#mic-status', EN.check.typedChosen);
  if (await page.locator('#start').isDisabled())
    throw new Error('Start disabled');
  await close();
});

await check(
  'mic permission denied: mic-denied message, not the code message',
  async () => {
    const { page, close } = await open(denying, `code=${CODE}`);
    await page.check('#agree');
    await page.click('#mic-test');
    await expectText(page, '#mic-error', EN.errors.micDenied);
    await expectNotCodeMessage(page);
    if (!(await page.locator('#start').isDisabled()))
      throw new Error('Start enabled');
    await close();
  },
);

await check('no microphone device listed: no-mic message', async () => {
  const { page, close } = await open(fakeUi, `code=${CODE}`, {
    permissions: ['microphone'],
    init: () => {
      navigator.mediaDevices.enumerateDevices = async () => [
        { kind: 'videoinput', deviceId: '', label: '', groupId: '' },
      ];
    },
  });
  await page.click('#mic-test');
  await expectText(page, '#mic-error', EN.errors.noMic);
  await close();
});

await check('getUserMedia NotFoundError: no-mic message', async () => {
  const { page, close } = await open(fakeUi, `code=${CODE}`, {
    permissions: ['microphone'],
    init: () => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Requested device not found', 'NotFoundError');
      };
    },
  });
  await page.click('#mic-test');
  await expectText(page, '#mic-error', EN.errors.noMic);
  await close();
});

await check(
  'no speech recognition: unsupported message, typing possible',
  async () => {
    const { page, close } = await open(fakeUi, `code=${CODE}`, {
      init: () => {
        delete window.SpeechRecognition;
        delete window.webkitSpeechRecognition;
      },
    });
    await expectText(page, '#speech-status', EN.errors.speechUnsupported);
    await close();
  },
);

await check(
  'screen share denied: screen message, not the code message',
  async () => {
    // A real microphone check; the screen picker cancelled.
    const { page, close } = await open(fakeUi, `code=${CODE}`, {
      permissions: ['microphone'],
      init: cancelScreen,
    });
    await page.check('#agree');
    await page.click('#mic-test');
    await expectText(page, '#mic-status', EN.check.micOk, 8000);
    await page.click('#start');
    await expectText(page, '#error', EN.errors.screenCancelled);
    if (await page.locator('#start').isDisabled())
      throw new Error('Start not re-enabled');
    await close();
  },
);

await check(
  'wrong code (moderator 403): code message on load, Start stays off',
  async () => {
    const { page, close } = await open(fakeUi, 'code=not-the-code', {
      permissions: ['microphone'],
    });
    await expectText(page, '#error', EN.errors.wrongCode);
    await page.check('#agree');
    await page.click('#type-instead');
    if (!(await page.locator('#start').isDisabled()))
      throw new Error('Start enabled');
    await close();
  },
);

await check('missing code: the separate no-code message', async () => {
  const { page, close } = await open(fakeUi, '');
  await expectText(page, '#error', EN.errors.noCode);
  await close();
});

await check(
  'unknown session plan (moderator 400): bad-link message',
  async () => {
    const { page, close } = await open(fakeUi, `code=${CODE}&session=nope`, {
      permissions: ['microphone'],
    });
    await page.check('#agree');
    await page.click('#type-instead');
    await page.click('#start');
    await expectText(page, '#error', EN.errors.badLink);
    await close();
  },
);

await check('moderator down (502): network message with retry', async () => {
  moderatorDown = true;
  try {
    const { page, close } = await open(fakeUi, `code=${CODE}`, {
      permissions: ['microphone'],
    });
    await expectText(page, '#error', EN.errors.network);
    if (!(await page.locator('#retry').isVisible()))
      throw new Error('no retry button');
    await page.check('#agree');
    await page.click('#type-instead');
    if (await page.locator('#start').isDisabled())
      throw new Error('Start disabled while the moderator is only unreachable');
    await page.click('#start');
    await expectText(page, '#error', EN.errors.network);
    await expectNotCodeMessage(page);
    // Back up: Try again clears the message.
    moderatorDown = false;
    await page.click('#retry');
    await expectText(page, '#log p', STUB_LINE, 10000);
    await close();
  } finally {
    moderatorDown = false;
  }
});

await check('no answer at all (fetch fails): network message', async () => {
  const context = await fakeUi.newContext();
  await context.route('**/usertest/api/**', route => route.abort());
  const page = await context.newPage();
  await page.goto(`${BASE}?code=${CODE}`);
  await expectText(page, '#error', EN.errors.network);
  await context.close();
});

await check(
  'Dutch: texts, mic denied and wrong code in Nederlands',
  async () => {
    const denied = await open(denying, `code=${CODE}&lang=nl`);
    await expectText(denied.page, '#check h2', NL.check.heading);
    await expectText(denied.page, '#mic-test', NL.check.micButton);
    await expectText(denied.page, '#need-check', NL.check.needCheck);
    await denied.page.click('#mic-test');
    await expectText(denied.page, '#mic-error', NL.errors.micDenied);
    // Switching language redraws the message.
    await denied.page.click('#langs button[value="en-US"]');
    await expectText(denied.page, '#mic-error', EN.errors.micDenied);
    await denied.close();

    const wrong = await open(fakeUi, 'code=not-the-code&lang=nl');
    await expectText(wrong.page, '#error', NL.errors.wrongCode);
    await wrong.close();

    const screen = await open(fakeUi, `code=${CODE}&lang=nl`, {
      init: cancelScreen,
    });
    await screen.page.check('#agree');
    await screen.page.click('#type-instead');
    await expectText(screen.page, '#mic-status', NL.check.typedChosen);
    await screen.page.click('#start');
    await expectText(screen.page, '#error', NL.errors.screenCancelled);
    await screen.close();
  },
);

// Voices: a stubbed speechSynthesis with the kinds of lists browsers give.
// Chrome returns [] at first and fills the list on `voiceschanged`, so the
// stub does the same after 300 ms. Utterances are recorded, not played.
const VOICES = [
  { name: 'eSpeak English', lang: 'en-US', localService: true },
  { name: 'Fred', lang: 'en-US', localService: true },
  { name: 'Albert', lang: 'en-US', localService: true },
  { name: 'Samantha', lang: 'en-US', localService: true },
  { name: 'Google US English', lang: 'en-US', localService: false },
  {
    name: 'Microsoft Aria Online (Natural) - English (United States)',
    lang: 'en-US',
    localService: false,
  },
  { name: 'Daniel', lang: 'en-GB', localService: true },
  { name: 'eSpeak Dutch', lang: 'nl', localService: true },
  { name: 'Ellen (Enhanced)', lang: 'nl-BE', localService: true },
  { name: 'Xander', lang: 'nl_NL', localService: true },
  { name: 'Google Nederlands', lang: 'nl-NL', localService: false },
];

function stubVoices(list) {
  window.__spoken = [];
  let loaded = [];
  speechSynthesis.getVoices = () => loaded;
  speechSynthesis.cancel = () => {};
  speechSynthesis.speak = utterance => {
    window.__spoken.push({
      text: utterance.text,
      lang: utterance.lang,
      voice: utterance.voice?.name,
      rate: utterance.rate,
      pitch: utterance.pitch,
    });
    setTimeout(() => utterance.onend?.(), 10);
  };
  // The real one only takes a real SpeechSynthesisVoice.
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  setTimeout(() => {
    loaded = list;
    speechSynthesis.dispatchEvent(new Event('voiceschanged'));
  }, 300);
}

const { rankVoices, goodEnough } = await import('../page/voices.js');
const names = list => list.map(v => v.name);

await check(
  'voice ranking: best first, robotic and other languages never',
  async () => {
    const en = names(rankVoices(VOICES, 'en-US'));
    const wantEn = [
      'Microsoft Aria Online (Natural) - English (United States)',
      'Google US English',
      'Samantha',
      'Daniel',
    ];
    if (JSON.stringify(en) !== JSON.stringify(wantEn))
      throw new Error(`en-US: ${JSON.stringify(en)}`);
    const nl = names(rankVoices(VOICES, 'nl-NL'));
    const wantNl = ['Google Nederlands', 'Xander', 'Ellen (Enhanced)'];
    if (JSON.stringify(nl) !== JSON.stringify(wantNl))
      throw new Error(`nl-NL: ${JSON.stringify(nl)}`);
    // nl-NL beats a better nl-BE voice; nl-BE beats reading Dutch in English.
    const noGoogle = VOICES.filter(v => v.name !== 'Google Nederlands');
    if (rankVoices(noGoogle, 'nl-NL')[0].name !== 'Xander')
      throw new Error('nl-BE picked over nl-NL');
    const beOnly = VOICES.filter(v => !/Xander|Google Nederlands/.test(v.name));
    if (rankVoices(beOnly, 'nl-NL')[0].name !== 'Ellen (Enhanced)')
      throw new Error('no nl-BE fallback');
    const robotsOnly = VOICES.filter(v => /eSpeak|Fred|Albert/.test(v.name));
    if (
      rankVoices(robotsOnly, 'en-US').length ||
      rankVoices(robotsOnly, 'nl-NL').length
    )
      throw new Error('a robotic voice was offered');
    if (goodEnough(VOICES[3], 'en-US') || !goodEnough(VOICES[4], 'en-US'))
      throw new Error('goodEnough: plain local voice should wait for more');
  },
);

const spoken = page => page.evaluate(() => window.__spoken);

await check(
  'voices load late: the speaker test waits and uses the best voice; the picker switches it',
  async () => {
    const { page, close } = await open(fakeUi, `code=${CODE}`, {
      init: [stubVoices, VOICES],
    });
    // Clicked before the voices arrive: it must wait, not use the default.
    await page.click('#speaker-test');
    const best = 'Microsoft Aria Online (Natural) - English (United States)';
    await expectText(page, '#speaker-status', EN.check.speakerHint(best));
    let lines = await spoken(page);
    if (lines.length !== 1 || lines[0].voice !== best)
      throw new Error(`spoken: ${JSON.stringify(lines)}`);
    if (
      lines[0].rate !== 1 ||
      lines[0].pitch !== 1 ||
      lines[0].lang !== 'en-US'
    )
      throw new Error(`rate/pitch/lang: ${JSON.stringify(lines[0])}`);

    await expectText(page, 'label[for="voice-select"]', EN.check.voiceLabel);
    const offered = await page.locator('#voice-select option').allInnerTexts();
    if (
      offered.some(o => /eSpeak|Fred|Albert|Xander/.test(o)) ||
      offered.length !== 4
    )
      throw new Error(`offered: ${JSON.stringify(offered)}`);
    if ((await page.locator('#voice-select').inputValue()) !== best)
      throw new Error('picker does not show the chosen voice');

    await page.selectOption('#voice-select', 'Samantha');
    await page.click('#voice-try');
    await expectText(page, '#speaker-status', EN.check.speakerHint('Samantha'));
    lines = await spoken(page);
    if (lines.at(-1).voice !== 'Samantha')
      throw new Error(`after switching: ${JSON.stringify(lines.at(-1))}`);

    // Remembered for the session: a reload keeps it.
    await page.reload();
    await page.click('#speaker-test');
    await expectText(page, '#speaker-status', EN.check.speakerHint('Samantha'));
    if ((await page.locator('#voice-select').inputValue()) !== 'Samantha')
      throw new Error('choice not remembered after reload');
    await close();
  },
);

await check('Dutch: an nl-NL voice, never an English one', async () => {
  const { page, close } = await open(fakeUi, `code=${CODE}&lang=nl`, {
    init: [stubVoices, VOICES],
  });
  await page.click('#speaker-test');
  await expectText(
    page,
    '#speaker-status',
    NL.check.speakerHint('Google Nederlands'),
  );
  const [line] = await spoken(page);
  if (line.voice !== 'Google Nederlands' || line.lang !== 'nl-NL')
    throw new Error(`spoken: ${JSON.stringify(line)}`);
  await expectText(page, '#voice-try', NL.check.voiceTry);
  // Switching language switches the list and the voice.
  await page.click('#langs button[value="en-US"]');
  await page.waitForFunction(() =>
    document.querySelector('#voice-select').value.startsWith('Microsoft Aria'),
  );
  await close();
});

await check('no voices at all: default voice, picker hidden', async () => {
  const { page, close } = await open(fakeUi, `code=${CODE}`, {
    init: [stubVoices, []],
  });
  await page.click('#speaker-test');
  await expectText(
    page,
    '#speaker-status',
    `${EN.check.speakerHint(EN.check.defaultVoice)} ${EN.noVoice}`,
    8000,
  );
  if (!(await page.locator('#voice-row').isHidden()))
    throw new Error('picker shown without voices');
  await close();
});

await fakeUi.close();
await denying.close();
moderator.kill();
claude.close();
front.close();
rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter(([, r]) => r !== 'ok').length;
process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
