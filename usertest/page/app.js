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
    who === 'me' ? `${typed ? 'You (typed)' : 'You'}: ${text}` : text;
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

/** `typed`: the turn (or part of it) came from the typed-answer box. */
async function turn(said, typed = false) {
  if (busy || ended) return;
  busy = true;
  $('send').disabled = true;
  heard = [];
  $('heard').textContent = '';
  lastTurn = Date.now();
  if (said) show('me', said, typed);
  status('Thinking…');

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
      status('Speaking…');
      await speak(say);
    }

    if (done) return finish();
    status(inputMode === 'typed' ? 'Your turn: type below.' : 'Listening…');
  } catch (error) {
    status('The moderator is not answering. Keep going; it will try again.');
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
    if (
      ['not-allowed', 'audio-capture', 'service-not-allowed'].includes(
        event.error,
      )
    ) {
      status('The microphone is not working here. Type your answers below.');
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
  $('typed-form').hidden = true;
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

  if (!Recognition) inputMode = 'typed';
  let media;

  try {
    media = await getMedia();
    ({ id: session } = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: $('name').value,
        lang: LANG,
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
    $('error').textContent =
      error.name === 'NotAllowedError'
        ? 'The session needs screen sharing. Please allow it and try again.'
        : `Could not start the session (${error.message}). Is the invite link complete?`;
    $('error').hidden = false;
    $('start').disabled = false;

    return;
  }

  $('intro').hidden = true;
  $('consent').hidden = true;
  $('session').hidden = false;
  if (inputMode === 'voice') setupRecognition();
  else useTyping();
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
