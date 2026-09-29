// The tester's side of a moderated session: records screen and microphone,
// turns speech into text with the browser's recognizer, sends turns to the
// moderator (../moderator/server.mjs) and speaks its answers. Served at
// /usertest/ on the test instance, so it shares the data-browser's origin
// and can set the test catalog before opening the app. The tester picks the
// language at the top (i18n.js); switching changes this page, the speech
// recognizer, the voice and the moderator's language, also mid-session.
import { DEFAULT_LANG, LANGS, QUESTION, TEXT } from './i18n.js';

const API = '/usertest/api';
const CATALOG_URL = `https://catalog.${location.hostname.replace(/^plugins\./, '')}/catalog.json`;
/** Send a turn this long after the tester stops talking (a question sooner).
 * Chrome's recognizer adds no punctuation, so questions are recognized by
 * their words; the moderator answers [WAIT] when nothing needs saying. */
const PAUSE_AFTER_QUESTION = 2000;
const PAUSE_AFTER_SPEECH = 5000;
/** Screenshots sent with a turn: at most this wide, as JPEG. */
const SHOT_WIDTH = 1280;
/** Ask what's happening after this much silence. */
const SILENCE = 60000;

const $ = id => document.getElementById(id);
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
const params = new URLSearchParams(location.search);

function inviteCode() {
  const fromUrl = params.get('code');
  if (fromUrl) sessionStorage.setItem('usertest-code', fromUrl);

  return fromUrl ?? sessionStorage.getItem('usertest-code') ?? '';
}

const code = inviteCode();

/** Remembered per browser; `?lang=nl` (or nl-NL) in the link picks one. */
function initialLang() {
  const wanted = params.get('lang') ?? stored('usertest-lang');
  const match = LANGS.find(l => wanted && [l.code, l.short].includes(wanted));

  return match?.code ?? DEFAULT_LANG;
}

function stored(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice is not remembered.
  }

  return undefined;
}

let lang = initialLang();
const t = () => TEXT[lang];
/** What the status line and the error line show, as keys into TEXT, so a
 * language switch can redraw them. */
let statusKey = 'starting';
let errorText;
let session;
let recordingOn = false;
let recognition;
let recorder;
let speaking = false;
let ended = false;
let busy = false;
let heard = [];
let lastSpeech = Date.now();
let lastTurn = Date.now();
/** 'voice' by default; 'typed' when the microphone or the speech recognizer
 * is not available, so the session runs on the typed-answer box alone. */
let inputMode = 'voice';
let uploads = Promise.resolve();
/** Plays the shared screen off-screen, so a turn can grab a frame of it. */
let screenVideo;

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-usertest-code': code, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);

  return response.status === 204 ? {} : response.json();
}

function show(who, text, typed = false) {
  const p = document.createElement('p');
  if (who === 'me') p.className = 'me';
  p.textContent =
    who === 'me' ? `${typed ? t().youTyped : t().you}: ${text}` : text;
  $('log').prepend(p);
}

function status(key) {
  statusKey = key;
  $('status').textContent = t().status[key];
}

function showError(text) {
  errorText = text;
  $('error').textContent = text?.() ?? '';
  $('error').hidden = !text;
}

/** Puts every text on the page in the current language. */
function applyTexts() {
  const texts = t();
  const { short } = LANGS.find(l => l.code === lang);
  document.documentElement.lang = short;
  document.title = texts.title;
  for (const el of document.querySelectorAll('[data-text]'))
    el.textContent = texts[el.dataset.text];
  // Constants from i18n.js only.
  for (const el of document.querySelectorAll('[data-placeholder]'))
    el.placeholder = texts[el.dataset.placeholder];
  for (const el of document.querySelectorAll('[data-html]'))
    el.innerHTML = texts[el.dataset.html];
  $('langs').setAttribute('aria-label', texts.languageLabel);
  for (const button of $('langs').children)
    button.setAttribute('aria-pressed', String(button.value === lang));
  $('status').textContent = texts.status[statusKey];
  $('rec').textContent = recordingOn ? texts.recording : '';
  showError(errorText);
}

/** Switches everything to `code`: the page at once, the recognizer after a
 * restart, the voice from the next line on (a line being spoken finishes in
 * the old voice), and the moderator from its next turn. */
function setLang(code) {
  if (code === lang) return;
  lang = code;
  stored('usertest-lang', code);
  applyTexts();

  if (recognition) {
    recognition.lang = lang;
    // onend restarts it, now in the new language; words already recognized
    // stay in `heard`.
    recognition.abort();
  }

  if (session) {
    checkVoice();
    api(`/sessions/${session}/lang`, {
      method: 'POST',
      body: JSON.stringify({ lang }),
    }).catch(error => console.error(error));
  }
}

function renderLangs() {
  for (const { code: value, name, flag } of LANGS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.value = value;
    button.textContent = `${flag} ${name}`;
    button.addEventListener('click', () => setLang(value));
    $('langs').append(button);
  }
}

/** One voice per language for the whole session. Chrome fills getVoices()
 * only after `voiceschanged`, so without waiting the first line got the
 * default voice and later lines another one. */
const voices = new Map();

function pickVoice(code) {
  const all = speechSynthesis.getVoices();
  const norm = v => v.lang.replace('_', '-');
  const exact = all.filter(v => norm(v) === code);
  // nl-BE rather than an English voice reading Dutch.
  const near = all.filter(v => norm(v).split('-')[0] === code.split('-')[0]);

  for (const list of [exact, near]) {
    const found =
      list.find(v => /google/i.test(v.name)) ??
      list.find(v => v.localService) ??
      list[0];
    if (found) return found;
  }

  return undefined;
}

function voiceReady(code) {
  if (!voices.get(code)) voices.set(code, pickVoice(code));
  if (voices.get(code)) return Promise.resolve();

  return new Promise(resolve => {
    const done = () => {
      if (!voices.get(code)) voices.set(code, pickVoice(code));
      resolve();
    };

    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    // Some browsers never fire it; go on with the default voice.
    setTimeout(done, 2000);
  });
}

/** Says on the page when the browser has no voice for the language. */
async function checkVoice() {
  const code = lang;
  await voiceReady(code);
  if (code === lang) $('voice-note').hidden = !!voices.get(code);
}

async function speak(text) {
  const code = lang;
  await voiceReady(code);

  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = code;
    const voice = voices.get(code);
    if (voice) utterance.voice = voice;
    speaking = true;
    // The recognizer would otherwise hear the moderator (without headphones).
    recognition?.abort();

    utterance.onend = utterance.onerror = () => {
      speaking = false;
      listen();
      resolve();
    };

    speechSynthesis.speak(utterance);
  });
}

/** The shared screen as it is now: base64 JPEG, or undefined. */
function screenshot() {
  const video = screenVideo;
  if (!video?.videoWidth) return undefined;
  const scale = Math.min(1, SHOT_WIDTH / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
}

/** `typed`: the turn (or part of it) came from the typed-answer box. */
async function turn(said, typed = false) {
  if (busy || ended) return;
  busy = true;
  $('send').disabled = true;
  heard = [];
  $('heard').textContent = '';
  lastTurn = Date.now();
  if (said) show('me', said, typed);
  status('thinking');

  try {
    const { say, done } = await api(`/sessions/${session}/turn`, {
      method: 'POST',
      body: JSON.stringify({
        said,
        input: typed ? 'typed' : 'voice',
        screenshot: screenshot(),
      }),
    });

    if (say) {
      show('moderator', say);
      status('speaking');
      await speak(say);
    }

    if (done) return finish();
    status(inputMode === 'typed' ? 'yourTurn' : 'listening');
  } catch (error) {
    status('noAnswer');
    console.error(error);
  } finally {
    busy = false;
    $('send').disabled = ended;
  }
}

/** Sends the typed-answer box as a turn, with anything heard but not yet
 * sent in front of it. */
async function sendTyped() {
  const typed = $('typed').value.trim();
  if (!typed || busy || speaking || ended) return;
  const said = [...heard, typed].join(' ').trim();
  $('typed').value = '';
  await turn(said, true);
}

function listen() {
  if (ended || speaking || !recognition) return;

  try {
    recognition.start();
  } catch {
    // Already running.
  }
}

function setupRecognition() {
  recognition = new Recognition();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = event => {
    let interim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) heard.push(text);
      else interim += text;
    }

    lastSpeech = Date.now();
    $('heard').textContent = [...heard, interim].join(' ');
  };

  // Chrome stops after a while of silence; keep listening until the end.
  recognition.onend = () => listen();

  recognition.onerror = event => {
    if (
      ['not-allowed', 'audio-capture', 'service-not-allowed'].includes(
        event.error,
      )
    ) {
      status('micTyping');
      useTyping();
    }
  };

  listen();
}

/** Switches the session to typed answers: the recognizer stops trying. */
function useTyping() {
  inputMode = 'typed';
  recognition?.abort();
  recognition = undefined;
  $('ask-row').hidden = true;
  $('typed').focus();
}

/** Decides when to hand the conversation to the moderator. */
function tick() {
  if (ended || busy || speaking) return;
  const now = Date.now();
  const text = heard.join(' ').trim();

  if (text) {
    const wait = QUESTION[lang].test(heard.at(-1) ?? '')
      ? PAUSE_AFTER_QUESTION
      : PAUSE_AFTER_SPEECH;
    if (now - lastSpeech > wait) turn(text);
  } else if (now - Math.max(lastSpeech, lastTurn) > SILENCE) turn('');
}

async function checkNews() {
  if (ended || busy || speaking) return;

  try {
    const { errors } = await api(`/sessions/${session}/news`);
    if (errors && Date.now() - lastSpeech > 4000) turn(heard.join(' ').trim());
  } catch {
    // Next time.
  }
}

/** Asks for the screen and the microphone. Without a microphone (none,
 * broken or refused) the session goes on with typed answers and a
 * screen-only recording. */
async function getMedia() {
  const screen = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 5 },
    audio: false,
  });
  const mic = await navigator.mediaDevices
    .getUserMedia({ audio: true })
    .catch(error => {
      console.error(error);
      return undefined;
    });
  if (!mic) inputMode = 'typed';

  return { screen, mic };
}

/** Records the media from getMedia() into the session. */
async function startRecording({ screen, mic }) {
  const stream = new MediaStream([
    ...screen.getVideoTracks(),
    ...(mic?.getAudioTracks() ?? []),
  ]);
  const type = [
    mic ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9',
    'video/webm',
  ].find(t => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : {});

  recorder.ondataavailable = event => {
    if (!event.data.size) return;
    // In order, one chunk at a time: the server appends them to one file.
    uploads = uploads.then(() =>
      api(`/sessions/${session}/recording`, {
        method: 'POST',
        body: event.data,
      }).catch(error => console.error(error)),
    );
  };

  recorder.start(10000);
  screenVideo = document.createElement('video');
  screenVideo.muted = true;
  screenVideo.srcObject = new MediaStream(screen.getVideoTracks());
  await screenVideo.play();
  recordingOn = true;
  $('rec').textContent = t().recording;
  // Stopping the share from the browser's bar ends the session.
  screen.getVideoTracks()[0].addEventListener('ended', () => finish());
}

async function finish() {
  if (ended) return;
  ended = true;
  recognition?.abort();
  speechSynthesis.cancel();
  if (recorder?.state === 'recording') recorder.stop();
  recorder?.stream.getTracks().forEach(track => track.stop());
  status('saving');
  // Let the last chunk arrive before saying goodbye.
  await new Promise(resolve => setTimeout(resolve, 500));
  await uploads;
  await api(`/sessions/${session}/end`, { method: 'POST' }).catch(() => {});
  recordingOn = false;
  $('rec').textContent = '';
  status('ended');
  $('end').hidden = true;
  $('typed-form').hidden = true;
}

async function start() {
  showError(undefined);
  $('start').disabled = true;
  // The data-browser reads the catalog URL from this origin's storage.
  localStorage.setItem('plugin-catalog-url', CATALOG_URL);
  const width = Math.round(screen.availWidth * 0.62);
  const app = window.open(
    '/app/dev-drive',
    'atomic-usertest-app',
    `popup,width=${width},height=${screen.availHeight},left=${screen.availWidth - width},top=0`,
  );

  if (!Recognition) inputMode = 'typed';
  let media;

  try {
    media = await getMedia();
    ({ id: session } = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: $('name').value,
        lang,
        // How the session starts; the tester can type at any time anyway.
        input: inputMode,
        // Which session plan (moderator/sessions/<name>.md); none = calendar.
        session: params.get('session') ?? undefined,
      }),
    }));
    await startRecording(media);
  } catch (error) {
    app?.close();
    media?.screen.getTracks().forEach(track => track.stop());
    media?.mic?.getTracks().forEach(track => track.stop());
    showError(
      error.name === 'NotAllowedError'
        ? () => t().errors.notAllowed
        : () => t().errors.cannotStart(error.message),
    );
    $('start').disabled = false;

    return;
  }

  $('intro').hidden = true;
  $('consent').hidden = true;
  $('session').hidden = false;
  checkVoice();
  if (inputMode === 'voice') setupRecognition();
  else useTyping();
  setInterval(tick, 1000);
  setInterval(checkNews, 5000);
  turn('');
}

renderLangs();
applyTexts();
if (!Recognition) $('unsupported').hidden = false;
if (!code) showError(() => t().errors.noCode);

$('agree').addEventListener('change', () => {
  $('start').disabled = !$('agree').checked || !code;
});
$('start').addEventListener('click', start);
$('end').addEventListener('click', () => finish());
// Hands over at once, with whatever was heard so far.
$('ask').addEventListener('click', () => {
  if (!speaking) turn(heard.join(' ').trim());
});
$('typed-form').addEventListener('submit', event => {
  event.preventDefault();
  sendTyped();
});
$('typed').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendTyped();
  }
});
// Typing counts as talking: no "what are you doing?" while a tester types.
$('typed').addEventListener('input', () => {
  lastSpeech = Date.now();
});
