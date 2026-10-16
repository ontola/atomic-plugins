// @wc-ignore-file
/**
 * The Notion live check (integrations/LIVE_TESTING.md, "The live-check kit"):
 * the drive app's own controller and sync code, run from Node against one real,
 * disposable Notion data source through a relay stand-in. It covers the
 * mock e2e's scenarios (import, a remote edit, a reviewed edit sent as a
 * PATCH, a conflict, a page archived in Notion) and records evidence.
 *
 * The app syncs every data source shared with the integration, so the run
 * refuses unless the integration sees exactly the one named by
 * `--i-understand-this-writes-to <data source id>`, that data source's title
 * looks disposable, and it holds no page that is not a trashed
 * `livecheck-...` leftover. `allow` refuses any request that addresses another
 * data source or a page this run did not create.
 *
 * Notion's API cannot delete a page: cleanup moves the pages this run
 * created to the trash (`in_trash: true`) and records their ids.
 */
import { createController, type ViewState } from '../app/controller.js';
import { fakeStore } from '../app/fakeStore.js';
import { loadSchema } from '../app/record.js';
import type { HostProxy, JSONValue } from '../app/store.js';
import { notionFieldShortname } from '../devonian/notion/index.js';
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

export const NOTION_API = 'https://api.notion.com';
/** `apiVersion` in notion/package.json and `API_VERSION` in notion/model.ts. */
export const NOTION_VERSION = '2026-03-11';

export interface NotionCheckOptions {
  /** The data source id, as typed after the confirm flag. */
  dataSource: string;
  token: string;
  fetcher?: Parameters<typeof createProvider>[0]['fetcher'];
  outDir?: string;
  maxMutations?: number;
  maxMs?: number;
  preflightOnly?: boolean;
  log?: (line: string) => unknown;
  now?: () => Date;
}

/** Notion ids with or without dashes, in any case, compare equal. */
export const normalizeId = (id: string) => id.replaceAll('-', '').toLowerCase();

/** Search and data source query are POSTs that only read. */
export const isRead = ({
  method,
  pathname,
}: {
  method: string;
  pathname: string;
}) =>
  method === 'POST' &&
  (pathname === '/v1/search' ||
    /^\/v1\/data_sources\/[^/]+\/query$/.test(pathname));

export function allowFor(
  dataSource: string,
  isCreated: (pageId: string) => boolean,
) {
  const target = normalizeId(dataSource);

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

    const scope = 'not in this check’s scope.';

    if (pathname === '/v1/users/me')
      return method === 'GET' && who === 'driver' ? undefined : refuse(scope);
    if (method === 'POST' && pathname === '/v1/search') return;
    if (method === 'POST' && pathname === '/v1/pages')
      return who === 'driver'
        ? undefined
        : refuse('only the kit creates pages; the app never does.');

    const source = pathname.match(/^\/v1\/data_sources\/([^/]+)(\/query)?$/);

    if (source) {
      if (normalizeId(decodeURIComponent(source[1]!)) !== target)
        return refuse(
          'this run may only touch the data source named by --i-understand-this-writes-to.',
        );
      if (source[2] ? method === 'POST' : method === 'GET' && who === 'driver')
        return;

      return refuse(scope);
    }

    const page = pathname.match(/^\/v1\/pages\/([^/]+)$/);

    if (page && ['GET', 'PATCH'].includes(method)) {
      if (!isCreated(normalizeId(decodeURIComponent(page[1]!))))
        return refuse('that page was not created by this run.');

      return;
    }

    return refuse(scope);
  };
}

export const NOT_COVERED = [
  'Pages created in the table and sent to Notion (the app does not create pages), and pages deleted for good (the API has no delete: the run moves its pages to the trash).',
  'Select, status, multi-select, checkbox, rich text, URL, e-mail and phone properties, and formatted text (only the title and one number property are seeded and edited).',
  'Data sources with more than a handful of pages (paging at 100) and rate limits (429): the run paces its requests but does not provoke one.',
  'A lost write response (the "unknown" outcome), an expired or revoked secret (401), and a data source unshared from the integration after the first sync.',
  'More than one data source shared with the integration: the preflight refuses that.',
  'The consent bar, Notion’s OAuth and the integration proxy: this run uses an internal integration secret and a relay stand-in.',
  'The host, the frame and the table: the controller ran against an in-memory store.',
];

interface NotionPage {
  id: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: { data_source_id?: string };
  properties: Record<
    string,
    { id: string; type: string; [type: string]: unknown }
  >;
}

interface Property {
  id: string;
  name: string;
  type: string;
}

const plain = (parts: unknown): string =>
  Array.isArray(parts)
    ? parts
        .map(p => (p as { plain_text?: unknown }).plain_text)
        .filter((t): t is string => typeof t === 'string')
        .join('')
    : '';

const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

/** Notion allows an average of 3 requests a second: keep clear of that. */
function pacedFetch(minGapMs: number) {
  let last = 0;

  return async (url: string, init: Record<string, unknown>) => {
    const pause = last + minGapMs - Date.now();
    if (pause > 0) await wait(pause);
    last = Date.now();

    return globalThis.fetch(url, init as RequestInit);
  };
}

export async function runNotionCheck(options: NotionCheckOptions): Promise<{
  doc: EvidenceDocument;
  files: { json: string; markdown: string };
}> {
  const { dataSource, token } = options;
  const redact = createRedactor(
    { NOTION_TOKEN: token },
    { keep: [dataSource] },
  );
  const log = createLogger(redact, options.log);
  const budget = createBudget({
    ...(options.maxMutations === undefined
      ? {}
      : { maxMutations: options.maxMutations }),
    ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
  });
  /** Creation receipts: page ids (normalized) this run made, and which it trashed. */
  const pages = new Set<string>();
  const trashed = new Set<string>();
  const provider: Provider = createProvider({
    baseUrl: NOTION_API,
    authHeaders: () => ({
      authorization: `Bearer ${token}`,
      'notion-version': NOTION_VERSION,
      'user-agent': 'atomic-plugins-live-check',
    }),
    allow: allowFor(dataSource, id => pages.has(id)),
    isRead,
    budget,
    redact,
    fetcher: (options.fetcher ?? pacedFetch(350)) as NonNullable<
      Parameters<typeof createProvider>[0]['fetcher']
    >,
  });
  const target: { kind: string; id: string; name?: string } = {
    kind: 'data source',
    id: dataSource,
  };
  const recorder = createRecorder({
    app: 'notion',
    provider: 'Notion',
    apiVersion: `Notion API ${NOTION_VERSION}`,
    candidate: describeCandidate('notion', {
      packageFile: 'integrations/notion/package.json',
      folder: 'integrations/notion',
    }),
    target,
    redact,
    log,
    limits: budget,
    ...(options.now ? { now: options.now } : {}),
  });
  const prefix = recorder.prefix;

  const driver = {
    get: (path: string) => provider.request({ who: 'driver', path }),
    send: (method: string, path: string, body?: unknown) =>
      provider.request({
        who: 'driver',
        method,
        path,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    page: async (id: string) =>
      (await driver.get(`/v1/pages/${id}`)).body as NotionPage,
  };

  let titleProperty: Property | undefined;
  let numberProperty: Property | undefined;
  const N: Record<string, string> = {};
  const sentBodies: Array<{ path: string; body: unknown }> = [];

  const titleOf = (page: NotionPage) =>
    plain(page.properties[titleProperty!.name]?.title);
  const numberOf = (page: NotionPage) =>
    page.properties[numberProperty!.name]?.number as number | null;
  const setNumber = (value: number) => ({
    properties: { [numberProperty!.name]: { number: value } },
  });

  const create = async (title: string, points: number) => {
    const r = await driver.send('POST', '/v1/pages', {
      parent: { type: 'data_source_id', data_source_id: dataSource },
      properties: {
        [titleProperty!.name]: {
          title: [{ type: 'text', text: { content: title } }],
        },
        [numberProperty!.name]: { number: points },
      },
    });
    if (r.status !== 200) throw new Error(`POST page answered ${r.status}`);
    const made = r.body as NotionPage;
    // Receipt first: cleanup removes it even when the next check fails.
    pages.add(normalizeId(made.id));
    if (
      normalizeId(made.parent?.data_source_id ?? '') !== normalizeId(dataSource)
    )
      throw new GuardError(
        'Notion created a page outside the named data source; it is in the cleanup list.',
      );

    return made.id;
  };

  const standIn = relayStandIn(provider, 'notion');
  const proxy = {
    ...standIn,
    async request(req: Parameters<typeof standIn.request>[0]) {
      if (req.method === 'PATCH' && typeof req.body === 'string')
        sentBodies.push({ path: req.path, body: JSON.parse(req.body) });

      return standIn.request(req);
    },
  };
  const store = fakeStore({ proxy: proxy as unknown as HostProxy });
  const controller = createController(store, () => {});
  const appPatches = () =>
    provider.requests.filter(r => r.who === 'app' && r.method === 'PATCH');
  const appWrites = () =>
    provider.requests.filter(
      r => r.who === 'app' && r.method !== 'GET' && !r.read,
    );

  const ready = (state: ViewState) => {
    if (state.kind !== 'ready')
      throw new Error(
        `Expected a ready view, got ${state.kind}${'message' in state ? `: ${state.message}` : ''}`,
      );

    return state;
  };

  const rows = () => {
    const state = controller.state();

    return 'rows' in state ? state.rows : [];
  };

  const rowOf = (pageId: string) =>
    rows().find(r => normalizeId(r.pageId ?? '') === normalizeId(pageId));

  const changes = () => {
    const state = controller.state();

    return 'changes' in state ? (state.changes ?? []) : [];
  };

  const outcomes = (state: ViewState) =>
    'outcomes' in state ? (state.outcomes ?? []) : [];
  const numberShortname = () => notionFieldShortname(numberProperty!.id);
  const titleShortname = () => notionFieldShortname(titleProperty!.id);
  const valueOf = (pageId: string, shortname: string) =>
    rowOf(pageId)?.values[shortname];

  /** An edit made in the host (the table, another view): straight to the store. */
  const editRow = async (
    pageId: string,
    shortname: string,
    value: JSONValue,
  ) => {
    const schema = (await loadSchema(store))!;
    const row = rowOf(pageId)!;
    const resource = await store.getResource(row.subject);
    resource.set(schema.columns.get(shortname)!.subject, value);
    await resource.save();
  };

  await recorder.step(
    'S0',
    'Preflight: the data source is disposable, alone in the integration and empty',
    async ({ check, equal, note, observe }) => {
      const me = await provider.request({
        who: 'driver',
        path: '/v1/users/me',
      });
      if (me.status !== 200)
        throw new Error(`GET /v1/users/me answered ${me.status}`);
      check('the secret works (GET /v1/users/me)', true);

      const source = await driver.get(
        `/v1/data_sources/${encodeURIComponent(dataSource)}`,
      );
      if (source.status !== 200)
        throw new GuardError(
          `The data source is not reachable with this secret (GET answered ${source.status}). Share its database with the integration.`,
        );
      const info = source.body as {
        id: string;
        title: unknown;
        archived?: boolean;
        in_trash?: boolean;
        properties: Record<string, Property>;
      };
      target.name = plain(info.title);
      check(
        'it is the named data source',
        normalizeId(info.id) === normalizeId(dataSource),
      );
      requireDisposableName('data source', target.name);
      check('its title looks disposable', true);
      check(
        'it is not archived or in the trash',
        info.archived !== true && info.in_trash !== true,
      );
      const properties = Object.values(info.properties);
      titleProperty = properties.find(p => p.type === 'title');
      numberProperty = properties.find(p => p.type === 'number');
      check(
        'it has a title property and a number property',
        Boolean(titleProperty && numberProperty),
        properties.map(p => p.type),
      );
      if (!titleProperty || !numberProperty)
        throw new GuardError(
          'The data source needs a Number property (the run edits one). Add a column of type Number.',
        );

      const search = await driver.send('POST', '/v1/search', {
        filter: { property: 'object', value: 'data_source' },
        page_size: 100,
      });
      if (search.status !== 200)
        throw new Error(`POST /v1/search answered ${search.status}`);
      const visible = (search.body as { results: Array<{ id: string }> })
        .results;
      equal(
        'the integration sees no data source but this one (the app syncs every shared one)',
        visible.map(s => normalizeId(s.id)),
        [normalizeId(dataSource)],
      );
      if (visible.length !== 1)
        throw new GuardError(
          'The integration is shared with other data sources, and the app would import them all. Use an integration shared with the test database only.',
        );

      const query = await driver.send(
        'POST',
        `/v1/data_sources/${encodeURIComponent(dataSource)}/query`,
        { page_size: 100 },
      );
      if (query.status !== 200)
        throw new Error(`query answered ${query.status}`);
      const existing = (query.body as { results: NotionPage[] }).results;
      const foreign = existing.filter(
        p =>
          !(
            (p.in_trash === true || p.archived === true) &&
            /^livecheck-/.test(titleOf(p))
          ),
      );
      equal(
        'it holds no page that is not a trashed livecheck-... leftover',
        foreign.length,
        0,
      );
      if (foreign.length)
        throw new GuardError(
          'The data source has pages that are not leftovers of this kit; use a new, empty data source.',
        );
      observe('how many pages the query lists before the run', existing.length);
      note(`Run prefix ${prefix}.`);
    },
  );

  if (!options.preflightOnly) {
    await recorder.step(
      'S1',
      'Seed two pages with a title and a number through the Notion API',
      async ({ equal }) => {
        N.one = await create(`${prefix} one`, 3);
        N.two = await create(`${prefix} two`, 5);
        equal('two pages seeded', Object.keys(N).sort(), ['one', 'two']);
      },
    );

    await recorder.step(
      'S2',
      'Import: connect, read the data source and its pages',
      async ({ check, equal, observe }) => {
        await controller.load();
        const state = ready(await controller.sync());
        const last = state.last;
        equal(
          'two rows were created, one data source was read',
          [last?.created, last?.dataSources.length],
          [2, 1],
        );
        equal(
          'row one: title and number',
          [
            rowOf(N.one)?.name,
            valueOf(N.one, titleShortname()),
            valueOf(N.one, numberShortname()),
          ],
          [`${prefix} one`, `${prefix} one`, 3],
        );
        equal(
          'row two: title and number',
          [rowOf(N.two)?.name, valueOf(N.two, numberShortname())],
          [`${prefix} two`, 5],
        );
        check(
          'both rows carry a Notion URL',
          Boolean(rowOf(N.one)?.url && rowOf(N.two)?.url),
        );
        equal(
          'nothing is waiting to be sent and the app wrote nothing to Notion',
          [changes().length, appWrites().length],
          [0, 0],
        );
        observe('how many pages the sync read, and its warnings', {
          pages: last?.dataSources[0]?.pages,
          general: last?.general,
        });
      },
    );

    await recorder.step(
      'S3',
      'A second sync changes nothing',
      async ({ equal }) => {
        const state = ready(await controller.sync());
        equal(
          'created, updated, unchanged',
          [state.last?.created, state.last?.updated, state.last?.unchanged],
          [0, 0, 2],
        );
        equal(
          'nothing to send, nothing written',
          [changes().length, appWrites().length],
          [0, 0],
        );
      },
    );

    await recorder.step(
      'S4',
      'A Notion-side edit is pulled in',
      async ({ equal }) => {
        const r = await driver.send('PATCH', `/v1/pages/${N.two}`, {
          properties: {
            [titleProperty!.name]: {
              title: [
                {
                  type: 'text',
                  text: { content: `${prefix} two (changed in Notion)` },
                },
              ],
            },
            [numberProperty!.name]: { number: 9 },
          },
        });
        if (r.status !== 200) throw new Error(`PATCH answered ${r.status}`);
        ready(await controller.sync());
        equal(
          "the row has Notion's title and number",
          [rowOf(N.two)?.name, valueOf(N.two, numberShortname())],
          [`${prefix} two (changed in Notion)`, 9],
        );
        equal(
          'nothing to send: Notion’s edit is not a local change',
          changes().length,
          0,
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S5',
      'A reviewed edit is listed, then sent as one PATCH of only the changed property',
      async ({ check, equal, observe }) => {
        await editRow(N.one, numberShortname(), 4);
        await controller.refreshRows();
        equal(
          'the edit is listed for review: the number, 3 to 4',
          changes().map(c => [
            c.pageId,
            c.fields.map(f => [f.id, f.before, f.after]),
          ]),
          [[N.one, [[numberProperty!.id, 3, 4]]]],
        );
        equal(
          'nothing was sent yet',
          [appPatches().length, numberOf(await driver.page(N.one))],
          [0, 3],
        );
        const state = ready(await controller.send());
        equal(
          'the outcome is "sent", one field',
          outcomes(state).map(o => [o.status, 'fields' in o ? o.fields : 0]),
          [['sent', 1]],
        );
        const at = await driver.page(N.one);
        equal(
          'Notion has the new number and the same title',
          [numberOf(at), titleOf(at)],
          [4, `${prefix} one`],
        );
        const patches = appPatches();
        equal('exactly one PATCH', patches.length, 1);
        equal(
          'its path is the page, its body only the changed property id',
          [
            patches[0]?.path,
            Object.keys(
              (sentBodies.at(-1)?.body as { properties: object })?.properties ??
                {},
            ),
          ],
          [`/v1/pages/${N.one}`, [numberProperty!.id]],
        );
        observe(
          'the PATCH body keys the app sends',
          patches.map(p => p.bodyKeys),
        );
        equal(
          'the next sync updates nothing and nothing is listed',
          [ready(await controller.sync()).last?.updated, changes().length],
          [0, 0],
        );
        check(
          'the row still shows the sent value',
          valueOf(N.one, numberShortname()) === 4,
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S6',
      'The same property changed on both sides: a conflict, and both resolutions work',
      async ({ check, equal }) => {
        const resolve = (pageId: string, keep: 'mine' | 'notion') =>
          controller.resolve(rowOf(pageId)!.subject, numberShortname(), keep);

        // 1. Found by a sync; "Use Notion's".
        await editRow(N.two, numberShortname(), 6);
        await driver.send('PATCH', `/v1/pages/${N.two}`, setNumber(7));
        let patches = appPatches().length;
        ready(await controller.sync());
        equal(
          'the sync reports a conflict: mine 6, Notion 7, neither side overwritten',
          [
            changes().map(c =>
              c.fields.map(f => [f.conflict, f.after, f.notion]),
            ),
            valueOf(N.two, numberShortname()),
          ],
          [[[[true, 6, 7]]], 6],
        );
        await controller.send();
        equal(
          'Send skips the row with an open conflict',
          appPatches().length,
          patches,
        );
        ready(await resolve(N.two, 'notion'));
        equal(
          "resolved to Notion's value: the row has 7, nothing to send",
          [valueOf(N.two, numberShortname()), changes().length],
          [7, 0],
        );

        // 2. Found at send time: Notion changed after the review.
        await editRow(N.two, numberShortname(), 11);
        await controller.refreshRows();
        await driver.send('PATCH', `/v1/pages/${N.two}`, setNumber(12));
        patches = appPatches().length;
        let state = ready(await controller.send());
        equal(
          'Send finds Notion’s newer value and writes nothing: outcome "changed"',
          [
            outcomes(state).map(o => o.status),
            appPatches().length,
            numberOf(await driver.page(N.two)),
          ],
          [['changed'], patches, 12],
        );
        check(
          'the row is now listed as a conflict',
          changes().some(c => c.fields.some(f => f.conflict)),
        );
        ready(await resolve(N.two, 'notion'));

        // 3. "Keep mine": still a change, then sent over Notion's value.
        await editRow(N.one, numberShortname(), 8);
        await driver.send('PATCH', `/v1/pages/${N.one}`, setNumber(10));
        ready(await controller.sync());
        state = ready(await resolve(N.one, 'mine'));
        equal(
          'keeping mine leaves a plain change (10 to 8), no conflict, nothing sent yet',
          [
            changes().map(c =>
              c.fields.map(f => [f.before, f.after, f.conflict]),
            ),
            numberOf(await driver.page(N.one)),
          ],
          [[[[10, 8, undefined]]], 10],
        );
        ready(await controller.send());
        equal(
          'Notion has the kept value',
          numberOf(await driver.page(N.one)),
          8,
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S7',
      'A page archived in Notion is reported "gone", not deleted: the row and the edit stay',
      async ({ check, equal, observe }) => {
        await editRow(N.two, numberShortname(), 13);
        await controller.refreshRows();
        equal('an edit to the row is waiting', changes().length, 1);
        const r = await driver.send('PATCH', `/v1/pages/${N.two}`, {
          in_trash: true,
        });
        if (r.status !== 200) throw new Error(`trash answered ${r.status}`);
        trashed.add(normalizeId(N.two));
        const gone = await driver.page(N.two);
        observe('the page as GET returns it once trashed', {
          archived: gone.archived,
          in_trash: gone.in_trash,
        });
        const patches = appPatches().length;
        const state = ready(await controller.send());
        equal(
          'Send reports the page as gone and writes nothing',
          [outcomes(state).map(o => o.status), appPatches().length],
          [['gone'], patches],
        );
        equal(
          'the row is still there with the edit',
          [rows().length, valueOf(N.two, numberShortname())],
          [2, 13],
        );
        const after = ready(await controller.sync());
        equal(
          'a sync afterwards keeps both rows and the edit; nothing is deleted',
          [rows().length, valueOf(N.two, numberShortname())],
          [2, 13],
        );
        observe('what the sync reports for the archived page', {
          pagesRead: after.last?.dataSources[0]?.pages,
          archived: after.last?.dataSources[0]?.archived,
        });
        check('the other row is unaffected', rowOf(N.one) !== undefined);
      },
      { continueOnFailure: true },
    );
  }

  // Cleanup: move the pages this run created to the trash.
  const created = [...pages].map(id => `page:${id}`);
  const cleanup: EvidenceDocument['cleanup'] = {
    status: 'passed',
    created,
    deleted: [] as string[],
    leftover: [] as string[],
    note: undefined as string | undefined,
  };
  if (created.length) {
    budget.extendForCleanup(created.length);

    for (const id of pages) {
      const key = `page:${id}`;

      if (trashed.has(id)) {
        (cleanup.deleted as string[]).push(`${key} (trashed during the run)`);
        continue;
      }

      try {
        const r = await driver.send('PATCH', `/v1/pages/${id}`, {
          in_trash: true,
        });
        (r.status < 300
          ? (cleanup.deleted as string[])
          : (cleanup.leftover as string[])
        ).push(r.status < 300 ? `${key} (trashed)` : key);
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
        `${cleanup.note ?? ''} Move these pages to the trash by hand: ${(cleanup.leftover as string[]).join(', ')}`.trim();
    } else
      cleanup.note =
        'Notion cannot delete pages over its API: they were moved to the trash (restorable from Notion’s trash for a while). The preflight of a later run accepts them as trashed livecheck-... leftovers.';
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
    options.outDir ?? defaultEvidenceDir('notion'),
    redact,
  );

  return { doc, files };
}
