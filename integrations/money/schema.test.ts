// @wc-ignore-file
/**
 * #177 spike S4, as a unit test: the host's own `ensureSchema`
 * (`browser/lib/src/plugin-schema.ts` at the pin) binding money's schema to
 * the shared ontology's published subjects (`PropertySpec.subject`,
 * `ClassSpec.subject`). The store is in memory; the shared terms it serves
 * are the committed files under `ontology/`, as Pages serves them. What it
 * does not cover: the browser and server fetching those terms over the
 * network, which `e2e/money.spec.ts` does against the real GitHub Pages URLs.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ensureSchema,
  type SchemaResource,
  type SchemaStore,
} from '../../browser/lib/src/plugin-schema.js';
import { BASE, classes, properties } from '../../ontology-kit/terms.mjs';
import { bankingSchema, SHARED_FIELDS } from './schema';

const A = 'https://atomicdata.dev/properties/';
const DRIVE = 'http://localhost/drive';
const ONTOLOGY = 'http://localhost/drive/ontology';
const DEFAULT_ONTOLOGY =
  'https://atomicdata.dev/ontology/server/property/default-ontology';

type Props = Record<string, unknown>;

/** A drive with an empty default ontology, plus the published terms. */
function memoryStore() {
  const data = new Map<string, Props>([
    [DRIVE, { [DEFAULT_ONTOLOGY]: ONTOLOGY }],
    [ONTOLOGY, { [`${A}properties`]: [], [`${A}classes`]: [] }],
  ]);
  /** Subjects any `set` or `save` touched. */
  const written = new Set<string>();
  let next = 0;

  const published = (subject: string): Props | undefined => {
    if (!subject.startsWith(`${BASE}/`)) return undefined;
    const file = new URL(
      `../../ontology/${subject.slice(BASE.length + 1)}`,
      import.meta.url,
    );
    const { ['@id']: _id, ...props } = JSON.parse(readFileSync(file, 'utf8'));

    return props;
  };

  const resource = (subject: string): SchemaResource => {
    if (!data.has(subject)) data.set(subject, published(subject) ?? {});
    const props = data.get(subject)!;

    return {
      subject,
      get: property => props[property],
      async set(property, value) {
        written.add(subject);
        props[property] = value;
      },
      async save() {
        written.add(subject);
      },
    };
  };

  const store: SchemaStore = {
    async findByLocalId(_drive, parent, localId) {
      for (const [subject, props] of data)
        if (props[`${A}parent`] === parent && props[`${A}localId`] === localId)
          return resource(subject);

      return undefined;
    },
    async getResource(subject) {
      return resource(subject);
    },
    async newResource({ parent, isA, propVals }) {
      const subject = `${ONTOLOGY}/term-${next++}`;
      data.set(subject, {
        ...propVals,
        [`${A}parent`]: parent,
        [`${A}isA`]: isA,
      });

      return resource(subject);
    },
  };

  return { store, data, written };
}

describe('bankingSchema() bound to the shared ontology (#177 S4)', () => {
  it('reuses the published bank-transaction-v1 and its fields, and mints only the rest', async () => {
    const { store, data, written } = memoryStore();
    const terms = await ensureSchema(store, DRIVE, bankingSchema());

    expect(terms.classes['bank-transaction']).toBe(
      classes['bank-transaction-v1'].subject,
    );
    for (const field of SHARED_FIELDS)
      expect(terms.properties[field]).toBe(properties[field].subject);

    // Import bookkeeping and the statement fields stay the drive's own.
    for (const own of [
      'bank-source-id',
      'bank-fingerprint',
      'bank-statement',
      'bank-transaction-code',
      'bank-closing-balance',
    ])
      expect(terms.properties[own]).toMatch(`${ONTOLOGY}/`);
    expect(terms.classes['bank-statement-record']).toMatch(`${ONTOLOGY}/`);

    // The statement class lists the shared account and currency.
    const statement = data.get(terms.classes['bank-statement-record'])!;
    expect(statement[`${A}requires`]).toEqual(
      expect.arrayContaining([
        properties['bank-account'].subject,
        properties['bank-currency'].subject,
      ]),
    );

    // Nothing published is written to, and the drive's ontology lists the
    // shared terms next to its own.
    for (const subject of written) expect(subject).not.toMatch(BASE);
    expect(data.get(ONTOLOGY)![`${A}classes`]).toContain(
      classes['bank-transaction-v1'].subject,
    );
  });

  it('mirrors the published class in its declaration', () => {
    const spec = bankingSchema();
    const klass = spec.classes.find(c => c.shortname === 'bank-transaction')!;
    const subject = (shortname: string) =>
      spec.properties.find(p => p.shortname === shortname)!.subject;
    const shared = classes['bank-transaction-v1'];
    const name = `${A}name`;

    expect(klass.requires!.map(subject)).toEqual(shared.requires);
    expect(klass.recommends!.map(subject)).toEqual(
      shared.recommends.filter(p => p !== name),
    );
  });

  it('is idempotent: a second Set up binds the same subjects', async () => {
    const { store } = memoryStore();
    const first = await ensureSchema(store, DRIVE, bankingSchema());
    const second = await ensureSchema(store, DRIVE, bankingSchema());
    expect(second).toEqual(first);
  });

  it('refuses a datatype that does not match the published term', async () => {
    const { store } = memoryStore();
    const spec = bankingSchema();
    const amount = spec.properties.find(p => p.shortname === 'bank-amount')!;
    amount.datatype = 'https://atomicdata.dev/datatypes/float' as never;

    await expect(ensureSchema(store, DRIVE, spec)).rejects.toThrow(
      'incompatible property datatype',
    );
  });

  // Recorded limitation, not a wish: on a drive where money 0.3.0 or older
  // ran Set up, its ontology already holds drive-minted `bank-account` etc.
  // The first 0.4.0 Set up adds the shared ones beside them; from then on the
  // host's shortname lookup sees two terms per shortname and refuses.
  it('fails a second Set up on a drive that ran an older Set up before', async () => {
    const { store } = memoryStore();
    const old = bankingSchema();
    for (const p of old.properties) delete p.subject;
    for (const c of old.classes) delete c.subject;
    await ensureSchema(store, DRIVE, old);

    await ensureSchema(store, DRIVE, bankingSchema());
    await expect(ensureSchema(store, DRIVE, bankingSchema())).rejects.toThrow(
      'ambiguous schema shortname',
    );
  });
});
