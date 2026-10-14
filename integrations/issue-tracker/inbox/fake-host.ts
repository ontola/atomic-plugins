// @wc-ignore-file
/**
 * Test helper: the parts of atomic-server's sync session (`sync_session.rs`,
 * `connection_state.rs`) the inbox plugin relies on, in memory. A run is a
 * `preview` invocation, then `step` invocations until `complete`; each
 * effect is applied before the next step, which gets its receipt as
 * `result`. An `atomic` effect mints a subject per create and resolves
 * `local:` references; a `checkpoint` effect, allowed once and last, writes
 * its records into the connection state (the host's own `cursor` is always
 * cleared there, so it is not modelled). `stopAfterAtomic` stops a run right
 * after its `atomic` effect was applied, before the checkpoint: the saved
 * session can be resumed (`advance`), or abandoned for a fresh run.
 */
import { FakeInbox } from '../../../syncables/__tests__/unit/inbox/fake-inbox.js';
import type { Config, Ctx, Cursor, Output, Proposal } from './plugin.js';
import { run } from './plugin.js';
import type { ConnectionState, Intent } from './journal.js';
import { DELIVERY_FIELDS, GAP_FIELDS, WORK_FIELDS } from './schema.js';

export { FakeInbox };

const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
export const DRIVE = 'https://drive.test';

export function config(overrides: Partial<Config> = {}): Config {
  const properties = Object.fromEntries(
    [...DELIVERY_FIELDS, ...WORK_FIELDS, ...GAP_FIELDS].map(([shortname]) => [
      shortname,
      `${DRIVE}/properties/${shortname}`,
    ]),
  );
  return {
    repository: 'fixture-owner/fixture-repo',
    table: `${DRIVE}/deliveries`,
    rowClass: `${DRIVE}/classes/webhook-delivery`,
    properties,
    tables: {
      work: {
        table: `${DRIVE}/work`,
        rowClass: `${DRIVE}/classes/webhook-work-item`,
      },
      gaps: {
        table: `${DRIVE}/gaps`,
        rowClass: `${DRIVE}/classes/webhook-gap`,
      },
    },
    ...overrides,
  };
}

export interface Session {
  proposal: Proposal;
  cursor: Cursor | null;
  result: unknown;
  checkpointed: boolean;
  completed: Set<string>;
  status: 'running' | 'complete';
}

export class FakeHost {
  readonly rows = new Map<string, Record<string, unknown>>();
  connection: Required<ConnectionState> = { revision: 0, records: {} };
  readonly sent: { operation: string; method: string; url: string }[] = [];
  /** Every effect a run returned, in order. */
  readonly effects: string[] = [];
  /** A property whose query throws, to simulate a failing host read. */
  failQuery: string | undefined;
  private minted = 0;

  constructor(
    readonly inbox: FakeInbox,
    readonly settings: Config = config(),
    readonly connections: Record<string, string> = {
      'github-issues': 'c-1',
    },
  ) {}

  /** The input of one invocation. */
  ctx(phase: Ctx['phase'], session?: Session): Ctx {
    return {
      phase,
      config: this.settings,
      connections: this.connections,
      // A copy, as the host serialises it into the input.
      connection: JSON.parse(JSON.stringify(this.connection)),
      proposal: session?.proposal ?? null,
      cursor: session?.cursor ?? null,
      result: session?.result ?? null,
      trigger: { kind: 'manual', at: this.inbox.now },
      query: (property, value) => {
        if (property === this.failQuery) throw new Error('query failed');
        return [...this.rows]
          .filter(([, row]) => row[property] === value)
          .map(([subject]) => subject);
      },
      read: (subject) => {
        const row = this.rows.get(subject);
        if (!row) throw new Error(`no such resource ${subject}`);
        return row;
      },
      http: async (request) => {
        this.sent.push({
          operation: request.operation,
          method: request.method,
          url: request.url,
        });
        const response = await this.inbox.transport({
          url: new URL(request.url),
          method: request.method as 'GET' | 'POST' | 'DELETE',
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        return { status: response.status, body: response.body };
      },
    };
  }

  async preview(): Promise<Session> {
    const output = (await run(this.ctx('preview'))) as Output;
    if (output.kind !== 'preview') throw new Error('preview expected');
    return {
      proposal: output.proposal,
      cursor: null,
      result: null,
      checkpointed: false,
      completed: new Set(),
      status: 'running',
    };
  }

  /** `sync_session::advance`: steps until complete, or stopped. */
  async advance(
    session: Session,
    { stopAfterAtomic = false } = {},
  ): Promise<Session> {
    for (let i = 0; i < 32; i++) {
      const output = (await run(this.ctx('step', session))) as Output;
      if (output.kind === 'complete') {
        if (!session.checkpointed) {
          throw new Error('completion requires an acknowledged checkpoint');
        }
        session.status = 'complete';
        return session;
      }
      if (output.kind !== 'effect') throw new Error('unexpected output');
      const { effect } = output;
      if (session.checkpointed || session.completed.has(effect.id)) {
        throw new Error('invalid or repeated effect identity');
      }
      this.effects.push(effect.kind);
      if (effect.kind === 'atomic') {
        session.result = { outcomes: this.apply(effect.verdict.intents) };
      } else {
        this.checkpoint(effect.records);
        session.checkpointed = true;
        session.result = this.connection;
      }
      session.cursor = output.cursor;
      session.completed.add(effect.id);
      if (stopAfterAtomic && effect.kind === 'atomic') return session;
    }
    throw new Error('too many steps');
  }

  /** One whole run: preview, then steps until complete (or stopped). */
  async run(options: { stopAfterAtomic?: boolean } = {}): Promise<Session> {
    return this.advance(await this.preview(), options);
  }

  private apply(intents: Intent[]): { subject: string }[] {
    const bound = new Map<string, string>();
    for (const intent of intents) {
      bound.set(intent.localId, `${DRIVE}/rows/${++this.minted}`);
    }
    const resolve = (value: string) =>
      value.startsWith('local:') ? (bound.get(value.slice(6)) ?? value) : value;
    for (const intent of intents) {
      const row: Record<string, unknown> = {
        [PARENT]: resolve(intent.parent),
        [IS_A]: intent.isA,
      };
      for (const [property, value] of Object.entries(intent.set)) {
        row[property] = resolve(value);
      }
      this.rows.set(bound.get(intent.localId)!, row);
    }
    return intents.map((intent) => ({ subject: bound.get(intent.localId)! }));
  }

  /** `connection_state::checkpoint_once`'s checks and write. */
  private checkpoint(
    records: {
      remote: string;
      local: string;
      local_projection: unknown;
      remote_projection: unknown;
    }[],
  ): void {
    for (const record of records) {
      if (!record.remote || !record.local) {
        throw new Error('record identities must be nonempty');
      }
      if (
        JSON.stringify(record.local_projection) !==
        JSON.stringify(record.remote_projection)
      ) {
        throw new Error('local and remote projections must agree');
      }
      if (
        record.local_projection === null ||
        typeof record.local_projection !== 'object'
      ) {
        throw new Error('a projection must be an object');
      }
      const old = this.connection.records[record.remote];
      if (old && old.local !== record.local) {
        throw new Error('a remote identity cannot be rebound');
      }
      this.connection.records[record.remote] = {
        local: record.local,
        baseline: record.local_projection,
      };
    }
    this.connection.revision += 1;
  }

  /** Rows of a table, as shortname records. */
  table(table: string): Record<string, unknown>[] {
    const names = new Map(
      Object.entries(this.settings.properties).map(([k, v]) => [v, k]),
    );
    return [...this.rows.values()]
      .filter((row) => row[PARENT] === table)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row)
            .filter(([property]) => names.has(property))
            .map(([property, value]) => [names.get(property)!, value]),
        ),
      );
  }

  /** Marks the matching work items `done`, as the issue table's sync would. */
  finishWork(kind: string): void {
    const p = this.settings.properties;
    for (const row of this.rows.values()) {
      if (
        row[PARENT] === this.settings.tables.work.table &&
        row[p['webhook-work-kind']!] === kind
      ) {
        row[p['webhook-work-status']!] = 'done';
      }
    }
  }
}
