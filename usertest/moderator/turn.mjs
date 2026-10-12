/**
 * What one moderator reply means for the session, pure, so
 * `node --test usertest/moderator/turn.test.mjs` can check it without
 * starting the server.
 *
 * The model marks its last turn with `[END]`, and the page speaks that turn
 * and then ends the session. Every plan says `[END]` goes only after the
 * thank-you, but a model once put it after the wrap-up question, and the
 * session ended a second later, with no answer and no thank-you
 * (ontola/usertest-findings#21). So an `[END]` in a turn that asks something
 * (its spoken text ends with a question mark) is refused: the turn is
 * spoken, and the session goes on. At most `MAX_ENDS_REFUSED` times per
 * session, so a model that keeps doing it still ends the session.
 */

export const MAX_ENDS_REFUSED = 2;

/** Whether the spoken text ends by asking something. */
export const endsWithQuestion = text => /[?？¿]["'”’)\]]*\s*$/.test(text);

/**
 * `text`: the model's reply, tokens included. `endsRefused`: how often this
 * session already refused an `[END]`. `fallback`: what to say when nothing
 * is left to speak. Returns what to speak (`say`), whether the session ends
 * (`done`), whether it is a silent `[WAIT]` turn (`wait`), and whether an
 * `[END]` was refused (`endRefused`).
 */
export function moderatorTurn(text, { endsRefused = 0, fallback = '' } = {}) {
  const ended = text.includes('[END]');
  const wait = !ended && /^\[WAIT\]$/.test(text);
  const say = wait
    ? ''
    : text.replaceAll('[END]', '').replaceAll('[WAIT]', '').trim() || fallback;
  const endRefused =
    ended && endsRefused < MAX_ENDS_REFUSED && endsWithQuestion(say);

  return { say, done: ended && !endRefused, wait, endRefused };
}
