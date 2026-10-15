import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build, check, readSource, root } from './ontology.mjs';
import {
  datatypeProblem,
  implementationProblems,
  lensSourceProblems,
  overlayDeclaresResource,
  readLensSource,
} from './lens-catalog.mjs';
import { catalogLensInfo, lensGet, lensPut, parseMapping } from './lens.mjs';

const BASE = 'https://vocab.example/ontology';
const NAME = 'https://atomicdata.dev/properties/name';
const STRING = 'https://atomicdata.dev/datatypes/string';

const terms = () => ({
  releases: {
    v1: {
      name: 'Release 1',
      description: 'The first release.',
      classes: ['thing-v1'],
      properties: ['colour'],
    },
  },
  classes: {
    'thing-v1': {
      name: 'Thing',
      description: 'A thing.',
      requires: [NAME],
      recommends: ['colour'],
    },
  },
  properties: {
    colour: { name: 'Colour', description: 'Its colour.', datatype: STRING },
  },
});

const lenses = () => ({
  releases: {
    v1: { name: 'Lenses 1', description: 'First.', lenses: ['shop-thing-v1'] },
  },
  lenses: {
    'shop-thing-v1': {
      name: 'Shop item ↔ Thing',
      description: 'A shop item and a thing.',
      source: { record: { provider: 'shop.example', resource: 'item' } },
      target: { class: 'thing-v1' },
      mapping: {
        version: 2,
        fields: [
          { source: '/title', target: NAME },
          { source: '/look/colour', target: 'colour' },
        ],
      },
      examples: [
        {
          source: { id: 1, title: 'Cup', look: { colour: 'red', size: 2 } },
          target: { [NAME]: 'Cup', colour: 'red' },
          edits: [
            {
              target: { [NAME]: 'Mug', colour: 'red' },
              source: { id: 1, title: 'Mug', look: { colour: 'red', size: 2 } },
            },
          ],
        },
      ],
    },
  },
});

const git = (dir, ...args) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const put = (dir, path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

const json = value => `${JSON.stringify(value, null, 2)}\n`;

/** A repository with the fixture ontology and lens catalog built as `main`. */
function using(run, { catalog = lenses(), base = BASE, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atomic-lenses-'));

  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'Test');
    put(dir, 'ontology-kit/base.json', json({ base }));
    put(dir, 'ontology-kit/source.json', json(terms()));
    put(dir, 'ontology-kit/lenses.json', json(catalog));
    for (const [path, text] of Object.entries(files)) put(dir, path, text);
    build({ base: dir });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'publish');

    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const problemsOf = (catalog, base = root) =>
  lensSourceProblems(catalog, terms(), BASE, base).join('\n');

test('the fixture catalog has no problems', () => {
  assert.equal(problemsOf(lenses()), '');
});

test('build publishes lenses/v<N> and one file per lens, shortnames resolved', () =>
  using(dir => {
    const release = JSON.parse(
      readFileSync(join(dir, 'ontology/lenses/v1'), 'utf8'),
    );
    assert.deepEqual(release, {
      '@id': `${BASE}/lenses/v1`,
      lensFormat: 1,
      name: 'Lenses 1',
      description: 'First.',
      lenses: [`${BASE}/lenses/shop-thing-v1`],
    });
    const lens = JSON.parse(
      readFileSync(join(dir, 'ontology/lenses/shop-thing-v1'), 'utf8'),
    );
    assert.equal(lens['@id'], `${BASE}/lenses/shop-thing-v1`);
    assert.equal(lens.release, `${BASE}/lenses/v1`);
    assert.deepEqual(lens.target, { class: `${BASE}/classes/thing-v1` });
    assert.equal(lens.mapping.fields[1].target, `${BASE}/properties/colour`);
    assert.deepEqual(lens.examples[0].target, {
      [NAME]: 'Cup',
      [`${BASE}/properties/colour`]: 'red',
    });
    // The published file runs as is, and has #2069's CatalogLens shape.
    assert.deepEqual(
      lensGet(lens.mapping, lens.examples[0].source),
      lens.examples[0].target,
    );
    assert.deepEqual(catalogLensInfo(lens), {
      subject: `${BASE}/lenses/shop-thing-v1`,
      name: 'Shop item ↔ Thing',
      source: 'record:shop.example#item',
      target: `${BASE}/classes/thing-v1`,
      mapping: lens.mapping,
      mappingVersion: 2,
    });
    assert.deepEqual(check({ base: dir, published: 'main' }), []);
  }));

test('source problems: names, endpoints, references and evidence', () => {
  const c = lenses();
  const l = c.lenses['shop-thing-v1'];
  c.lenses.Bad = { ...structuredClone(l), name: '', examples: [] };
  c.releases.v1.lenses.push('Bad', 'ghost-v1');
  l.source = {
    record: { provider: 'shop.example', resource: 'item' },
    class: 'x',
  };
  const problems = problemsOf(c);
  assert.match(problems, /lens Bad: a lens name is a slug ending in -v<N>/);
  assert.match(problems, /lens Bad: name needs a non-empty string/);
  assert.match(problems, /lens Bad: needs at least one example/);
  assert.match(problems, /shop-thing-v1: source is exactly one of/);
});

test('references must fit their endpoint, and a shared class its fields', () => {
  const c = lenses();
  const l = c.lenses['shop-thing-v1'];
  l.mapping.fields.push({
    source: 'https://x.example/p',
    target: 'https://x.example/q',
  });
  assert.match(
    problemsOf(c),
    /source "https:\/\/x.example\/p" must be a JSON Pointer/,
  );
  assert.match(
    problemsOf(c),
    /target https:\/\/x.example\/q is not a field of the shared class thing-v1/,
  );

  const d = lenses();
  d.lenses['shop-thing-v1'].mapping.fields = [
    { source: '/look/colour', target: 'colour' },
  ];
  d.lenses['shop-thing-v1'].examples = [
    { source: { look: { colour: 'red' } }, target: { colour: 'red' } },
  ];
  assert.match(
    problemsOf(d),
    /maps no target for https:\/\/atomicdata.dev\/properties\/name, which thing-v1 requires/,
  );

  const e = lenses();
  e.lenses['shop-thing-v1'].target = { class: 'nothing-v1' };
  assert.match(
    problemsOf(e),
    /target class "nothing-v1" is neither a class in source.json/,
  );

  const f = lenses();
  f.lenses['shop-thing-v1'].mapping.fields[1].target = 'weight';
  assert.match(
    problemsOf(f),
    /target "weight" is neither a property in source.json/,
  );
});

test('examples are checked: get, laws, edits and expected refusals', () => {
  const c = lenses();
  const example = c.lenses['shop-thing-v1'].examples[0];
  example.target[NAME] = 'Bowl';
  example.edits[0].source.title = 'Plate';
  example.edits.push({ target: { [NAME]: 'Jug' }, error: 'read-only' });
  const problems = problemsOf(c);
  assert.match(
    problems,
    /example 1: get gives .*"Cup".*, the example says .*"Bowl"/,
  );
  assert.match(
    problems,
    /example 1, edit 1: put gives .*"Mug".*the example says .*"Plate"/,
  );
  assert.match(problems, /example 1, edit 2: expected a read-only refusal/);
});

test('releases: defined lenses, every lens released, one lens per class pair', () => {
  const c = lenses();
  c.lenses['shop-thing-v2'] = structuredClone(c.lenses['shop-thing-v1']);
  c.lenses['orphan-v1'] = structuredClone(c.lenses['shop-thing-v1']);
  c.lenses['orphan-v1'].source = {
    record: { provider: 'other.example', resource: 'item' },
  };
  c.releases.v1.lenses.push('shop-thing-v2', 'ghost-v1');
  const problems = problemsOf(c);
  assert.match(problems, /shop-thing-v1 and shop-thing-v2 both connect/);
  assert.match(problems, /lists lens ghost-v1, which is not defined/);
  assert.match(problems, /lens orphan-v1 is in no release/);
});

test('record endpoints: openapi must be an overlay folder declaring the resource', () => {
  assert.ok(overlayDeclaresResource(root, 'APIs/todoist.com/1', 'task'));
  assert.ok(
    overlayDeclaresResource(
      root,
      'APIs/clockify.me/1.0.0-readonly',
      'timeEntry',
    ),
  );
  assert.ok(!overlayDeclaresResource(root, 'APIs/todoist.com/1', 'comment'));
  assert.ok(!overlayDeclaresResource(root, 'APIs/nowhere.example/1', 'task'));
  const c = lenses();
  c.lenses['shop-thing-v1'].source.record.openapi = 'APIs/shop.example/1';
  assert.match(
    problemsOf(c),
    /no crud-causality overlay in overlays\/APIs\/shop.example\/1\/ declares crudResources.item/,
  );
  c.lenses['shop-thing-v1'].source.record.openapi = 'APIs/todoist.com/1';
  assert.match(problemsOf(c), /is not under APIs\/shop.example\//);
  const d = lenses();
  d.lenses['shop-thing-v1'].implementation = 'elsewhere/nowhere.ts';
  assert.match(
    problemsOf(d),
    /implementation is a repository path under integrations\//,
  );
});

test('a published lens or release may not change; a new version in a new release is fine', () =>
  using(dir => {
    const file = join(dir, 'ontology-kit/lenses.json');
    const c = JSON.parse(readFileSync(file, 'utf8'));
    c.lenses['shop-thing-v1'].description = 'Changed after publishing.';
    writeFileSync(file, json(c));
    build({ base: dir });
    assert.match(
      check({ base: dir, published: 'main' }).join('\n'),
      /ontology\/lenses\/shop-thing-v1 is published at main and was changed\. Published lenses and lens releases are immutable/,
    );

    const next = lenses();
    next.lenses['shop-thing-v2'] = structuredClone(
      next.lenses['shop-thing-v1'],
    );
    next.lenses['shop-thing-v2'].description = 'A better thing.';
    next.releases.v2 = {
      name: 'Lenses 2',
      description: 'Second.',
      lenses: ['shop-thing-v2'],
    };
    writeFileSync(file, json(next));
    build({ base: dir });
    assert.deepEqual(check({ base: dir, published: 'main' }), []);
    const v2 = JSON.parse(
      readFileSync(join(dir, 'ontology/lenses/shop-thing-v2'), 'utf8'),
    );
    assert.equal(v2.release, `${BASE}/lenses/v2`);
  }));

test('a base move rewrites lens files by exactly the substitution', () =>
  using(dir => {
    put(
      dir,
      'ontology-kit/base.json',
      json({ base: 'https://terms.example/o' }),
    );
    build({ base: dir });
    assert.deepEqual(check({ base: dir, published: 'main' }), []);
    const lens = readFileSync(
      join(dir, 'ontology/lenses/shop-thing-v1'),
      'utf8',
    );
    assert.match(lens, /https:\/\/terms\.example\/o\/classes\/thing-v1/);
  }));

test('a stray file under ontology/lenses/ is reported', () =>
  using(dir => {
    put(dir, 'ontology/lenses/extra', '{}\n');
    assert.match(
      check({ base: dir }).join('\n'),
      /ontology\/lenses\/extra: ontology\/ holds only the build's files/,
    );
  }));

test('this repository: every catalog lens parses, and its published file runs', t => {
  const source = readLensSource(root);
  if (!source) return t.skip('no ontology-kit/lenses.json here');
  assert.deepEqual(
    lensSourceProblems(
      source,
      readSource(root),
      JSON.parse(readFileSync(join(root, 'ontology-kit/base.json'), 'utf8'))
        .base,
      root,
    ),
    [],
  );

  for (const name of Object.keys(source.lenses)) {
    const lens = JSON.parse(
      readFileSync(join(root, 'ontology/lenses', name), 'utf8'),
    );
    const mapping = parseMapping(lens.mapping);

    for (const example of lens.examples) {
      if (example.error !== undefined) {
        assert.throws(
          () => lensGet(mapping, example.source),
          e => e.code === example.error,
          name,
        );
        continue;
      }

      assert.deepEqual(lensGet(mapping, example.source), example.target, name);
      assert.deepEqual(
        lensPut(mapping, example.target, example.source),
        example.source,
        name,
      );
    }
  }
});

test('implementation must exist only while a lens is unpublished', () => {
  const c = lenses();
  c.lenses['shop-thing-v1'].implementation = 'integrations/nowhere.ts';
  assert.equal(problemsOf(c), '');
  assert.deepEqual(implementationProblems(c, root), [
    'lens shop-thing-v1: implementation integrations/nowhere.ts does not exist',
  ]);
  assert.deepEqual(
    implementationProblems(c, root, new Set(['shop-thing-v1'])),
    [],
  );
});

test('check: moving the code lens of a published lens does not fail it', () => {
  const c = lenses();
  c.lenses['shop-thing-v1'].implementation = 'integrations/shop/lens.ts';
  using(
    dir => {
      rmSync(join(dir, 'integrations/shop/lens.ts'));
      assert.deepEqual(check({ base: dir, published: 'main' }), []);
      assert.match(
        check({ base: dir }).join('\n'),
        /implementation integrations\/shop\/lens.ts does not exist/,
      );
    },
    { catalog: c, files: { 'integrations/shop/lens.ts': '// lens\n' } },
  );
});

test('a published lens may not be deleted, with a lens-specific message', () =>
  using(dir => {
    rmSync(join(dir, 'ontology/lenses/shop-thing-v1'));
    assert.match(
      check({ base: dir, published: 'main' }).join('\n'),
      /ontology\/lenses\/shop-thing-v1 is published at main and was deleted\. Published lenses and lens releases stay available/,
    );
  }));

test('example rows on a class endpoint must fit source.json datatypes', () => {
  const c = lenses();
  const example = c.lenses['shop-thing-v1'].examples[0];
  example.source.look.colour = 5;
  example.target.colour = 5;
  example.edits[0].target.colour = 5;
  example.edits[0].source.look.colour = 5;
  assert.match(
    problemsOf(c),
    /example 1: target: colour is 5, not a string value/,
  );
  assert.match(
    problemsOf(c),
    /example 1: edit 1 target: colour is 5, not a string value/,
  );
  assert.equal(
    datatypeProblem('REGULAR', 'https://atomicdata.dev/datatypes/boolean'),
    '"REGULAR", not a boolean value'.replace(/^/, 'is '),
  );
  assert.equal(
    datatypeProblem(1.5, 'https://atomicdata.dev/datatypes/timestamp'),
    'is 1.5, not a timestamp value',
  );
  assert.equal(
    datatypeProblem('2026-10-08', 'https://atomicdata.dev/datatypes/date'),
    undefined,
  );
  assert.equal(
    datatypeProblem(['a'], 'https://atomicdata.dev/datatypes/resourceArray'),
    undefined,
  );
});

test('a record with and without openapi is one pair; source and target must differ', () => {
  const c = lenses();
  const l = c.lenses['shop-thing-v1'];
  l.source = {
    record: {
      provider: 'todoist.com',
      resource: 'task',
      openapi: 'APIs/todoist.com/1',
    },
  };
  c.lenses['shop-thing-v2'] = structuredClone(l);
  c.lenses['shop-thing-v2'].source = {
    record: { provider: 'todoist.com', resource: 'task' },
  };
  c.releases.v1.lenses.push('shop-thing-v2');
  assert.match(
    problemsOf(c),
    /shop-thing-v1 and shop-thing-v2 both connect .*record:todoist.com#task/,
  );

  const d = lenses();
  d.lenses['shop-thing-v1'].source = { class: 'thing-v1' };
  assert.match(
    problemsOf(d),
    /lens shop-thing-v1: its source and target are the same/,
  );
});

test('backward GetPut on example targets passes for a converting lens', () => {
  const c = lenses();
  // check also runs GetPut backwards on each example target (lensPut's
  // unchanged-value rule makes it hold by construction; this guards that a
  // converting field does not report a false problem).
  c.lenses['shop-thing-v1'].mapping.fields[1] = {
    source: '/look/at',
    target: 'colour',
    convert: 'ms-to-iso',
  };
  c.lenses['shop-thing-v1'].examples = [
    {
      source: { title: 'Cup', look: { at: 0 } },
      target: { [NAME]: 'Cup', colour: '1970-01-01T00:00:00.000Z' },
    },
  ];
  assert.equal(problemsOf(c), '');
});

test('v3 examples: get refusals, backward edits and guard references are checked', () => {
  const c = lenses();
  const l = c.lenses['shop-thing-v1'];
  l.mapping.version = 3;
  l.mapping.guards = [{ at: '/id', is: 'present' }];
  l.mapping.fields[1].absent = 'unset';
  l.examples.push({ source: { title: 'No id' }, error: 'out-of-domain' });
  l.examples[0].edits.push({
    direction: 'backward',
    source: { id: 1, title: 'Cup', look: {} },
    target: { [NAME]: 'Cup' },
  });
  assert.equal(problemsOf(c), '');

  const d = structuredClone(c);
  d.lenses['shop-thing-v1'].examples[1].error = 'read-only';
  d.lenses['shop-thing-v1'].examples[0].edits[1].target = {
    [NAME]: 'Cup',
    colour: 'red',
  };
  const problems = problemsOf(d);
  assert.match(
    problems,
    /example 2: expected get to refuse with read-only, got .*outside this lens's domain/,
  );
  assert.match(problems, /edit 2 \(backward\): put gives/);

  const f = structuredClone(c);
  f.lenses['shop-thing-v1'].mapping.guards.push({
    at: 'https://x.example/colour',
    is: 'present',
  });
  assert.match(
    problemsOf(f),
    /source "https:\/\/x.example\/colour" must be a JSON Pointer/,
  );

  const e = structuredClone(c);
  e.lenses['shop-thing-v1'].examples[1].target = {};
  e.lenses['shop-thing-v1'].examples[0].edits[1].error = 'x';
  e.lenses['shop-thing-v1'].examples[0].edits.push({
    direction: 'sideways',
    target: {},
  });
  const shape = problemsOf(e);
  assert.match(shape, /example 2 has either a target .* or an error/);
  assert.match(
    shape,
    /a backward edit has a source \(the view\) and either a target/,
  );
  assert.match(shape, /direction is "backward" or left out/);
});

test('v3 backward edits may expect a refusal, and their laws are checked', () => {
  const c = lenses();
  const l = c.lenses['shop-thing-v1'];
  l.mapping.version = 3;
  l.mapping.guards = [{ at: '/deleted', notIn: [true] }];
  l.examples[0].edits.push(
    {
      direction: 'backward',
      source: { id: 1, title: 'Gone', deleted: true },
      error: 'out-of-domain',
    },
    {
      direction: 'backward',
      source: { id: 1, title: 'Bowl', look: { colour: 'blue' } },
      target: { [NAME]: 'Bowl', colour: 'blue' },
    },
  );
  assert.equal(problemsOf(c), '');

  const d = structuredClone(c);
  d.lenses['shop-thing-v1'].examples[0].edits[1].error = 'read-only';
  assert.match(
    problemsOf(d),
    /edit 2 \(backward\): expected a read-only refusal, got .*outside this lens's domain/,
  );
});

test('this repository: lenses.mjs exports exactly the published lens data', async t => {
  const source = readLensSource(root);
  if (!source) return t.skip('no ontology-kit/lenses.json here');
  const generated = await import('./lenses.mjs');
  const { lensExportName } = await import('./ontology.mjs');
  assert.deepEqual(
    Object.keys(generated.lenses).sort(),
    Object.keys(source.lenses).sort(),
  );

  for (const name of Object.keys(source.lenses)) {
    const file = JSON.parse(
      readFileSync(join(root, 'ontology/lenses', name), 'utf8'),
    );
    const want = {
      '@id': file['@id'],
      release: file.release,
      name: file.name,
      source: file.source,
      target: file.target,
      mapping: file.mapping,
    };
    assert.deepEqual(generated.lenses[name], want, name);
    assert.equal(generated[lensExportName(name)], generated.lenses[name], name);
  }
});
