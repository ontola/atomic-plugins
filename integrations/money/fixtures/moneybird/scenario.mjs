/**
 * Moneybird mock-proxy fixture, registered as `moneybird` in
 * integrations/localthought/fixtures/index.mjs. Its rows come from one of
 * two sources, in this order:
 *
 *   api/            the recorded, redacted API v2 answers record.mjs writes
 *                   against a real test administration (atomic-plugins#102).
 *                   Not present yet: nobody here has an account.
 *   synthetic.mjs   SYNTHETIC rows hand-written from the pinned read-only
 *                   OpenAPI document (read its header). Used until api/
 *                   exists.
 *
 * `recorded()` says which; `source()` gives the rows either way.
 *
 * Served, read-only like the real proxy's Moneybird catalog entry:
 *   GET /proxy/moneybird/api/v2/administrations.json
 *   GET /proxy/moneybird/api/v2/<administration_id>/contacts.json
 *       [?page=<n>][&per_page=<k>][&include_archived=true]
 *   GET /proxy/moneybird/api/v2/<administration_id>/time_entries.json
 *       [?page=<n>][&per_page=<k>][&filter=period:this_year,state:all]
 *   GET /proxy/moneybird/api/v2/<administration_id>/financial_accounts.json
 *   GET /proxy/moneybird/api/v2/<administration_id>/financial_mutations.json
 *       [?filter=period:<YYYYMMDD>..<YYYYMMDD> | period:this_year]
 * Any other method is 403; any other path, or an unknown administration, 404.
 *
 * Behaviours that are the fixture's own, for tests, and NOT claims about
 * Moneybird, over whichever rows it serves:
 * - Contacts and time entries pages hold at most PAGE_CAP (2) records
 *   whatever `per_page` asks (the real API honours per_page up to 100), so
 *   every read crosses a page boundary. The next page is announced with a
 *   `Link: <…>; rel="next"` header, as Moneybird documents for paginated
 *   collections.
 * - Every second read of an administration's contacts (counted by page-1
 *   requests) fails on page 2 with 503. That gives a host test a refresh
 *   that fails after a good one, without a control endpoint, and shows the
 *   other collections going on. `outage: false` on create() turns it off.
 * - `financial_mutations.json` answers at most `mutationCap` records (100,
 *   the limit the pinned document states; a test lowers it to exercise the
 *   app's period halving) within the `period` the filter asks, oldest
 *   first. It has no pages, as in the document. `this_year` and no filter
 *   mean the source's YEAR: the current civil year in Europe/Amsterdam for
 *   the synthetic rows, the recording's year (meta.json) once recorded.
 * - The time entries `filter` is accepted and not applied beyond `period:
 *   this_year` (every synthetic entry is in YEAR; a recording holds what
 *   Moneybird answered for that filter); other periods return the same.
 *
 * Archived contacts are left out unless `include_archived=true`, which is
 * what overlays/APIs/moneybird.com/v2-readonly/all-records-selection.json asks for.
 *
 * Recording: `MONEYBIRD_TOKEN=<token> node
 * integrations/money/fixtures/moneybird/record.mjs` (its header has the
 * options and the redaction list). The app asks for `period:this_year` by
 * its own clock, so a recording's dated rows match the app's requests only
 * in the year it was made; re-record after New Year.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as synthetic from './synthetic.mjs';

/** record.mjs writes here; a test may point `apiDir` at an invented api/. */
export const API_DIR = new URL('./api/', import.meta.url);
export const PAGE_CAP = 2;
/** The document's stated limit on one financial_mutations.json answer. */
export const MUTATIONS_CAP = 100;
const UPSTREAM = 'https://moneybird.com/api/v2';

const PERIOD = /(?:^|,)period:(\d{8})\.\.(\d{8})(?:,|$)/;

/** `YYYYMMDD` of a `YYYY-MM-DD` date. */
const compact = date => date.replace(/-/g, '');

export const recorded = (apiDir = API_DIR) =>
  existsSync(new URL('meta.json', apiDir));

const loadJson = file => JSON.parse(readFileSync(file, 'utf8'));

/** Every page of one recorded paged collection, flattened to its rows. */
function loadPages(apiDir, administration, collection) {
  const rows = [];

  for (let n = 1; ; n++) {
    const file = new URL(
      `GET__${administration}__${collection}__page-${n}.json`,
      apiDir,
    );
    if (!existsSync(file)) break;
    rows.push(...loadJson(file).body);
  }

  return rows;
}

/**
 * The rows per administration and the year their dated rows fall in, from
 * api/ or synthetic.mjs: `{ synthetic, year, administrations, contacts,
 * timeEntries, financialAccounts, financialMutations }`, the last four keyed
 * by administration id.
 */
export function source({ apiDir = API_DIR } = {}) {
  if (!recorded(apiDir))
    return {
      synthetic: true,
      year: synthetic.YEAR,
      administrations: structuredClone(synthetic.administrations),
      contacts: structuredClone(synthetic.contacts),
      timeEntries: structuredClone(synthetic.timeEntries),
      financialAccounts: structuredClone(synthetic.financialAccounts),
      financialMutations: structuredClone(synthetic.financialMutations),
    };
  const meta = loadJson(new URL('meta.json', apiDir));
  if (!Number.isInteger(Number(meta.year)) || !(Number(meta.year) > 2000))
    throw new Error(
      `${new URL('meta.json', apiDir).pathname}: no "year" (the civil year the recording's dated rows fall in); re-run record.mjs`,
    );
  const administrations = loadJson(
    new URL('GET__administrations.json', apiDir),
  ).body;
  const byAdministration = load =>
    Object.fromEntries(administrations.map(a => [String(a.id), load(a.id)]));

  const single = collection => id => {
    const file = new URL(`GET__${id}__${collection}.json`, apiDir);

    return existsSync(file) ? loadJson(file).body : [];
  };

  return {
    synthetic: false,
    year: Number(meta.year),
    administrations,
    contacts: byAdministration(id => loadPages(apiDir, id, 'contacts')),
    timeEntries: byAdministration(id => loadPages(apiDir, id, 'time_entries')),
    financialAccounts: byAdministration(single('financial_accounts')),
    financialMutations: byAdministration(single('financial_mutations')),
  };
}

export function moneybirdFixture({
  outage = true,
  mutationCap = MUTATIONS_CAP,
  apiDir = API_DIR,
} = {}) {
  const {
    synthetic: isSynthetic,
    year,
    administrations,
    contacts,
    timeEntries,
    financialAccounts,
    financialMutations,
  } = source({ apiDir });
  const reads = new Map();
  /** Every financial_mutations.json filter asked, in order (for tests). */
  const mutationFilters = [];

  /** One page of `rows`, with a Link header to the next when there is one. */
  const page = (url, collection, rows) => {
    const number = Number(url.searchParams.get('page') ?? '1');
    const asked = Number(url.searchParams.get('per_page') ?? '50');
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      !(asked >= 1 && asked <= 100)
    )
      return { status: 400, body: { error: 'Invalid pagination' } };
    const size = Math.min(asked, PAGE_CAP);
    const body = rows.slice((number - 1) * size, number * size);
    const next = new URL(`${UPSTREAM}${collection}`);
    for (const [key, value] of url.searchParams)
      next.searchParams.set(key, value);
    next.searchParams.set('page', String(number + 1));

    return {
      status: 200,
      body: structuredClone(body),
      headers:
        number * size < rows.length
          ? { Link: `<${next.href}>; rel="next"` }
          : {},
    };
  };

  return {
    synthetic: isSynthetic,
    year,
    reads,
    mutationFilters,
    request(method, url) {
      // The real proxy matches the path with the document's server base
      // path (`/api/v2`) included; without it the operation is not in the
      // catalog.
      const prefix = `/proxy/moneybird${new URL(UPSTREAM).pathname}`;
      if (!url.pathname.startsWith(`${prefix}/`))
        return { status: 404, body: { error: 'not in the catalog' } };
      const path = url.pathname.slice(prefix.length);
      if (method !== 'GET') return { status: 403, body: {} };
      if (path === '/administrations.json')
        return { status: 200, body: structuredClone(administrations) };

      const match = path.match(
        /^\/(\d+)\/(contacts|time_entries|financial_accounts|financial_mutations)\.json$/,
      );
      if (!match || !contacts[match[1]])
        return { status: 404, body: { error: 'record not found' } };
      const [, administration, collection] = match;

      if (collection === 'contacts') {
        const number = Number(url.searchParams.get('page') ?? '1');
        if (number === 1)
          reads.set(administration, (reads.get(administration) ?? 0) + 1);
        if (outage && number === 2 && reads.get(administration) % 2 === 0)
          return { status: 503, body: { error: 'Synthetic outage' } };
        const archived = url.searchParams.get('include_archived') === 'true';

        return page(
          url,
          path,
          contacts[administration].filter(c => archived || !c.archived),
        );
      }

      if (collection === 'time_entries')
        return page(url, path, timeEntries[administration] ?? []);

      if (collection === 'financial_accounts')
        return {
          status: 200,
          body: structuredClone(financialAccounts[administration] ?? []),
        };

      const filter = url.searchParams.get('filter') ?? 'period:this_year';
      mutationFilters.push(filter);
      const range = filter.match(PERIOD);
      const [from, to] = range
        ? [range[1], range[2]]
        : filter.includes('period:this_year')
          ? [`${year}0101`, `${year}1231`]
          : [undefined, undefined];
      if (!from)
        return { status: 400, body: { error: 'Unsupported period filter' } };
      const rows = (financialMutations[administration] ?? [])
        .filter(m => compact(m.date) >= from && compact(m.date) <= to)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      return { status: 200, body: structuredClone(rows.slice(0, mutationCap)) };
    },
  };
}

export default {
  title: 'Moneybird',
  // A subset of the pinned read-only OpenAPI document: the five operations
  // the Money app reads. The app bundles its own paths; nothing reads this
  // beyond the /catalog listing.
  document: {
    openapi: '3.0.3',
    info: { title: 'Moneybird (synthetic subset)', version: 'v2' },
    servers: [{ url: UPSTREAM }],
    paths: {
      '/administrations.json': { get: { operationId: 'listAdministrations' } },
      '/{administration_id}/contacts.json': {
        get: { operationId: 'listContacts' },
      },
      '/{administration_id}/time_entries.json': {
        get: { operationId: 'listTimeEntries' },
      },
      '/{administration_id}/financial_accounts.json': {
        get: { operationId: 'listFinancialAccounts' },
      },
      '/{administration_id}/financial_mutations.json': {
        get: { operationId: 'listFinancialMutations' },
      },
    },
  },
  create: () => moneybirdFixture(),
};
