// @wc-ignore-file
/**
 * Read-only access to the Moneybird operations the Money app uses:
 * `GET /administrations.json`, and under one administration `contacts.json`,
 * `time_entries.json`, `financial_accounts.json` and
 * `financial_mutations.json`. Nothing here writes to Moneybird, and nothing
 * here holds a credential: a `MoneybirdGet` is the host's proxy relay (see
 * transport in sync.ts).
 *
 * Contacts and time entries are paginated collections: the reader follows
 * the provider's `Link: <…>; rel="next"` header, as Moneybird documents for
 * them, and only to URLs under the same collection. Financial mutations are
 * not: the pinned OpenAPI document gives that list only a `filter` and says
 * it is "limited to 100 financial mutations" (developer.moneybird.com says
 * the same, and points at a synchronization API the read-only document does
 * not carry). So `readFinancialMutations` asks per period window, splitting
 * a window that comes back at the limit (see there). All of this is verified
 * against the synthetic fixture (fixtures/moneybird/), not a recording.
 */

export const UPSTREAM = 'https://moneybird.com/api/v2';
/** Moneybird's maximum `per_page`. */
export const PAGE_SIZE = 100;
/** 200 pages of 100: past this, a Link loop is more likely than a real administration. */
export const MAX_PAGES = 200;
/** What one `financial_mutations.json` answer holds at most, per the pinned document. */
export const MUTATIONS_CAP = 100;
/**
 * At most this many `financial_mutations.json` requests per import. A year
 * of n mutations needs about 1 + 2 · (n / 100) · log2(365) requests with the
 * halving below; 200 covers roughly 1,000 mutations a year, well under the
 * provider's announced 150 requests per 300 s only when they are spread.
 */
export const MAX_MUTATION_REQUESTS = 200;

export interface MoneybirdResponse {
  status: number;
  /** Lower-cased names. */
  headers?: Record<string, string>;
  body: unknown;
}

/** One GET of a provider path under UPSTREAM, e.g. `/administrations.json`. */
export type MoneybirdGet = (path: string) => Promise<MoneybirdResponse>;

export interface Administration {
  id: string;
  name: string;
  currency?: string;
}

export type Contact = Record<string, unknown> & { id: string };
export type TimeEntry = Record<string, unknown> & { id: string };
export type FinancialMutation = Record<string, unknown> & { id: string };

export interface FinancialAccount {
  id: string;
  /** The IBAN, when the bank gives one; Moneybird's `identifier`. */
  identifier?: string;
  name?: string;
  currency?: string;
}

export class MoneybirdError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const IDENTIFIER = /^\d{1,20}$/;

/** Moneybird identifiers are digit strings; the API also sends them as numbers. */
export function identifier(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;

  return typeof text === 'string' && IDENTIFIER.test(text) ? text : undefined;
}

function ok(response: MoneybirdResponse, what: string): unknown[] {
  if (response.status === 401 || response.status === 403)
    throw new MoneybirdError(
      `Moneybird refused ${what} (${response.status}); reconnect Moneybird.`,
      response.status,
    );
  if (response.status !== 200)
    throw new MoneybirdError(
      `Moneybird answered ${response.status} for ${what}.`,
      response.status,
    );
  if (!Array.isArray(response.body))
    throw new MoneybirdError(`Moneybird sent no list for ${what}.`);

  return response.body;
}

/** The records of a list body that carry an identifier, keyed by it. */
function keep<T extends { id: string }>(body: unknown[], into: Map<string, T>) {
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue;
    const id = identifier((raw as Record<string, unknown>).id);
    if (id) into.set(id, { ...(raw as Record<string, unknown>), id } as T);
  }
}

const administration = (value: string) => {
  if (!identifier(value))
    throw new MoneybirdError('Choose a Moneybird administration first.');

  return value;
};

export async function readAdministrations(
  get: MoneybirdGet,
): Promise<Administration[]> {
  const body = ok(await get('/administrations.json'), 'administrations');

  return body.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    const id = identifier(record.id);
    if (!id) return [];

    return [
      {
        id,
        name: typeof record.name === 'string' && record.name ? record.name : id,
        ...(typeof record.currency === 'string'
          ? { currency: record.currency }
          : {}),
      },
    ];
  });
}

/** The URL of `rel="next"` in a Link header, if any. */
export function nextLink(header: string | undefined): string | undefined {
  if (!header) return undefined;

  for (const part of header.split(',')) {
    const match = part.match(/^\s*<([^>]*)>\s*;(.*)$/);
    if (match && /(^|;)\s*rel="?next"?\s*(;|$)/i.test(match[2]))
      return match[1];
  }

  return undefined;
}

export interface PageOptions {
  pageSize?: number;
  maxPages?: number;
}

/**
 * Every page of one paginated collection, read before returning, so a
 * failure part-way returns nothing and the caller writes nothing. A record
 * seen twice (it moved between pages while reading) is kept once, with its
 * last-read value.
 */
async function readPages<T extends { id: string }>(
  get: MoneybirdGet,
  collection: string,
  query: string,
  what: string,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES }: PageOptions = {},
): Promise<T[]> {
  const byId = new Map<string, T>();
  let path: string | undefined = `${collection}?per_page=${pageSize}${query}`;

  for (let page = 1; path; page++) {
    if (page > maxPages)
      throw new MoneybirdError(
        `Stopped after ${maxPages} pages of ${what}; the provider kept sending a next page.`,
      );
    const response = await get(path);
    keep(ok(response, `${what} page ${page}`), byId);
    const next = nextLink(response.headers?.link);
    path = next === undefined ? undefined : within(next, collection);
  }

  return [...byId.values()];
}

/**
 * Every contact of one administration, archived ones included (as
 * overlays/APIs/moneybird.com/v2-readonly/all-records-selection.json asks).
 */
export async function readContacts(
  get: MoneybirdGet,
  administrationId: string,
  options: PageOptions = {},
): Promise<Contact[]> {
  return await readPages<Contact>(
    get,
    `/${administration(administrationId)}/contacts.json`,
    '&include_archived=true',
    'contacts',
    options,
  );
}

/**
 * The time entries filter: this year, every state. Passing any `filter`
 * replaces Moneybird's defaults entirely (the pinned document's parameter
 * description), so both keys are spelled out. Running timers (no `ended_at`)
 * stay out, as by default.
 */
export const TIME_ENTRIES_FILTER = 'period:this_year,state:all';

/** This year's time entries of one administration, every state. */
export async function readTimeEntries(
  get: MoneybirdGet,
  administrationId: string,
  options: PageOptions = {},
): Promise<TimeEntry[]> {
  return await readPages<TimeEntry>(
    get,
    `/${administration(administrationId)}/time_entries.json`,
    `&filter=${encodeURIComponent(TIME_ENTRIES_FILTER)}`,
    'time entries',
    options,
  );
}

/** The financial accounts of one administration (one answer, no paging in the document), by id. */
export async function readFinancialAccounts(
  get: MoneybirdGet,
  administrationId: string,
): Promise<Map<string, FinancialAccount>> {
  const body = ok(
    await get(`/${administration(administrationId)}/financial_accounts.json`),
    'financial accounts',
  );
  const accounts = new Map<string, FinancialAccount>();

  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = identifier(record.id);
    if (!id) continue;
    const text = (key: string) =>
      typeof record[key] === 'string' && record[key]
        ? (record[key] as string)
        : undefined;
    accounts.set(id, {
      id,
      ...(text('identifier') ? { identifier: text('identifier') } : {}),
      ...(text('name') ? { name: text('name') } : {}),
      ...(text('currency') ? { currency: text('currency') } : {}),
    });
  }

  return accounts;
}

/** A closed range of civil days, each `YYYYMMDD`, as Moneybird's custom `period` takes them. */
export interface DayRange {
  from: string;
  to: string;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const day = (date: Date) =>
  `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`;
const parse = (yyyymmdd: string) =>
  Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  );

/** The whole civil year. */
export const yearRange = (year: number): DayRange => ({
  from: `${pad(year, 4)}0101`,
  to: `${pad(year, 4)}1231`,
});

/** The two halves of a range of more than one day; `undefined` for one day. */
export function halves(range: DayRange): [DayRange, DayRange] | undefined {
  const from = parse(range.from);
  const to = parse(range.to);
  if (!(from < to)) return undefined;
  const days = Math.round((to - from) / 86_400_000);
  const mid = new Date(from + Math.floor(days / 2) * 86_400_000);
  const next = new Date(mid.getTime() + 86_400_000);

  return [
    { from: range.from, to: day(mid) },
    { from: day(next), to: range.to },
  ];
}

export const periodFilter = (range: DayRange) =>
  `period:${range.from}..${range.to}`;

export interface MutationOptions {
  /** The civil year to import; this UTC year by default. */
  year?: number;
  /** The provider's per-answer limit; the fixture lowers it for tests. */
  cap?: number;
  maxRequests?: number;
}

/**
 * One civil year of financial mutations of one administration.
 *
 * `financial_mutations.json` answers at most `cap` (100) records and has no
 * page parameter in the pinned document, so the year is asked as one
 * `period:YYYYMMDD..YYYYMMDD` window first. A window that comes back with
 * `cap` records or more may be cut short, so it is asked again as two
 * halves, down to single days. A single day at the cap cannot be completed
 * this way and is an error: the import then writes nothing rather than a
 * silently incomplete ledger. Every window is read before returning.
 */
export async function readFinancialMutations(
  get: MoneybirdGet,
  administrationId: string,
  {
    year = new Date().getUTCFullYear(),
    cap = MUTATIONS_CAP,
    maxRequests = MAX_MUTATION_REQUESTS,
  }: MutationOptions = {},
): Promise<FinancialMutation[]> {
  const collection = `/${administration(administrationId)}/financial_mutations.json`;
  const byId = new Map<string, FinancialMutation>();
  let requests = 0;

  const read = async (range: DayRange): Promise<void> => {
    if (++requests > maxRequests)
      throw new MoneybirdError(
        `Stopped after ${maxRequests} requests for financial mutations; the administration has more than this import handles.`,
      );
    const label = `financial mutations ${range.from}..${range.to}`;
    const body = ok(
      await get(`${collection}?filter=${encodeURIComponent(periodFilter(range))}`),
      label,
    );

    if (body.length >= cap) {
      const split = halves(range);
      if (!split)
        throw new MoneybirdError(
          `Moneybird sent ${body.length} financial mutations for ${range.from}, its limit for one answer, so this import cannot tell whether that day has more. Nothing was written.`,
        );
      await read(split[0]);
      await read(split[1]);

      return;
    }

    keep(body, byId);
  };

  await read(yearRange(year));

  return [...byId.values()];
}

/** The provider path of `href`, refused unless it is this collection. */
function within(href: string, collection: string): string {
  let url: URL;

  try {
    url = new URL(href, `${UPSTREAM}/`);
  } catch {
    throw new MoneybirdError('Moneybird sent an unreadable next-page link.');
  }

  const base = new URL(UPSTREAM);
  if (
    url.origin !== base.origin ||
    url.pathname !== `${base.pathname}${collection}`
  )
    throw new MoneybirdError(
      `Refusing a next-page link outside ${collection}: ${url.href}`,
    );

  return `${collection}${url.search}`;
}
