import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERTERS,
  LensError,
  catalogLensInfo,
  deepEqual,
  endpointKey,
  getAlongPath,
  lawProblems,
  lensGet,
  lensPut,
  parseMapping,
  pointerTokens,
  resolverLens,
  storedMapping,
} from './lens.mjs';

const NAME = 'https://atomicdata.dev/properties/name';
const START = 'https://drive.example/properties/work-start';
const BILLABLE = 'https://drive.example/properties/work-billable';
const DESCRIPTION = 'https://drive.example/properties/clockify-description';
const C_START = 'https://drive.example/properties/clockify-start';
const C_BILLABLE = 'https://drive.example/properties/clockify-billable';

const code = (fn, wanted) =>
  assert.throws(fn, e => e instanceof LensError && e.code === wanted);

// The mapping and row of ontola/atomic-server#2069's lens.test.ts, at
// bab52555: a v1 mapping must keep working unchanged.
const v1 = {
  version: 1,
  fields: [
    { source: NAME, target: DESCRIPTION },
    { source: START, target: C_START, convert: 'ms-to-iso' },
    { source: BILLABLE, target: C_BILLABLE },
  ],
};
const row = {
  [NAME]: 'Write the report',
  [START]: Date.UTC(2026, 9, 5, 9, 0),
  [BILLABLE]: true,
  'https://drive.example/properties/notes': 'not mapped',
};

test('v1 (#2069): get, PutGet, GetPut, unmapped kept, backwards, chains', () => {
  assert.deepEqual(lensGet(v1, row), {
    [DESCRIPTION]: 'Write the report',
    [C_START]: '2026-10-05T09:00:00.000Z',
    [C_BILLABLE]: true,
  });
  const view = {
    [DESCRIPTION]: 'Write the final report',
    [C_START]: '2026-10-05T10:00:00.000Z',
    [C_BILLABLE]: false,
  };
  assert.deepEqual(lensGet(v1, lensPut(v1, view, row)), view);
  assert.deepEqual(lensPut(v1, lensGet(v1, row), row), row);
  const put = lensPut(v1, { [DESCRIPTION]: 'Renamed' }, row);
  assert.equal(put['https://drive.example/properties/notes'], 'not mapped');
  assert.equal(put[NAME], 'Renamed');
  assert.deepEqual(
    lensGet(v1, { [C_START]: '2026-10-05T09:00:00.000Z' }, 'backward'),
    { [START]: Date.UTC(2026, 9, 5, 9, 0) },
  );
  const rename = {
    version: 1,
    fields: [{ source: DESCRIPTION, target: 'title' }],
  };
  assert.deepEqual(
    getAlongPath(
      [
        { mapping: v1, direction: 'forward' },
        { mapping: rename, direction: 'forward' },
      ],
      row,
    ),
    { title: 'Write the report' },
  );
});

test('v1 refuses what #2069 refuses, and v2-only features', () => {
  code(
    () =>
      parseMapping({
        version: 1,
        fields: [
          { source: NAME, target: DESCRIPTION },
          { source: START, target: DESCRIPTION },
        ],
      }),
    'overlap',
  );
  code(
    () =>
      parseMapping({
        version: 1,
        fields: [{ source: NAME, target: DESCRIPTION, convert: 'eval' }],
      }),
    'bad-mapping',
  );
  code(
    () =>
      parseMapping({
        version: 1,
        fields: [{ source: NAME, target: DESCRIPTION, convert: 'iso-to-ms' }],
      }),
    'bad-mapping',
  );
  code(
    () =>
      parseMapping({
        version: 1,
        fields: [{ source: NAME, target: DESCRIPTION, readOnly: true }],
      }),
    'bad-mapping',
  );
  code(() => parseMapping({ version: 3, fields: [] }), 'bad-mapping');
  code(() => parseMapping('{not json'), 'bad-mapping');
  assert.equal(parseMapping(JSON.stringify(v1)).version, 1);
});

test('v2 references: absolute keys or JSON Pointers, no overlap', () => {
  assert.deepEqual(pointerTokens('/a~1b/0/~0c'), ['a/b', '0', '~c']);
  code(() => pointerTokens('/a~2'), 'bad-reference');
  code(
    () =>
      parseMapping({ version: 2, fields: [{ source: 'title', target: NAME }] }),
    'bad-reference',
  );
  code(
    () =>
      parseMapping({
        version: 2,
        fields: [
          { source: '/timeInterval', target: NAME },
          { source: '/timeInterval/start', target: START },
        ],
      }),
    'overlap',
  );
  code(
    () =>
      parseMapping({
        version: 2,
        fields: [{ source: '/due/date', target: NAME, convert: 'day-of' }],
      }),
    'bad-mapping',
  );
});

test('nested pointers read and write in place, keeping siblings', () => {
  const m = {
    version: 2,
    fields: [
      { source: '/t/0/@value', target: NAME },
      {
        source: '/interval/start',
        target: START,
        convert: 'iso-seconds-to-ms',
      },
    ],
  };
  const source = {
    t: [{ '@value': 'Old', '@language': 'nl' }],
    interval: { start: '2026-10-05T09:00:00Z', duration: 'PT1H' },
    other: 1,
  };
  assert.deepEqual(lensGet(m, source), {
    [NAME]: 'Old',
    [START]: Date.UTC(2026, 9, 5, 9),
  });
  assert.deepEqual(lensPut(m, { [NAME]: 'New' }, source), {
    ...source,
    t: [{ '@value': 'New', '@language': 'nl' }],
  });
  // Missing containers are created: an array before an index.
  assert.deepEqual(lensPut(m, { [NAME]: 'X' }, {}), { t: [{ '@value': 'X' }] });
  assert.deepEqual(
    lawProblems(m, source, {
      [NAME]: 'New',
      [START]: Date.UTC(2026, 9, 5, 10),
    }),
    [],
  );
});

test('put writes only changed fields, so representations survive', () => {
  const m = {
    version: 2,
    fields: [{ source: '/at', target: START, convert: 'iso-to-ms' }],
  };
  const source = { at: '2026-10-05T11:00:00+02:00' };
  assert.deepEqual(lensPut(m, lensGet(m, source), source), source);
  assert.deepEqual(lensPut(m, { [START]: Date.UTC(2026, 9, 5, 10) }, source), {
    at: '2026-10-05T10:00:00.000Z',
  });
});

test('read-only fields refuse a changed value, allow an unchanged one', () => {
  const m = {
    version: 2,
    fields: [
      { source: '/content', target: NAME },
      {
        source: '/checked',
        target: 'https://atomicdata.dev/task/v1/status',
        convert: 'map',
        args: {
          pairs: [
            [false, ['todo']],
            [true, ['done']],
          ],
        },
        readOnly: true,
      },
    ],
  };
  const source = { content: 'a', checked: false };
  const view = lensGet(m, source);
  assert.deepEqual(lensPut(m, { ...view, [NAME]: 'b' }, source), {
    content: 'b',
    checked: false,
  });
  code(
    () =>
      lensPut(
        m,
        { ...view, 'https://atomicdata.dev/task/v1/status': ['done'] },
        source,
      ),
    'read-only',
  );
  // Backwards (writing the table from a provider-shaped view) is allowed.
  assert.deepEqual(
    lensPut(m, { content: 'a', checked: true }, view, 'backward'),
    { ...view, 'https://atomicdata.dev/task/v1/status': ['done'] },
  );
});

test('converters are exact or refuse', () => {
  const { map } = CONVERTERS;
  code(() => CONVERTERS['iso-to-ms'].get('2026-02-30T00:00:00Z'), 'bad-value');
  code(() => CONVERTERS['iso-to-ms'].get('2026-10-05'), 'bad-value');
  code(
    () => CONVERTERS['iso-to-ms'].get('2026-10-05T09:00:00.0001Z'),
    'precision',
  );
  assert.equal(
    CONVERTERS['iso-to-ms'].get('2026-10-05T09:00:00.123000Z'),
    Date.UTC(2026, 9, 5, 9, 0, 0, 123),
  );
  code(() => CONVERTERS['iso-seconds-to-ms'].put(1500), 'precision');
  assert.equal(
    CONVERTERS['iso-seconds-to-ms'].put(Date.UTC(2026, 9, 5, 9)),
    '2026-10-05T09:00:00Z',
  );
  code(() => CONVERTERS['ms-to-iso'].get(1.5), 'bad-value');
  assert.equal(CONVERTERS['day-of'].get('2026-10-08T18:00:00'), '2026-10-08');
  code(() => CONVERTERS['day-of'].get('2026-13-01'), 'bad-value');
  code(() => map.get(2, { pairs: [[1, 'a']] }), 'unmapped-value');
  code(
    () =>
      map.get(1, {
        pairs: [
          [1, 'a'],
          [2, 'a'],
        ],
      }),
    'bad-args',
  );
  assert.deepEqual(map.put(['done'], { pairs: [[true, ['done']]] }), true);
});

test('storedMapping round-trips, deepEqual is structural', () => {
  const m = {
    version: 2,
    fields: [{ source: '/a', target: NAME, readOnly: false }],
  };
  assert.deepEqual(storedMapping(m), m);
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: undefined }, {}));
  assert.ok(!deepEqual([1, 2], [2, 1]));
});

test('endpoint keys and the #2069 CatalogLens shape', () => {
  assert.equal(
    endpointKey({ class: 'https://x.example/c' }),
    'https://x.example/c',
  );
  assert.equal(
    endpointKey({
      record: {
        provider: 'todoist.com',
        resource: 'task',
        openapi: 'APIs/todoist.com/1',
      },
    }),
    'record:APIs/todoist.com/1#task',
  );
  assert.equal(
    endpointKey({ record: { provider: 'raindrop.io', resource: 'raindrop' } }),
    'record:raindrop.io#raindrop',
  );
  assert.equal(
    endpointKey({ rdf: 'http://x.example/B' }),
    'rdf:http://x.example/B',
  );
  code(() => endpointKey({}), 'bad-endpoint');
  const info = catalogLensInfo({
    '@id': 'https://x.example/lenses/a-v1',
    name: 'A',
    source: { class: 'https://x.example/c' },
    target: { rdf: 'http://x.example/B' },
    mapping: { version: 2, fields: [{ source: NAME, target: '/n' }] },
  });
  assert.equal(info.subject, 'https://x.example/lenses/a-v1');
  assert.equal(info.mappingVersion, 2);
});

test('resolverLens adapts a class-to-class lens to resolver.mjs hooks', async () => {
  const { createResolver } = await import('./resolver.mjs');
  const shared = {
    subject: 'https://x.example/classes/time-entry-v1',
    requires: [START],
    recommends: [NAME],
  };
  const lens = resolverLens({
    source: { class: 'https://drive.example/classes/template' },
    target: { class: shared.subject },
    mapping: {
      version: 2,
      fields: [
        { source: 'https://drive.example/properties/title', target: NAME },
        { source: 'https://drive.example/properties/begin', target: START },
      ],
    },
  });
  const fields = createResolver({ classes: [shared], lenses: [lens] });
  assert.ok(fields.accepts('https://drive.example/classes/template'));
  const template = {
    'https://drive.example/properties/title': 'T',
    'https://drive.example/properties/begin': 5,
  };
  assert.deepEqual(lens.read(template), { [NAME]: 'T', [START]: 5 });
  assert.deepEqual(lens.write({ [NAME]: 'U' }, template), {
    'https://drive.example/properties/title': 'U',
  });
  assert.throws(
    () =>
      resolverLens({
        source: { rdf: 'x' },
        target: { class: 'y' },
        mapping: {},
      }),
    LensError,
  );
});

test('day-of takes a civil day or a local date-time, never an instant', () => {
  const day = CONVERTERS['day-of'].get;
  assert.equal(day('2026-10-08'), '2026-10-08');
  assert.equal(day('2026-10-08T18:00'), '2026-10-08');
  assert.equal(day('2026-10-08T18:00:00.5'), '2026-10-08');
  for (const bad of [
    '2026-10-08T22:30:00Z',
    '2026-10-08T22:30:00+02:00',
    '2026-10-08T22:30:00-05:00',
    '2026-10-08Tgarbage',
    '2026-10-08T24:00',
    '2026-10-08T23:60',
    '2026-02-29',
    '0000-01-01',
    20261008,
  ])
    code(() => day(bad), 'bad-value');
});

test('instants: no 24:00, no bad offsets, years 0000-9999 only', () => {
  const toMs = CONVERTERS['iso-to-ms'].get;
  for (const bad of [
    '2026-10-05T24:00:00Z',
    '2026-10-05T23:60:00Z',
    '2026-10-05T23:59:60Z',
    '2026-10-05T10:00:00+24:00',
    '2026-10-05T10:00:00+01:60',
    '0000-01-01T00:00:00+01:00',
  ])
    code(() => toMs(bad), 'bad-value');
  assert.equal(toMs('0000-01-01T00:00:00Z'), -62167219200000);
  for (const bad of [8.64e15, 253402300800000, -62167219200001, NaN, '1'])
    code(() => CONVERTERS['ms-to-iso'].get(bad), 'bad-value');
  code(() => CONVERTERS['iso-seconds-to-ms'].put(-62167219201000), 'bad-value');
});

test('path tokens cannot reach prototypes', () => {
  for (const ref of ['/__proto__', '/a/constructor', '/prototype/x'])
    code(
      () =>
        parseMapping({ version: 2, fields: [{ source: '/a', target: ref }] }),
      'bad-reference',
    );
  code(
    () =>
      parseMapping({
        version: 1,
        fields: [{ source: 'a', target: '__proto__' }],
      }),
    'bad-reference',
  );
  // An inherited name is just a key: written as an own property.
  const m = { version: 2, fields: [{ source: '/a', target: '/toString/x' }] };
  const got = lensGet(m, { a: 1 });
  assert.ok(Object.hasOwn(got, 'toString'));
  assert.deepEqual(got.toString, { x: 1 });
  assert.equal(typeof Object.prototype.toString, 'function');
  assert.deepEqual(lensPut(m, { toString: { x: 2 } }, { a: 1 }), { a: 2 });
  // An own __proto__ key in a row is copied as data, not as a prototype.
  const hostile = JSON.parse('{"a": 1, "__proto__": {"polluted": true}}');
  const put = lensPut(m, { toString: { x: 3 } }, hostile);
  assert.equal(Object.getPrototypeOf(put), Object.prototype);
  assert.equal(put.polluted, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptor(put, '__proto__').value, {
    polluted: true,
  });
});

test('only parseMapping output skips validation', () => {
  const forged = {
    version: 2,
    fields: [
      {
        source: '/a',
        target: 'not a reference',
        sourcePath: ['a'],
        targetPath: ['__proto__'],
        converter: CONVERTERS.identity,
      },
    ],
  };
  code(() => lensGet(forged, { a: 1 }), 'bad-mapping');
  const parsed = parseMapping({
    version: 2,
    fields: [{ source: '/a', target: NAME }],
  });
  assert.deepEqual(lensGet(parsed, { a: 1 }), { [NAME]: 1 });
});

test('values must be JSON-like and at most 64 levels deep', () => {
  const m = { version: 2, fields: [{ source: '/a', target: NAME }] };
  let deep = 1;
  for (let i = 0; i < 100; i++) deep = { d: deep };
  code(() => lensGet(m, { a: deep }), 'bad-value');
  code(() => deepEqual(deep, structuredClone(deep)), 'bad-value');
  code(() => lensGet(m, { a: NaN }), 'bad-value');
  code(() => lensGet(m, { a: new Date(0) }), 'bad-value');
  code(() => lensGet(m, { a: () => 1 }), 'bad-value');
});

test('lawProblems runs backwards too', () => {
  const m = {
    version: 2,
    fields: [
      { source: '/n', target: NAME },
      { source: '/due', target: START, convert: 'day-of', readOnly: true },
    ],
  };
  assert.deepEqual(
    lawProblems(
      m,
      { [NAME]: 'x', [START]: '2026-10-08' },
      { n: 'y' },
      'backward',
    ),
    [],
  );
});
