// The tester's side of a moderated session: records screen and microphone,
// turns speech into text with the browser's recognizer, sends turns to the
// moderator (../moderator/server.mjs) and speaks its answers. Served at
// /usertest/ on the test instance, so it shares the data-browser's origin
// and can set the test catalog before opening the app.

const API = '/usertest/api';
const CATALOG_URL = `https://catalog.${location.hostname.replace(/^plugins\./, '')}/catalog.json`;
/** Send a turn this long after the tester stops talking (a question sooner).
 * Chrome's recognizer adds no punctuation, so questions are recognized by
 * their words; the moderator answers [WAIT] when nothing needs saying. */
const PAUSE_AFTER_QUESTION = 2000;
const PAUSE_AFTER_SPEECH = 5000;
const QUESTION =
  /\b(how|what|where|why|which|who|when|can you|could you|should i|do i|is it|is there|are there)\b/i;
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
let session;
let recognition;
let recorder;
let speaking = false;
let ended = false;
let busy = false;
let heard = [];
let lastSpeech = Date.now();
let lastTurn = Date.now();
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

function show(who, text) {
  const p = document.createElement('p');
  if (who === 'me') p.className = 'me';
  p.textContent = who === 'me' ? `You: ${text}` : text;
  $('log').prepend(p);
}

function status(text) {
  $('status').textContent = text;
}

/** English only for now: in a Dutch trial (2026-09-28) the moderator switched
 * language on its own while the voice stayed on the one picked at the start. */
const LANG = 'en-US';

/** One voice for the whole session. Chrome fills getVoices() only after
 * `voiceschanged`, so without waiting the first line got the default voice
 * and later lines another one. */
let voice;

function pickVoice() {
  const english = speechSynthesis
    .getVoices()
    .filter(v => v.lang.replace('_', '-') === LANG);

  return (
    english.find(v => /google/i.test(v.name)) ??
    english.find(v => v.localService) ??
    english[0]
  );
}

function voiceReady() {
  voice ??= pickVoice();
  if (voice) return Promise.resolve();

  return new Promise(resolve => {
    const done = () => {
      voice ??= pickVoice();
      resolve();
    };

    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    // Some browsers never fire it; go on with the default voice.
    setTimeout(done, 2000);
  });
}

async function speak(text) {
  await voiceReady();

  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = LANG;
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

async function turn(said) {
  if (busy || ended) return;
  busy = true;
  heard = [];
  $('heard').textContent = '';
  lastTurn = Date.now();
  if (said) show('me', said);
  status('Thinking…');

  try {
    const { say, done } = await api(`/sessions/${session}/turn`, {
      method: 'POST',
      body: JSON.stringify({ said, screenshot: screenshot() }),
    });

    if (say) {
      show('moderator', say);
      status('Speaking…');
      await speak(say);
    }

    if (done) return finish();
    status('Listening…');
  } catch (error) {
    status('The moderator is not answering. Keep going; it will try again.');
    console.error(error);
  } finally {
    busy = false;
  }
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
  recognition.lang = LANG;
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
    if (event.error === 'not-allowed')
      status('Microphone access is blocked for this page.');
  };

  listen();
}

/** Decides when to hand the conversation to the moderator. */
function tick() {
  if (ended || busy || speaking) return;
  const now = Date.now();
  const text = heard.join(' ').trim();

  if (text) {
    const wait = QUESTION.test(heard.at(-1) ?? '')
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

async function startRecording() {
  const screen = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 5 },
    audio: false,
  });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const stream = new MediaStream([
    ...screen.getVideoTracks(),
    ...mic.getAudioTracks(),
  ]);
  const type = ['video/webm;codecs=vp9,opus', 'video/webm'].find(t =>
    MediaRecorder.isTypeSupported(t),
  );
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
  $('rec').textContent = '● recording';
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
  status('Saving the recording…');
  // Let the last chunk arrive before saying goodbye.
  await new Promise(resolve => setTimeout(resolve, 500));
  await uploads;
  await api(`/sessions/${session}/end`, { method: 'POST' }).catch(() => {});
  $('rec').textContent = '';
  status('Thank you! The session has ended; you can close both windows.');
  $('end').hidden = true;
}

async function start() {
  $('error').hidden = true;
  $('start').disabled = true;
  // The data-browser reads the catalog URL from this origin's storage.
  localStorage.setItem('plugin-catalog-url', CATALOG_URL);
  const width = Math.round(screen.availWidth * 0.62);
  const app = window.open(
    '/app/dev-drive',
    'atomic-usertest-app',
    `popup,width=${width},height=${screen.availHeight},left=${screen.availWidth - width},top=0`,
  );

  try {
    ({ id: session } = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: $('name').value,
        lang: LANG,
        // Which session plan (moderator/sessions/<name>.md); none = calendar.
        session: params.get('session') ?? undefined,
      }),
    }));
    await startRecording();
  } catch (error) {
    app?.close();
    $('error').textContent =
      error.name === 'NotAllowedError'
        ? 'The session needs screen sharing and the microphone. Please allow both and try again.'
        : `Could not start the session (${error.message}). Is the invite link complete?`;
    $('error').hidden = false;
    $('start').disabled = false;

    return;
  }

  $('intro').hidden = true;
  $('consent').hidden = true;
  $('session').hidden = false;
  setupRecognition();
  setInterval(tick, 1000);
  setInterval(checkNews, 5000);
  turn('');
}

if (!Recognition) $('unsupported').hidden = false;

if (!code) {
  $('error').textContent = 'This page needs the invite link you received.';
  $('error').hidden = false;
}

$('agree').addEventListener('change', () => {
  $('start').disabled = !$('agree').checked || !Recognition || !code;
});
$('start').addEventListener('click', start);
$('end').addEventListener('click', () => finish());
// Hands over at once, with whatever was heard so far.
$('ask').addEventListener('click', () => {
  if (!speaking) turn(heard.join(' ').trim());
});
