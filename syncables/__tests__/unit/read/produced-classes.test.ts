// @wc-ignore-file
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  absoluteIri,
  checkProduces,
  createApiClient,
  lensFits,
  parseProduces,
  producedClasses,
  resourcesProducing,
  sameSubject,
  type OpenApiDocument,
} from '../../../src/browser.js';
import { discoverReadModel } from '../../../src/read/model.js';

// Produced Classes 0.1.0-draft (`x-produces`) on the spec's own example
// (`openapi-extensions/spec/produced-classes/examples/time-entries.yaml`),
// with its `test_validate.py` ValidationTests mirrored through
// `checkProduces`, and `lensFits` on the published catalog lenses
// (`ontology/lenses/`). Nothing is fetched.

const repository = new URL('../../../../', import.meta.url);
const EXAMPLE = yaml.load(
  readFileSync(
    new URL(
      'openapi-extensions/spec/produced-classes/examples/time-entries.yaml',
      repository,
    ),
    'utf8',
  ),
) as OpenApiDocument;
const lensFile = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`ontology/lenses/${name}`, repository), 'utf8'),
  );

const example = (): OpenApiDocument => structuredClone(EXAMPLE);
type Entry = Record<string, unknown>;
const produces = (document: OpenApiDocument): Entry[] =>
  (
    document.components!['crudResources'] as Record<
      string,
      Record<string, Entry[]>
    >
  )['timeEntry']!['x-produces']!;

const TIME_ENTRY = 'https://ontology.example/classes/time-entry-v1';

describe('producedClasses on the spec example', () => {
  it('reads both resources, in document order, without x-* fields', () => {
    const document = example();
    produces(document)[0]!['x-note'] = { anything: true };
    expect(producedClasses(document)).toEqual([
      {
        resource: 'timeEntry',
        classes: [
          {
            class: TIME_ENTRY,
            lens: 'https://ontology.example/lenses/example-time-entry-v1',
            description: 'A running timer has no end.',
          },
        ],
      },
      {
        resource: 'project',
        classes: [
          { class: 'https://ontology.example/classes/work-project-v1' },
          { class: 'urn:example:classes:cost-centre' },
        ],
      },
    ]);
  });

  it('leaves out resources without the field, and reads nothing elsewhere (rule 1)', () => {
    const document = example();
    const resources = document.components!['crudResources'] as Record<
      string,
      Record<string, unknown>
    >;
    delete resources['project']!['x-produces'];
    (resources['project']!['collections'] as Record<string, Entry>)[
      'projects'
    ]!['x-produces'] = [{ class: 'https://o.example/c' }];
    document.paths['/projects']!.get!['x-produces'] = [
      { class: 'https://o.example/d' },
    ];
    expect(producedClasses(document).map((r) => r.resource)).toEqual([
      'timeEntry',
    ]);
    expect(producedClasses({ openapi: '3.0.3', paths: {} })).toEqual([]);
  });

  it('reports a declaration that does not parse, located, with no classes', () => {
    const document = example();
    produces(document)[0]!['class'] = 'relative';
    expect(producedClasses(document)[0]).toEqual({
      resource: 'timeEntry',
      errors: [
        'components.crudResources.timeEntry.x-produces[0].class: expected an absolute IRI',
      ],
    });
  });

  it("reads a Swagger 2.0 document's root x-crudResources", () => {
    const document = {
      swagger: '2.0',
      'x-crudResources': {
        item: { 'x-produces': [{ class: 'https://o.example/c' }] },
      },
    };
    expect(producedClasses(document)).toEqual([
      { resource: 'item', classes: [{ class: 'https://o.example/c' }] },
    ]);
    document['x-crudResources'].item['x-produces'] = [];
    expect(producedClasses(document)).toEqual([
      {
        resource: 'item',
        errors: ['x-crudResources.item.x-produces: expected a nonempty array'],
      },
    ]);
  });
});

describe('checkProduces (ValidationTests, rules 2-6)', () => {
  const errorsOf = (mutate: (list: Entry[]) => unknown): string[] => {
    const document = example();
    const list = produces(document);
    const replaced = mutate(list);
    return checkProduces(replaced === undefined ? list : replaced);
  };

  it('accepts the example', () => {
    expect(errorsOf(() => undefined)).toEqual([]);
  });

  it('rule 2: a nonempty array', () => {
    expect(checkProduces([])).toEqual([
      'x-produces: expected a nonempty array',
    ]);
    expect(checkProduces({ class: 'https://o.example/c' })).toEqual([
      'x-produces: expected a nonempty array',
    ]);
  });

  it('rule 3: fields', () => {
    expect(errorsOf((l) => void delete l[0]!['class'])).toContain(
      'x-produces[0]: class is required',
    );
    expect(errorsOf((l) => void (l[0]!['fields'] = {}))).toContain(
      'x-produces[0].fields: unknown field',
    );
    expect(
      errorsOf((l) => [...l, 'https://o.example/c' as unknown as Entry]),
    ).toContain('x-produces[1]: expected an object');
    expect(errorsOf((l) => void (l[0]!['x-note'] = { a: 1 }))).toEqual([]);
  });

  it.each([
    'time-entry-v1',
    '/classes/time-entry-v1',
    'https://',
    'https:///path',
    'https://a b',
    '',
    7,
    null,
  ])('rule 4: refuses %j as a class', (bad) => {
    expect(errorsOf((l) => void (l[0]!['class'] = bad))).toContain(
      'x-produces[0].class: expected an absolute IRI',
    );
  });

  it('rule 4: a lens must be an absolute IRI too, and these are', () => {
    expect(errorsOf((l) => void (l[0]!['lens'] = 'lenses/x'))).toContain(
      'x-produces[0].lens: expected an absolute IRI',
    );
    for (const good of [
      'https://o.example/c',
      'http://o.example/c#Thing',
      'urn:example:c',
      'did:web:o.example',
      'https://ontologie.example/klassen/tijdregistratie-ü',
      'https://例え.example/クラス',
    ])
      expect({ good, ok: absoluteIri(good) }).toEqual({ good, ok: true });
  });

  it('rule 5: scheme and host compare case-insensitively, the path exactly', () => {
    expect(
      errorsOf((l) => [
        ...l,
        { class: 'HTTPS://Ontology.Example/classes/time-entry-v1' },
      ]),
    ).toEqual([
      'x-produces[1].class: HTTPS://Ontology.Example/classes/time-entry-v1 appears twice',
    ]);
    expect(
      errorsOf((l) => [
        ...l,
        { class: 'https://ontology.example/classes/Time-Entry-v1' },
      ]),
    ).toEqual([]);
    expect(sameSubject('HTTPS://User@Host.Example/A')).toBe(
      'https://User@host.example/A',
    );
    expect(sameSubject('URN:Example:A')).toBe('urn:Example:A');
  });

  it('rule 5: unique classes', () => {
    expect(errorsOf((l) => [...l, { class: TIME_ENTRY }])).toEqual([
      `x-produces[1].class: ${TIME_ENTRY} appears twice`,
    ]);
  });

  it('rule 6: description', () => {
    expect(errorsOf((l) => void (l[0]!['description'] = ['no']))).toEqual([
      'x-produces[0].description: expected a string',
    ]);
  });

  it('reports every violation, and parseProduces reads nothing then', () => {
    const list = [{ class: 'relative', lens: 'x', fields: 1 }];
    expect(checkProduces(list)).toHaveLength(3);
    expect(parseProduces(list)).toBeUndefined();
    expect(parseProduces(undefined)).toBeUndefined();
  });
});

describe('resourcesProducing', () => {
  it('finds the resources for a class, as the same subject', () => {
    expect(
      resourcesProducing(
        example(),
        'HTTPS://ONTOLOGY.EXAMPLE/classes/time-entry-v1',
      ),
    ).toEqual([
      {
        resource: 'timeEntry',
        produced: expect.objectContaining({ class: TIME_ENTRY }),
      },
    ]);
    expect(
      resourcesProducing(example(), 'urn:example:classes:cost-centre'),
    ).toEqual([
      {
        resource: 'project',
        produced: { class: 'urn:example:classes:cost-centre' },
      },
    ]);
    // The path is exact; a relative class names nothing.
    expect(
      resourcesProducing(
        example(),
        'https://ontology.example/classes/Time-Entry-v1',
      ),
    ).toEqual([]);
    expect(resourcesProducing(example(), 'time-entry-v1')).toEqual([]);
  });

  it('offers nothing from a declaration that does not parse', () => {
    const document = example();
    produces(document).push({ class: TIME_ENTRY });
    expect(resourcesProducing(document, TIME_ENTRY)).toEqual([]);
  });
});

describe('the read model and the client', () => {
  it('puts the classes on every collection of the resource', () => {
    const { collections } = discoverReadModel(example());
    expect(
      Object.fromEntries(
        collections.map((c) => [c.name, c.produces?.map((p) => p.class)]),
      ),
    ).toEqual({
      entries: [TIME_ENTRY],
      projects: [
        'https://ontology.example/classes/work-project-v1',
        'urn:example:classes:cost-centre',
      ],
    });
  });

  it('leaves produces out when the declaration does not parse', () => {
    const document = example();
    produces(document)[0]!['class'] = 'relative';
    const entries = discoverReadModel(document).collections.find(
      (c) => c.name === 'entries',
    );
    expect(entries).not.toHaveProperty('produces');
  });

  it('ApiClient.produces gives a copy, or nothing', () => {
    const document = example();
    delete (
      document.components!['crudResources'] as Record<
        string,
        Record<string, unknown>
      >
    )['project']!['x-produces'];
    const client = createApiClient(document, {
      transport: () => Promise.reject(new Error('no requests')),
    });
    const classes = client.produces('entries');
    expect(classes.map((p) => p.class)).toEqual([TIME_ENTRY]);
    classes.pop();
    expect(client.produces('entries')).toHaveLength(1);
    expect(client.produces('projects')).toEqual([]);
  });
});

describe('lensFits (§4.2) on the published catalog lenses', () => {
  const clockify = {
    class:
      'https://ontola.github.io/atomic-plugins/ontology/classes/time-entry-v1',
    lens: 'https://ontola.github.io/atomic-plugins/ontology/lenses/clockify-time-entry-v2',
  };
  const source = { provider: 'clockify.me', resource: 'timeEntry' };

  it('fits a lens whose target class and source record are the entry’s', () => {
    expect(lensFits(clockify, lensFile('clockify-time-entry-v2'), source)).toBe(
      true,
    );
    // The class compared as the same subject.
    expect(
      lensFits(
        {
          ...clockify,
          class:
            'HTTPS://Ontola.GitHub.io/atomic-plugins/ontology/classes/time-entry-v1',
        },
        lensFile('clockify-time-entry-v2'),
        source,
      ),
    ).toBe(true);
  });

  it('does not fit another target class, provider or resource', () => {
    const lens = lensFile('clockify-time-entry-v2');
    expect(
      lensFits(
        {
          ...clockify,
          class:
            'https://ontola.github.io/atomic-plugins/ontology/classes/issue-v1',
        },
        lens,
        source,
      ),
    ).toBe(false);
    expect(
      lensFits(clockify, lens, { provider: 'todoist.com', resource: 'task' }),
    ).toBe(false);
    expect(
      lensFits(clockify, lens, {
        provider: 'clockify.me',
        resource: 'project',
      }),
    ).toBe(false);
  });

  it('does not fit a lens whose source is not a provider record', () => {
    // solid-bookmark-v1: an rdf source, a class target.
    expect(
      lensFits(
        {
          class: 'https://atomicdata.dev/class/Bookmark',
          lens: 'https://ontola.github.io/atomic-plugins/ontology/lenses/solid-bookmark-v1',
        },
        lensFile('solid-bookmark-v1'),
        { provider: 'raindrop.io', resource: 'raindrop' },
      ),
    ).toBe(false);
  });

  it('does not fit an entry without a lens, or a document that is not an object', () => {
    expect(
      lensFits(
        { class: clockify.class },
        lensFile('clockify-time-entry-v2'),
        source,
      ),
    ).toBe(false);
    expect(lensFits(clockify, 'not a lens', source)).toBe(false);
  });

  it('checks only what the lens names', () => {
    expect(lensFits(clockify, {}, source)).toBe(true);
    expect(lensFits(clockify, { target: { record: source } }, source)).toBe(
      false,
    );
  });
});
