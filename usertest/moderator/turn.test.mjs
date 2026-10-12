// node --test usertest/moderator/turn.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsWithQuestion, MAX_ENDS_REFUSED, moderatorTurn } from './turn.mjs';

test('a thank-you with [END] ends the session', () => {
  assert.deepEqual(
    moderatorTurn('Thank you so much, you can close the windows now. [END]'),
    {
      say: 'Thank you so much, you can close the windows now.',
      done: true,
      wait: false,
      endRefused: false,
    },
  );
  // [END] on its own line, as the plans ask.
  assert.equal(moderatorTurn('Thanks for your time!\n[END]').done, true);
});

test('[END] after a question is refused, so the tester can answer (usertest-findings#21)', () => {
  const turn = moderatorTurn(
    'Would you use this with your own Notion, and what for? [END]',
  );
  assert.deepEqual(turn, {
    say: 'Would you use this with your own Notion, and what for?',
    done: false,
    wait: false,
    endRefused: true,
  });
  // In other languages and with closing quotes too.
  assert.equal(
    moderatorTurn('Zou je dit gebruiken, en waarvoor? [END]').done,
    false,
  );
  assert.equal(moderatorTurn('Wat zou je "beter" noemen?" [END]').done, false);
});

test('a question inside a thank-you is not refused', () => {
  assert.equal(
    moderatorTurn(
      'You asked what sync means? Good question. Thank you, that was all. [END]',
    ).done,
    true,
  );
});

test('after MAX_ENDS_REFUSED refusals an [END] ends the session anyway', () => {
  const text = 'Anything else you want to add? [END]';
  for (let n = 0; n < MAX_ENDS_REFUSED; n++)
    assert.equal(moderatorTurn(text, { endsRefused: n }).done, false);
  assert.deepEqual(moderatorTurn(text, { endsRefused: MAX_ENDS_REFUSED }), {
    say: 'Anything else you want to add?',
    done: true,
    wait: false,
    endRefused: false,
  });
});

test('[WAIT] alone is a silent turn; other text is spoken as before', () => {
  assert.deepEqual(moderatorTurn('[WAIT]'), {
    say: '',
    done: false,
    wait: true,
    endRefused: false,
  });
  assert.deepEqual(moderatorTurn('What do you see now?'), {
    say: 'What do you see now?',
    done: false,
    wait: false,
    endRefused: false,
  });
  // Nothing left to say: the fallback, as server.mjs passes language.lost.
  assert.equal(moderatorTurn('', { fallback: 'Sorry?' }).say, 'Sorry?');
  assert.equal(moderatorTurn('[END]', { fallback: 'Bye.' }).done, true);
});

test('endsWithQuestion looks only at the end', () => {
  assert.equal(endsWithQuestion('Is that right?'), true);
  assert.equal(endsWithQuestion('¿Lo usarías? '), true);
  assert.equal(endsWithQuestion('Is that right? Thanks.'), false);
  assert.equal(endsWithQuestion(''), false);
});
