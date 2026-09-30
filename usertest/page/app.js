// The tester's side of a moderated session: records screen and microphone,
// turns speech into text with the browser's recognizer, sends turns to the
// moderator (../moderator/server.mjs) and speaks its answers. Served at
// /usertest/ on the test instance, so it shares the data-browser's origin
// and can set the test catalog before opening the app. The tester picks the
// language at the top (i18n.js); switching changes this page, the speech
// recognizer, the voice and the moderator's language, also mid-session.
import { DEFAULT_LANG, LANGS, QUESTION, TEXT } from './i18n.js';
import { goodEnough, rankVoices } from './voices.js';

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
/** The sound check's meter, 0-100: RMS 0.25 fills it. The check passes after
 * a few readings (50 ms apart) at or above HEARD_LEVEL. */
const METER_GAIN = 400;
const HEARD_LEVEL = 8;
const HEARD_READINGS = 3;

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
/** Message lines by element id, as functions of the current language, so a
 * language switch can redraw them (see message()). */
const messages = new Map();
/** What the retry button next to the error does, if it shows. */
let retryAction;
/** The invite code was rejected by the moderator (403). */
let codeRejected = false;
let starting = false;
/** Sound check: the microphone it opened (reused for the recording), whether
 * the meter heard the tester, and whether they chose to type instead. */
let micStream;
let micOk = false;
let typedChosen = false;
let meter;
let checkRecognition;
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

/** A failed moderator call. `status` is the HTTP status, or 0 when the
 * request got no answer at all (offline, DNS, connection refused). The
 * moderator answers 403 for a wrong or missing invite code and for nothing
 * else; Caddy answers 502 when the moderator is down. */
class ApiError extends Error {
  constructor(path, status, reason = String(status)) {
    super(`${path}: ${reason}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function api(path, init = {}) {
  let response;

  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: { 'x-usertest-code': code, ...(init.headers ?? {}) },
    });
  } catch (error) {
    throw new ApiError(path, 0, error.message);
  }

  if (!response.ok) throw new ApiError(path, response.status);

  return response.status === 204 ? {} : response.json();
}

/** The message for a failed moderator call, and whether retrying may help.
 * Only a 403 is reported as an invite-code problem. */
function apiErrorText(error) {
  const { status } = error;
  if (status === 403)
    return { text: () => (code ? t().errors.wrongCode : t().errors.noCode) };
  if (status === 400) return { text: () => t().errors.badLink };
  if (status === 429) return { text: () => t().errors.tooMany };
  if (status === 0 || status >= 500)
    return { text: () => t().errors.network, retry: true };

  return { text: () => t().errors.cannotStart(error.message) };
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

/** Shows `text` (a function of the language, or undefined to clear) in the
 * element `id`; a `.warn` element hides when there is nothing to say. */
function message(id, text) {
  messages.set(id, text);
  const el = $(id);
  el.textContent = text?.() ?? '';
  if (el.classList.contains('warn')) el.hidden = !text;
}

/** The error line under Start; with `retry`, a Try again button runs it. */
function showError(text, retry) {
  message('error', text);
  retryAction = text && retry;
  $('retry').hidden = !retryAction;
}

/** Start needs consent, an accepted invite code, and a passed microphone
 * check or the choice to type. */
function updateStart() {
  const ready = micOk || typedChosen;
  $('need-check').hidden = ready;
  $('start').disabled =
    starting || !$('agree').checked || !code || codeRejected || !ready;
}

/** Puts every text on the page in the current language. */
function applyTexts() {
  const texts = t();
  const { short } = LANGS.find(l => l.code === lang);
  document.documentElement.lang = short;
  document.title = texts.title;
  // `check.heading` is texts.check.heading.
  for (const el of document.querySelectorAll('[data-text]'))
    el.textContent = el.dataset.text
      .split('.')
      .reduce((value, key) => value?.[key], texts);
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
  for (const [id, text] of messages) message(id, text);
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

  voiceReady(code).then(() => {
    if (code === lang) renderVoicePicker();
  });

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

/** One voice per language for the whole session: the best one by
 * voices.js's ranking, or the one the tester picked in the sound check
 * (remembered for the browser session). Chrome and Edge fill getVoices()
 * only after `voiceschanged`, and may add their network voices later still,
 * so without waiting the first line got the default voice. */
const voices = new Map();
/** Waited for at most this long, then the best voice so far (or the
 * browser's default) is used. */
const VOICE_WAIT = 3000;
const VOICE_KEY = code => `usertest-voice-${code}`;

function chosenVoice(code, all) {
  let name;
  try {
    name = sessionStorage.getItem(VOICE_KEY(code));
  } catch {
    // Storage blocked: the pick lasts until the page reloads.
  }

  return name ? all.find(v => v.name === name) : undefined;
}

function pickVoice(code) {
  const all = speechSynthesis.getVoices();

  return chosenVoice(code, all) ?? rankVoices(all, code)[0];
}

/** Voices can arrive after the first pick: take a better one for the next
 * line, unless the tester picked one. */
speechSynthesis.addEventListener?.('voiceschanged', () => {
  for (const code of voices.keys()) voices.set(code, pickVoice(code));
  renderVoicePicker();
  checkVoice();
});

function voiceReady(code) {
  voices.set(code, pickVoice(code));
  const all = speechSynthesis.getVoices();
  if (goodEnough(voices.get(code), code) || chosenVoice(code, all))
    return Promise.resolve();

  return new Promise(resolve => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener('voiceschanged', done);
      voices.set(code, pickVoice(code));
      resolve();
    };

    speechSynthesis.addEventListener('voiceschanged', done);
    // Some browsers never fire it; go on with the best voice so far.
    timer = setTimeout(done, VOICE_WAIT);
  });
}

/** Says on the page when the browser has no voice for the language. */
async function checkVoice() {
  const code = lang;
  await voiceReady(code);
  if (code === lang) $('voice-note').hidden = !!voices.get(code);
}

/** An utterance of `text` in the voice for `code`, at the normal rate and
 * pitch (some browsers remember a changed one). */
function utter(text, code) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = code;
  utterance.rate = 1;
  utterance.pitch = 1;
  const voice = voices.get(code);
  if (voice) utterance.voice = voice;

  return utterance;
}

async function speak(text) {
  const code = lang;
  await voiceReady(code);

  return new Promise(resolve => {
    const utterance = utter(text, code);
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

/** getDisplayMedia failed; `cause` is its error. */
class ScreenError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
    this.name = 'ScreenError';
  }
}

/** Asks for the screen, and takes the microphone the sound check opened
 * (asked again only if it stopped since). Without a microphone (the tester
 * chose to type, or it broke) the session goes on with typed answers and a
 * screen-only recording. */
async function getMedia() {
  const screen = await navigator.mediaDevices
    .getDisplayMedia({ video: { frameRate: 5 }, audio: false })
    .catch(error => {
      throw new ScreenError(error);
    });
  let mic;

  if (micOk) {
    mic = micStream?.getAudioTracks().some(track => track.readyState === 'live')
      ? micStream
      : await navigator.mediaDevices
          .getUserMedia({ audio: true })
          .catch(error => {
            console.error(error);
            return undefined;
          });
  }

  if (!mic) inputMode = 'typed';

  return { screen, mic };
}

/** What to say when start() failed, and whether retrying may help. A mic
 * or screen failure is never reported as an invite-code problem. */
function startErrorText(error) {
  if (error instanceof ScreenError)
    return {
      text:
        error.cause.name === 'NotAllowedError'
          ? () => t().errors.screenCancelled
          : () => t().errors.screenFailed(error.cause.name || error.message),
    };
  if (error instanceof ApiError) return apiErrorText(error);

  return { text: () => t().errors.cannotStart(error.message) };
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
  if (starting) return;
  showError(undefined);
  starting = true;
  updateStart();
  // The data-browser reads the catalog URL from this origin's storage.
  localStorage.setItem('plugin-catalog-url', CATALOG_URL);
  const width = Math.round(screen.availWidth * 0.62);
  const app = window.open(
    '/app/dev-drive',
    'atomic-usertest-app',
    `popup,width=${width},height=${screen.availHeight},left=${screen.availWidth - width},top=0`,
  );

  if (!Recognition || typedChosen) inputMode = 'typed';
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
    console.error(error);
    app?.close();
    media?.screen.getTracks().forEach(track => track.stop());
    // The sound check's microphone stays open for the next try.
    const { text, retry } = startErrorText(error);
    if (error instanceof ApiError && error.status === 403) codeRejected = true;
    starting = false;
    updateStart();
    showError(text, retry ? start : undefined);

    return;
  }

  stopCheck();
  $('intro').hidden = true;
  $('consent').hidden = true;
  $('check').hidden = true;
  $('go').hidden = true;
  $('session').hidden = false;
  checkVoice();
  if (inputMode === 'voice') setupRecognition();
  else useTyping();
  setInterval(tick, 1000);
  setInterval(checkNews, 5000);
  turn('');
}

/** Tests the invite code as soon as the page loads, so a wrong one is
 * reported before the tester does anything else. */
async function checkCode() {
  if (!code) return;

  try {
    await api('/check');
    showError(undefined);
  } catch (error) {
    // A moderator from before /check existed: the code gets tested at Start.
    if (error.status === 404) return;
    console.error(error);
    const { text, retry } = apiErrorText(error);
    if (error.status === 403) codeRejected = true;
    showError(text, retry ? checkCode : undefined);
    updateStart();
  }
}

/** The message for a getUserMedia failure. */
function micErrorText(error) {
  if (['NotAllowedError', 'SecurityError'].includes(error.name))
    return () => t().errors.micDenied;
  if (['NotFoundError', 'OverconstrainedError'].includes(error.name))
    return () => t().errors.noMic;

  return () => t().errors.micOther(error.name || error.message);
}

/** Opens the microphone and shows its level; passes once it hears the
 * tester. Nothing is recorded or sent. */
async function testMic() {
  message('mic-error', undefined);
  if (!navigator.mediaDevices?.getUserMedia)
    return message('mic-error', () => t().errors.noMic);
  // Before permission is given the device labels are empty, but the kinds
  // are listed: no audioinput at all means no microphone.
  const devices = await navigator.mediaDevices
    .enumerateDevices()
    .catch(() => []);
  if (devices.length && !devices.some(d => d.kind === 'audioinput'))
    return message('mic-error', () => t().errors.noMic);

  $('mic-test').disabled = true;
  message('mic-status', () => t().check.micAsking);
  stopMeter();
  micStream?.getTracks().forEach(track => track.stop());

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    console.error(error);
    micStream = undefined;
    micOk = false;
    message('mic-status', undefined);
    message('mic-error', micErrorText(error));
    $('mic-test').disabled = false;
    updateStart();

    return;
  }

  message('mic-status', () => t().check.micListening);
  $('level-row').hidden = false;
  if (Recognition) $('speech-row').hidden = false;
  startMeter(micStream);
  $('mic-test').disabled = false;
}

function startMeter(stream) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  context.resume().catch(() => {});
  const data = new Float32Array(analyser.fftSize);
  let loud = 0;

  // An interval rather than animation frames: it keeps going while the
  // tester looks at another window.
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    const level = Math.min(
      100,
      Math.round(Math.sqrt(sum / data.length) * METER_GAIN),
    );
    $('level-bar').style.width = `${level}%`;
    $('level').setAttribute('aria-valuenow', String(level));

    if (level >= HEARD_LEVEL && ++loud >= HEARD_READINGS && !micOk) {
      micOk = true;
      message('mic-status', () => t().check.micOk);
      updateStart();
    }
  }, 50);
  meter = { context, timer };
}

function stopMeter() {
  if (!meter) return;
  clearInterval(meter.timer);
  meter.context.close().catch(() => {});
  meter = undefined;
}

/** Leaves the sound check; the microphone stays open for the recording. */
function stopCheck() {
  stopMeter();
  checkRecognition?.abort();
  checkRecognition = undefined;
}

/** Optional: one sentence through the speech recognizer, shown as text. */
function testSpeech() {
  if (!Recognition || checkRecognition) return;
  const recognizer = new Recognition();
  recognizer.lang = lang;
  recognizer.interimResults = true;
  recognizer.continuous = false;
  let words = '';
  let failed = false;
  checkRecognition = recognizer;
  $('speech-test').disabled = true;
  message('speech-status', () => t().check.speechListening);

  recognizer.onresult = event => {
    words = [...event.results]
      .map(result => result[0].transcript)
      .join(' ')
      .trim();
    const shown = words;
    if (shown) message('speech-status', () => t().check.speechHeard(shown));
  };

  recognizer.onerror = event => {
    failed = true;
    message(
      'speech-status',
      event.error === 'not-allowed'
        ? () => t().errors.micDenied
        : event.error === 'no-speech'
          ? () => t().check.speechNone
          : () => t().check.speechFailed(event.error),
    );
  };

  recognizer.onend = () => {
    if (!words && !failed) message('speech-status', () => t().check.speechNone);
    if (checkRecognition === recognizer) checkRecognition = undefined;
    $('speech-test').disabled = false;
  };

  recognizer.start();
}

/** Plays a line in the moderator's voice for the current language. */
async function testSpeaker() {
  const code = lang;
  await voiceReady(code);
  renderVoicePicker();
  const voice = voices.get(code);
  message('speaker-status', () =>
    [
      t().check.speakerHint(voice?.name ?? t().check.defaultVoice),
      voice ? '' : t().noVoice,
    ]
      .join(' ')
      .trim(),
  );
  speechSynthesis.cancel();
  speechSynthesis.speak(utter(TEXT[code].check.speakerLine, code));
}

/** The sound check's voice list for the current language, best first, with
 * the moderator's voice selected. Hidden while the browser has none. */
function renderVoicePicker() {
  const select = $('voice-select');
  const ranked = rankVoices(speechSynthesis.getVoices(), lang);
  const current = voices.get(lang) ?? ranked[0];
  $('voice-row').hidden = ranked.length === 0;
  select.replaceChildren(
    ...ranked.map(voice => {
      const option = document.createElement('option');
      option.value = voice.name;
      option.textContent = `${voice.name} (${voice.lang})`;
      option.selected = voice === current;

      return option;
    }),
  );
}

function chooseVoice() {
  const name = $('voice-select').value;
  try {
    sessionStorage.setItem(VOICE_KEY(lang), name);
  } catch {
    // Storage blocked: kept in `voices` until the page reloads.
  }
  const voice = speechSynthesis.getVoices().find(v => v.name === name);
  if (voice) voices.set(lang, voice);
}

function chooseTyping() {
  typedChosen = true;
  message('mic-status', () => t().check.typedChosen);
  updateStart();
}

renderLangs();
applyTexts();
if (!Recognition) {
  $('speech-row').hidden = false;
  $('speech-test').hidden = true;
  message('speech-status', () => t().errors.speechUnsupported);
}
if (!code) showError(() => t().errors.noCode);
updateStart();
checkCode();
voiceReady(lang).then(renderVoicePicker);

$('agree').addEventListener('change', updateStart);
$('mic-test').addEventListener('click', testMic);
$('type-instead').addEventListener('click', chooseTyping);
$('speech-test').addEventListener('click', testSpeech);
$('speaker-test').addEventListener('click', testSpeaker);
$('voice-select').addEventListener('change', chooseVoice);
$('voice-try').addEventListener('click', testSpeaker);
$('retry').addEventListener('click', () => retryAction?.());
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
