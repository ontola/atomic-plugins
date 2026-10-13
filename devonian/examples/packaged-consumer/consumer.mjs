/* global console, process, structuredClone */
// A Devonian consumer as an npm user writes one: plain ESM, only the
// package's public entry points (`devonian/atomic`, `devonian/lenses`), no
// TypeScript and no access to the package's sources. It runs one
// deterministic scenario against an in-memory platform and prints a JSON
// summary; any unexpected state exits non-zero.
//
//   node consumer.mjs [checkpoint-directory]
//
// __tests__/packaged/consumer.test.ts runs it against the packed tarball
// (`pnpm pack`), installed the way npm would, with no network (#259).
import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
  Datatype,
  IS_A,
} from 'devonian/atomic';
import { fieldLens, recordLens } from 'devonian/lenses';

const SCOPE = 'https://example.com/accounts/acme';
const TASK = 'https://example.com/classes/Task';
const TITLE = 'https://example.com/properties/title';
const DONE = 'https://example.com/properties/done';
const BASE = 'https://example.com/bridge';

/** The platform: records by id, created once per idempotency key. */
class Platform {
  records = new Map();
  byKey = new Map();
  next = 1;
  failNextUpdate = false;
  calls = [];

  connector() {
    return {
      id: (record) => record.id,
      get: async (id) => {
        this.calls.push(`get ${id}`);
        const record = this.records.get(id);
        if (!record) throw new Error(`missing ${id}`);
        return structuredClone(record);
      },
      create: async (record, key) => {
        this.calls.push('create');
        if (this.byKey.has(key)) return structuredClone(this.byKey.get(key));
        const created = { ...record, id: `t${this.next++}` };
        this.byKey.set(key, created);
        this.records.set(created.id, structuredClone(created));
        return structuredClone(created);
      },
      update: async (id, record) => {
        this.calls.push(`update ${id}`);
        if (this.failNextUpdate) {
          this.failNextUpdate = false;
          throw new Error('platform unavailable');
        }
        this.records.set(id, structuredClone(record));
      },
      delete: async (id) => {
        this.calls.push(`delete ${id}`);
        this.records.delete(id);
      },
    };
  }
}

/** The platform's task fields as the native view: a value lens. */
const fields = recordLens({
  title: fieldLens('title'),
  done: fieldLens('done'),
});

/** A host: store, identity map and lens, from a checkpoint or fresh. */
function host(platform, checkpoint) {
  const store = new AtomicStore(
    new AtomicSchema()
      .property(TITLE, Datatype.STRING)
      .property(DONE, Datatype.BOOLEAN),
  );
  const identities = new AtomicIdentityMap(store, BASE);
  if (checkpoint) store.loadJSONAD(checkpoint);
  const lens = new AtomicLens({
    store,
    identities,
    connector: platform.connector(),
    scope: SCOPE,
    entity: 'task',
    read: (record) => {
      const view = fields.get(record);
      return {
        set: { [IS_A]: [TASK], [TITLE]: view.title, [DONE]: view.done },
      };
    },
    write: (resource, previous) => {
      const before = previous ?? { id: '', title: '', done: false };
      return fields.put(
        { title: resource[TITLE], done: resource[DONE] === true },
        before,
      );
    },
  });
  return { store, identities, lens };
}

function check(condition, message) {
  if (!condition) {
    console.error(`consumer: ${message}`);
    process.exit(1);
  }
}

const dir =
  process.argv[2] ?? mkdtempSync(join(tmpdir(), 'devonian-consumer-'));
const file = join(dir, 'state.json');
const platform = new Platform();
platform.records.set('t0', {
  id: 't0',
  title: 'Write docs',
  done: false,
  labels: ['x'],
});
const summary = {};

// 1. Ingest a platform record.
let h = host(platform);
const ingested = await h.lens.ingest(platform.records.get('t0'));
summary.ingested = h.store.get(ingested)[TITLE];

// 2. A native edit, published: the platform gets it, unmanaged fields kept.
h.store.patch(ingested, { set: { [DONE]: true } });
await h.lens.publish(ingested);
summary.afterEdit = platform.records.get('t0');

// 3. A failing update rejects; the next publish succeeds.
platform.failNextUpdate = true;
h.store.patch(ingested, { set: { [TITLE]: 'Write the docs' } });
summary.failure = await h.lens.publish(ingested).then(
  () => 'resolved',
  (error) => error.message,
);
await h.lens.publish(ingested);
summary.afterRetry = platform.records.get('t0').title;

// 4. A new native resource, published: created on the platform.
const created = `${BASE}/tasks/new-1`;
h.store.patch(created, {
  set: { [IS_A]: [TASK], [TITLE]: 'Ship it', [DONE]: false },
});
summary.createdId = await h.lens.publish(created);

// 5. Checkpoint after awaited work, then restart from it.
writeFileSync(`${file}.tmp`, h.store.toJSONAD());
renameSync(`${file}.tmp`, file);
h = host(platform, readFileSync(file, 'utf8'));

// 6. After the restart, the same resource updates the same record.
h.store.patch(created, { set: { [DONE]: true } });
summary.afterRestartId = await h.lens.publish(created);
summary.platformRecords = platform.records.size;
summary.creates = platform.calls.filter((c) => c === 'create').length;

check(summary.ingested === 'Write docs', 'ingest');
check(
  summary.afterEdit.done === true && summary.afterEdit.labels[0] === 'x',
  'edit',
);
check(summary.failure === 'platform unavailable', 'failure');
check(summary.afterRetry === 'Write the docs', 'retry');
check(summary.afterRestartId === summary.createdId, 'restart identity');
check(summary.platformRecords === 2 && summary.creates === 1, 'no duplicate');
console.log(JSON.stringify(summary));
