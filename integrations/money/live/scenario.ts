// @wc-ignore-file
/**
 * The Moneybird live check (integrations/LIVE_TESTING.md, "The live-check
 * kit"): the read-only drive app's own controller and sync code (its contacts
 * collection; hours and mutations are not covered here), run
 * from Node against one real, disposable Moneybird administration through a
 * relay stand-in. The app only reads, so the kit's driver does the seeding,
 * the remote edit and the cleanup, under the same guard rails as the apps that
 * write: `allow` lets the app `GET` the administration list and this one
 * administration's contacts, and nothing else; the driver may create, edit and
 * delete only contacts this run created.
 *
 * It proves, against the real API, what the mock proxy's fixture could only
 * assume (#274): that the relayed paths carry the `/api/v2` base path.
 * `allow` refuses any app request without it, and the run asserts that every
 * request the app made was answered 200.
 *
 * The administration is named by `--i-understand-this-writes-to <id>`; its
 * name must look disposable and it must hold no contact (archived ones
 * included). A personal API token reaches every administration of its
 * account, so use an account that has only the test administration: the app
 * lists them all in its picker, and the run asserts it sees that list.
 */
import { createController } from '../moneybird/controller.js';
import { CONTACT_FIELDS, sourceId } from '../moneybird/contacts.js';
import { fakeStore, TABLE } from '../moneybird/fakeStore.js';
import type { HostProxy } from '../moneybird/store.js';
import { ensureProperties, PARENT, SOURCE_ID } from '../moneybird/sync.js';
import {
  GuardError,
  createBudget,
  createLogger,
  createProvider,
  createRecorder,
  createRedactor,
  defaultEvidenceDir,
  describeCandidate,
  relayStandIn,
  requireDisposableName,
  writeEvidence,
  type EvidenceDocument,
  type Provider,
} from '../../tooling/live-kit.mjs';

export const MONEYBIRD = 'https://moneybird.com';
/** The version segment of the API's base path; the app's `UPSTREAM` carries it. */
export const BASE_PATH = '/api/v2';

export interface MoneybirdCheckOptions {
  administration: string;
  token: string;
  fetcher?: Parameters<typeof createProvider>[0]['fetcher'];
  outDir?: string;
  maxMutations?: number;
  maxMs?: number;
  preflightOnly?: boolean;
  log?: (line: string) => unknown;
  now?: () => Date;
}

export function allowFor(
  administration: string,
  isCreated: (contactId: string) => boolean,
) {
  return ({
    who,
    method,
    pathname,
  }: {
    who: string;
    method: string;
    pathname: string;
  }) => {
    const refuse = (why: string): never => {
      throw new GuardError(`Refusing ${who} ${method} ${pathname}: ${why}`);
    };

    if (!pathname.startsWith(`${BASE_PATH}/`))
      return refuse(
        `a Moneybird path must start with ${BASE_PATH}/ (the base path of the API).`,
      );
    const path = pathname.slice(BASE_PATH.length);

    if (path === '/administrations.json')
      return method === 'GET' ? undefined : refuse('read-only.');

    const collection = path.match(/^\/(\d+)\/contacts\.json$/);
    const one = path.match(/^\/(\d+)\/contacts\/(\d+)\.json$/);
    const scope = (collection ?? one)?.[1];
    if (!scope) return refuse('not in this check’s scope.');
    if (scope !== administration)
      return refuse(
        'this run may only touch the administration named by --i-understand-this-writes-to.',
      );

    if (collection && method === 'GET') return;
    if (who === 'app')
      return refuse('the app only reads the contact list; it never writes.');
    if (collection && method === 'POST') return;

    if (one && ['GET', 'PATCH', 'DELETE'].includes(method)) {
      if (!isCreated(one[2]!))
        return refuse('that contact was not created by this run.');

      return;
    }

    return refuse('not in this check’s scope.');
  };
}

export const NOT_COVERED = [
  'Hours (time entries) and financial mutations: this check imports the contacts collection only; the other two collections are exercised against the synthetic fixture.',
  'More than 100 contacts: a next page announced by a Link header (the app follows it, within the contacts collection) is exercised only by the offline fake, never against Moneybird.',
  'Archived contacts (the API has no archive call this run uses; the app reads them with include_archived=true, which the preflight uses too), custom fields, contact people, notes, SEPA and tax fields, and every other collection.',
  'Several administrations and the picker’s choice among them: the preflight reads the list but the run does not create a second administration.',
  'A lost response, a revoked token (401), rate limits (150 requests per 5 minutes) and a refresh that fails part-way.',
  'The consent bar, Moneybird’s OAuth and the integration proxy: this run uses a personal API token and a relay stand-in.',
  'The host, the frame and the table: the controller ran against an in-memory store.',
];

interface Contact {
  id: string;
  company_name?: string;
  city?: string;
  version?: number;
  updated_at?: string;
  archived?: boolean;
  administration_id?: string | number;
}

export async function runMoneybirdCheck(
  options: MoneybirdCheckOptions,
): Promise<{
  doc: EvidenceDocument;
  files: { json: string; markdown: string };
}> {
  const { administration, token } = options;
  const redact = createRedactor(
    { MONEYBIRD_API_TOKEN: token },
    { keep: [administration] },
  );
  const log = createLogger(redact, options.log);
  const budget = createBudget({
    ...(options.maxMutations === undefined
      ? {}
      : { maxMutations: options.maxMutations }),
    ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
  });
  const contacts = new Set<string>();
  const deleted = new Set<string>();
  const provider: Provider = createProvider({
    baseUrl: MONEYBIRD,
    authHeaders: () => ({
      authorization: `Bearer ${token}`,
      'user-agent': 'atomic-plugins-live-check',
    }),
    allow: allowFor(administration, id => contacts.has(id)),
    budget,
    redact,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const target: { kind: string; id: string; name?: string } = {
    kind: 'administration',
    id: administration,
  };
  const recorder = createRecorder({
    app: 'moneybird',
    provider: 'Moneybird',
    apiVersion: 'Moneybird REST API v2',
    candidate: describeCandidate('moneybird', {
      packageFile: 'integrations/money/moneybird/package.json',
      folder: 'integrations/money/moneybird',
    }),
    target,
    redact,
    log,
    limits: budget,
    ...(options.now ? { now: options.now } : {}),
  });
  const prefix = recorder.prefix;
  const root = `${BASE_PATH}/${administration}`;

  const driver = {
    get: (path: string, query?: Record<string, string>) =>
      provider.request({
        who: 'driver',
        path: `${BASE_PATH}${path}`,
        ...(query ? { query } : {}),
      }),
    send: (method: string, path: string, body?: unknown) =>
      provider.request({
        who: 'driver',
        method,
        path: `${root}${path}`,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    contacts: async () =>
      (
        await provider.request({
          who: 'driver',
          path: `${root}/contacts.json`,
          query: { per_page: '100', include_archived: 'true' },
        })
      ).body as Contact[],
  };

  const store = fakeStore({ relay: false });
  (store as { proxy?: HostProxy }).proxy = relayStandIn(
    provider,
    'moneybird',
  ) as unknown as HostProxy;
  const controller = createController(store, () => {});
  const appRequests = () => provider.requests.filter(r => r.who === 'app');

  /** The contacts summary of a synced view (this check imports contacts only). */
  const synced = () => {
    const state = controller.state();
    if (state.kind !== 'synced')
      throw new Error(
        `Expected a synced view, got ${state.kind}${'message' in state ? `: ${state.message}` : ''}`,
      );
    const summary = state.results.contacts;
    if (!summary || 'error' in summary)
      throw new Error(
        `Expected a contacts summary, got ${summary ? summary.error : 'nothing'}`,
      );

    return { summary };
  };

  /** The imported rows by contact id, each with its values by shortname. */
  const rows = async () => {
    const properties = await ensureProperties(store, [
      SOURCE_ID,
      ...CONTACT_FIELDS,
    ]);
    const bySubject = new Map(
      [...properties].map(([shortname, subject]) => [subject, shortname]),
    );
    const out = new Map<string, Record<string, unknown>>();

    for (const [, props] of store.resources) {
      if (props[PARENT] !== TABLE) continue;
      const values: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(props)) {
        const shortname = bySubject.get(key);
        if (shortname) values[shortname] = value;
      }

      const identity = String(values[SOURCE_ID.shortname] ?? '');
      const id = identity.split(':contact:')[1];
      if (id) out.set(id, values);
    }

    return out;
  };

  const N: Record<string, string> = {};

  const seed = async (key: string, input: Record<string, unknown>) => {
    const r = await driver.send('POST', '/contacts.json', { contact: input });
    if (r.status !== 201)
      throw new Error(`POST contact ${key} answered ${r.status}`);
    const made = r.body as Contact;
    contacts.add(String(made.id));
    N[key] = String(made.id);

    return made;
  };

  await recorder.step(
    'S0',
    'Preflight: the administration is disposable and holds no contacts',
    async ({ check, equal, note, observe }) => {
      const list = await driver.get('/administrations.json');
      if (list.status !== 200)
        throw new GuardError(
          `GET ${BASE_PATH}/administrations.json answered ${list.status}: check the token.`,
        );
      const all = list.body as Array<{ id: string | number; name?: string }>;
      check('the token works and lists administrations', Array.isArray(all));
      const found = all.find(a => String(a.id) === administration);
      check('the named administration is in the list', Boolean(found));
      if (!found)
        throw new GuardError(
          'The token cannot see that administration. Check its id.',
        );
      target.name = found.name ?? '';
      requireDisposableName('administration', target.name);
      check('its name looks disposable', true);
      observe(
        'how many administrations the token reaches (the app’s picker lists them all)',
        all.length,
      );
      const existing = await driver.contacts();
      equal('it holds no contact, archived ones included', existing.length, 0);
      if (existing.length)
        throw new GuardError(
          'The administration already has contacts; use a new, empty administration.',
        );
      note(`Run prefix ${prefix}.`);
    },
  );

  if (!options.preflightOnly) {
    await recorder.step(
      'S1',
      'Seed three contacts through the Moneybird API',
      async ({ equal }) => {
        await seed('one', {
          company_name: `${prefix} Alpha B.V.`,
          city: 'Utrecht',
          country: 'NL',
        });
        await seed('two', {
          company_name: `${prefix} Beta B.V.`,
          city: 'Delft',
          country: 'NL',
        });
        await seed('three', {
          firstname: 'Pat',
          lastname: `${prefix} Example`,
          country: 'BE',
        });
        equal('three contacts seeded', Object.keys(N).sort(), [
          'one',
          'three',
          'two',
        ]);
      },
    );

    await recorder.step(
      'S2',
      'Import: connect, choose the administration, read its contacts',
      async ({ check, equal, observe }) => {
        await controller.load();
        const picker = controller.state();
        equal(
          'the first open asks which administration, and the target is offered',
          [
            picker.kind,
            picker.kind === 'choosing' &&
              picker.administrations.some(a => a.id === administration),
          ],
          ['choosing', true],
        );
        await controller.select(administration, ['contacts']);
        const state = synced();
        equal(
          'three contacts were added, none updated',
          [
            state.summary.total,
            state.summary.added,
            state.summary.updated,
            state.summary.unchanged,
          ],
          [3, 3, 0, 0],
        );
        const imported = await rows();
        const one = imported.get(N.one);
        equal(
          'contact one: name, company, city, country, administration, source id',
          [
            one?.['moneybird-company-name'],
            one?.['moneybird-city'],
            one?.['moneybird-country'],
            one?.['moneybird-administration-id'],
            one?.[SOURCE_ID.shortname],
          ],
          [
            `${prefix} Alpha B.V.`,
            'Utrecht',
            'NL',
            administration,
            sourceId({ id: N.one }, administration),
          ],
        );
        equal(
          'contact three: a person has first and last name',
          [
            imported.get(N.three)?.['moneybird-firstname'],
            imported.get(N.three)?.['moneybird-lastname'],
          ],
          ['Pat', `${prefix} Example`],
        );
        check(
          'every contact has an integer version and an updated_at string',
          [...imported.values()].every(
            v =>
              Number.isSafeInteger(v['moneybird-version']) &&
              typeof v['moneybird-updated-at'] === 'string',
          ),
        );
        const asked = appRequests();
        equal(
          'every request the app made carried the /api/v2 base path and was answered 200 (#274)',
          [
            asked.length > 0,
            asked.every(
              r => r.path.startsWith(`${BASE_PATH}/`) && r.status === 200,
            ),
            asked.every(r => r.method === 'GET'),
          ],
          [true, true, true],
        );
        observe(
          'the paths the app requested',
          asked.map(r => r.path.split('?')[0]?.replace(/\/\d{6,}\//, '/<id>/')),
        );
      },
    );

    await recorder.step(
      'S3',
      'A second sync writes nothing',
      async ({ equal }) => {
        const writes = store.writes.length;
        const before = (await rows()).get(N.one);
        await controller.sync();
        const state = synced();
        equal(
          'added, updated, unchanged',
          [state.summary.added, state.summary.updated, state.summary.unchanged],
          [0, 0, 3],
        );
        equal(
          'no row was written and the first row is as it was',
          [store.writes.length, (await rows()).get(N.one)],
          [writes, before],
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S4',
      'A Moneybird-side edit is pulled in',
      async ({ check, equal, observe }) => {
        const before = (await rows()).get(N.two);
        const r = await driver.send('PATCH', `/contacts/${N.two}.json`, {
          contact: { company_name: `${prefix} Beta (changed)`, city: 'Leiden' },
        });
        if (r.status !== 200) throw new Error(`PATCH answered ${r.status}`);
        await controller.sync();
        const state = synced();
        equal(
          'one contact updated, two unchanged',
          [state.summary.added, state.summary.updated, state.summary.unchanged],
          [0, 1, 2],
        );
        const after = (await rows()).get(N.two);
        equal(
          "the row has Moneybird's company name and city",
          [after?.['moneybird-company-name'], after?.['moneybird-city']],
          [`${prefix} Beta (changed)`, 'Leiden'],
        );
        check(
          'its version and updated_at changed',
          after?.['moneybird-version'] !== before?.['moneybird-version'] &&
            after?.['moneybird-updated-at'] !==
              before?.['moneybird-updated-at'],
        );
        observe('the version before and after one edit', [
          before?.['moneybird-version'],
          after?.['moneybird-version'],
        ]);
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S5',
      'A contact deleted in Moneybird is kept as a row, not removed',
      async ({ equal }) => {
        const r = await driver.send('DELETE', `/contacts/${N.three}.json`);
        if (r.status >= 300) throw new Error(`DELETE answered ${r.status}`);
        deleted.add(N.three);
        await controller.sync();
        const state = synced();
        equal(
          'the read has two contacts, nothing is written',
          [state.summary.total, state.summary.updated],
          [2, 0],
        );
        equal(
          'the table still has three rows, including the deleted contact',
          (await rows()).size,
          3,
        );
      },
      { continueOnFailure: true },
    );
  }

  // Cleanup: delete the contacts this run created.
  const created = [...contacts].map(id => `contact:${id}`);
  const cleanup: EvidenceDocument['cleanup'] = {
    status: 'passed',
    created,
    deleted: [] as string[],
    leftover: [] as string[],
    note: undefined as string | undefined,
  };
  if (created.length) {
    budget.extendForCleanup(created.length);

    for (const id of contacts) {
      const key = `contact:${id}`;

      if (deleted.has(id)) {
        (cleanup.deleted as string[]).push(`${key} (deleted during the run)`);
        continue;
      }

      try {
        const r = await driver.send('DELETE', `/contacts/${id}.json`);
        (r.status < 300 || r.status === 404
          ? (cleanup.deleted as string[])
          : (cleanup.leftover as string[])
        ).push(key);
      } catch (error) {
        (cleanup.leftover as string[]).push(key);
        cleanup.note = redact(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if ((cleanup.leftover as string[]).length) {
      cleanup.status = 'failed';
      cleanup.note =
        `${cleanup.note ?? ''} Delete these contacts by hand: ${(cleanup.leftover as string[]).join(', ')}`.trim();
    } else cleanup.note = 'Every contact the run created was deleted.';
  } else cleanup.note = 'Nothing was created.';

  const doc = recorder.document({
    cleanup,
    notCovered: NOT_COVERED,
    preflightOnly: options.preflightOnly === true,
    requests: provider.requests,
  });
  doc.target = redact.deep({ ...doc.target, ...target });
  const files = writeEvidence(
    doc,
    options.outDir ?? defaultEvidenceDir('moneybird'),
    redact,
  );

  return { doc, files };
}
