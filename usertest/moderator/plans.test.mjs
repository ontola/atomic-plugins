// node --test usertest/moderator/plans.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPlans, PLACEHOLDER, sampleFiles, startPage } from './plans.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function dirWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'usertest-plans-'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);

  return dir;
}

test('lists every plan but README by title, with its sample files', () => {
  const dir = dirWith({
    'README.md': '# Session plans\n',
    'zeta.md': '# Session plan: Zeta app\n\n## The session\n',
    'alpha.md':
      '# Alpha view\n\nSample files (linked): `alpha/one.csv`, `alpha/two.xml`\n',
    'notes.txt': '# not a plan\n',
  });
  const { plans, list, skipped } = loadPlans(dir);

  assert.deepEqual(Object.keys(plans).sort(), ['alpha', 'zeta']);
  assert.deepEqual(list, [
    {
      id: 'alpha',
      title: 'Alpha view',
      samples: ['alpha/one.csv', 'alpha/two.xml'],
    },
    { id: 'zeta', title: 'Zeta app' },
  ]);
  assert.deepEqual(skipped, []);
});

test('a plan that still holds the entry placeholder is skipped, not listed', () => {
  const dir = dirWith({
    'done.md': '# Session plan: Done\n',
    'draft.md': `# Session plan: Draft\n\n2. ${PLACEHOLDER}, fill in later] Then task: "Open Hours."\n`,
  });
  const { plans, list, skipped } = loadPlans(dir);

  assert.deepEqual(Object.keys(plans), ['done']);
  assert.deepEqual(
    list.map(p => p.id),
    ['done'],
  );
  assert.deepEqual(skipped, ['draft']);
});

test('a plan without a heading is refused', () => {
  const dir = dirWith({ 'bare.md': 'No heading here.\n' });
  assert.throws(() => loadPlans(dir), /sessions\/bare\.md has no # heading/);
});

test('sample files take only <app>/<file> paths from the Sample files line', () => {
  assert.deepEqual(
    sampleFiles(
      'Sample files (linked on the session page): `money/a-2026-08.mt940`, `../etc/passwd`, `Money/x`\nOther line: `money/not-this.csv`\n',
    ),
    ['money/a-2026-08.mt940'],
  );
  assert.deepEqual(sampleFiles('# Plan\n'), []);
});

test('the real sessions/ folder loads, and no listed plan holds the placeholder', () => {
  const { plans, list, skipped } = loadPlans(join(here, 'sessions'));

  assert.ok(plans.calendar, 'the default plan, calendar, must be listed');
  for (const [id, text] of Object.entries(plans))
    assert.ok(
      !text.includes(PLACEHOLDER),
      `${id} is listed with a placeholder`,
    );
  for (const id of skipped)
    assert.ok(
      !plans[id] && !list.some(p => p.id === id),
      `${id} skipped yet listed`,
    );
  assert.equal(
    list.length + skipped.length,
    Object.keys(plans).length + skipped.length,
  );
});

test('a plan can name a same-origin start page; anything else is ignored', () => {
  assert.equal(
    startPage('# P\n\nStart page: `/app/pieces-demo?tester`\n'),
    '/app/pieces-demo?tester',
  );
  assert.equal(startPage('# P\n\nNo start line\n'), undefined);
  for (const bad of [
    'https://evil.example/app/x',
    '//evil.example/app/x',
    '/app/../admin',
    '/other/x',
    '/app/x?a=<b>',
    'javascript:alert(1)',
  ])
    assert.equal(startPage(`# P\n\nStart page: \`${bad}\`\n`), undefined, bad);

  const dir = dirWith({
    'split.md': '# Split\n\nStart page: `/app/pieces-demo?tester`\n',
  });
  assert.deepEqual(loadPlans(dir).list, [
    { id: 'split', title: 'Split', start: '/app/pieces-demo?tester' },
  ]);
});
