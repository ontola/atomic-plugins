// Picks the moderator's speechSynthesis voice. Pure functions over the
// browser's SpeechSynthesisVoice list (only name, lang and localService are
// read), so e2e/run.mjs can check the ranking against stubbed lists.
//
// The ranking, for a language like nl-NL:
// 1. The exact language beats the same base language (nl-BE): an nl-NL voice
//    reads Dutch as Dutch; any other language is never picked.
// 2. Novelty and robotic voices (eSpeak, the old macOS novelty voices) are
//    never picked, and not offered in the sound check either.
// 3. Within a language, by quality: names that say Natural, Neural, Online,
//    Premium, Enhanced or Siri (Edge's and macOS's good voices), then
//    Google's own ("Google Nederlands"), then network voices
//    (localService false, Chrome and Edge), then the rest in browser order.

/** Robotic or novelty voices. macOS ships many joke voices under plain names,
 * so they're listed by name. */
const ROBOTIC = new RegExp(
  [
    'espeak',
    'mbrola',
    'festival',
    'pico',
    '\\bfred\\b',
    'albert',
    'zarvox',
    'bad news',
    'good news',
    'trinoids',
    'bahh',
    'bells',
    'boing',
    'bubbles',
    'cellos',
    'deranged',
    'hysterical',
    'jester',
    'organ',
    'superstar',
    'whisper',
    'wobble',
    'ralph',
    'junior',
    'kathy',
    'princess',
    'bruce',
    'agnes',
    'vicki',
    'victoria',
  ].join('|'),
  'i',
);

const GOOD_NAME = /natural|neural|online|premium|enhanced|siri/i;

const langOf = voice => voice.lang.replace('_', '-');

export function isRobotic(voice) {
  return ROBOTIC.test(voice.name);
}

/** How well `voice` fits `code` (like 'nl-NL'): 0 means never. */
export function voiceScore(voice, code) {
  const lang = langOf(voice).toLowerCase();
  const wanted = code.toLowerCase();
  const exact = lang === wanted;
  if (!exact && lang.split('-')[0] !== wanted.split('-')[0]) return 0;
  if (isRobotic(voice)) return 0;

  let quality = 1;
  if (GOOD_NAME.test(voice.name)) quality += 4;
  if (/^google\b/i.test(voice.name)) quality += 3;
  if (voice.localService === false) quality += 2;

  return (exact ? 100 : 0) + quality;
}

/** The voices worth offering for `code`, best first. */
export function rankVoices(all, code) {
  return all
    .map((voice, index) => ({ voice, index, score: voiceScore(voice, code) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.voice);
}

/** True when a better voice is unlikely to turn up: the best one is in the
 * exact language and more than a plain local voice. Otherwise it is worth
 * waiting for `voiceschanged`, as Chrome and Edge add their network voices
 * after the local ones. */
export function goodEnough(voice, code) {
  return !!voice && voiceScore(voice, code) > 101;
}
