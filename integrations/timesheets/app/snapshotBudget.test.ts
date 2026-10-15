// @wc-ignore-file
/**
 * #123 M5's measurement as a committed budget. A first sync of 2,000
 * entries over a 30-day look-back writes the observation log's resources;
 * each is saved with one `/app-write`, whose JSON body carries the
 * resource's strings escaped once more. atomic-server's JSON extractor takes
 * at most 2 MiB (actix's default `JsonConfig`, read from the pinned source,
 * not exercised), so the largest of them, escaped, must stay under
 * BUDGET_BYTES, which leaves room for the rest of the body. A change that
 * grows the log past it fails here instead of at the host; the answer then
 * is the per-week snapshot split #123 M5 already calls for.
 *
 * Entries are the mock's shape (`clockifyEntry`), with a 40-character
 * description, a tag and a project: a live entry carries more fields
 * (rates, `customFieldValues`) and would be larger. Timing is printed,
 * not asserted, since shared CI runners vary.
 */
import { describe, expect, it } from 'vitest';
import {
  clockifyEntry,
  USER,
  WORKSPACE,
} from '../fixtures/clockify/scenario.mjs';
import type { Settings } from './config.js';
import { fakeStore, PARENT } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { ensureSchema } from './schema.js';
import { syncClockify } from './sync.js';
import { relayTransport } from './transport.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse('2026-09-23T12:00:00Z');
const ENTRIES = 2_000;
/** 2 MiB less 256 KiB for the rest of an `/app-write` body. */
const BUDGET_BYTES = 2 * 1024 * 1024 - 256 * 1024;

describe('observation log size at 2,000 entries (#123 M5)', () => {
  it('keeps every log resource, escaped as an /app-write body, under the budget', async () => {
    const proxy = fixtureProxy(NOW);
    // 20-minute entries a minute apart, newest ending an hour before now:
    // 2,000 of them span about 29 days, inside the 30-day window.
    proxy.fixture.state.entries = Array.from({ length: ENTRIES }, (_, i) => {
      const end = NOW - 60 * MINUTE - i * 21 * MINUTE;
      return clockifyEntry(
        `entry-${String(i).padStart(5, '0')}`,
        `Task ${String(i).padStart(4, '0')}: write and review the docs`,
        end - 20 * MINUTE,
        end,
        { tagIds: ['tag-1'] },
      );
    });
    expect(NOW - 60 * MINUTE - ENTRIES * 21 * MINUTE > NOW - 30 * DAY).toBe(
      true,
    );

    const store = fakeStore({ proxy: proxy.request });
    const schema = await ensureSchema(store);
    const settings: Settings = {
      workspaceId: WORKSPACE.id,
      userId: USER.id,
      lookbackDays: 30,
    };
    const transport = relayTransport(store.proxy!, {
      platform: 'clockify',
      connectionId: 'conn-1',
    });
    const started = performance.now();
    const result = await syncClockify(store, transport, settings, schema, NOW, {
      clock: () => NOW,
      newId: () => crypto.randomUUID(),
      device: 'test',
    });
    const elapsed = performance.now() - started;

    const head = store.resources.get('did:ad:app')![schema.log.log] as string;
    const sizes = [...store.resources.values()]
      .filter(r => r[PARENT] === head || r === store.resources.get(head))
      .flatMap(r =>
        [schema.log.snapshot, schema.log.observation, schema.log.head]
          .map(field => r[field])
          .filter((v): v is string => typeof v === 'string')
          .map(v => ({
            field: field(schema, v, r),
            bytes: Buffer.byteLength(JSON.stringify(v)),
          })),
      );
    const largest = Math.max(...sizes.map(s => s.bytes));
    const snapshot = Math.max(
      0,
      ...sizes.filter(s => s.field === 'snapshot').map(s => s.bytes),
    );

    console.info(
      `#123 M5 at ${ENTRIES} entries: first sync ${Math.round(elapsed)} ms, ` +
        `largest log resource ${largest} bytes escaped, snapshot ${snapshot}, ` +
        `budget ${BUDGET_BYTES}`,
    );
    expect(result.log.snapshotWritten).toBe(true);
    expect(snapshot).toBeGreaterThan(0);
    expect(largest).toBeLessThan(BUDGET_BYTES);
  });
});

/** Which log field a value came from, for the printed figures. */
function field(
  schema: Awaited<ReturnType<typeof ensureSchema>>,
  value: string,
  resource: Record<string, unknown>,
): 'snapshot' | 'observation' | 'head' {
  if (resource[schema.log.snapshot] === value) return 'snapshot';
  if (resource[schema.log.observation] === value) return 'observation';
  return 'head';
}
