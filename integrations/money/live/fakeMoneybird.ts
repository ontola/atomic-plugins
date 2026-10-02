// @wc-ignore-file
/**
 * A `fetch` stand-in for the Moneybird live check's offline tests. The mock
 * proxy's fixture (`../fixtures/moneybird/`) is read-only and serves fixed
 * contacts, so this is a small in-memory Moneybird of its own with the same
 * behaviours the fixture documents (the `/api/v2` base path, a bearer token,
 * pages of at most `pageCap` contacts announced by a `Link: rel="next"`
 * header, archived contacts left out unless `include_archived=true`) and the
 * writes the driver makes (`POST` and `PATCH` a contact, `DELETE` one).
 * Test-only; it is evidence about the script, not about Moneybird.
 */
export const TOKEN =
  'mb_offlineTestTokenValueNotReal_0123456789abcdefABCDEFGHIJ';
export const ADMINISTRATION = '100000000000000777';
export const OTHER_ADMINISTRATION = '100000000000000888';

type Contact = Record<string, unknown> & { id: string };

export function fakeMoneybird({
  token = TOKEN,
  name = 'Atomic live-check test',
  administration = ADMINISTRATION,
  // A contact that is already there, for the "not empty" refusal.
  seedForeignContact = false,
  pageCap = 2,
}: {
  token?: string;
  name?: string;
  administration?: string;
  seedForeignContact?: boolean;
  pageCap?: number;
} = {}) {
  const contacts = new Map<string, Contact>();
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
  }> = [];
  let next = 0;
  let version = 1_700_000_000;

  const stamp = () => new Date(Date.UTC(2026, 9, 1, 12, 0, ++version % 60));

  const make = (input: Record<string, unknown>): Contact => {
    const id = String(4_000_000_000_000_000 + ++next);
    const contact: Contact = {
      id,
      administration_id: administration,
      company_name: '',
      firstname: '',
      lastname: '',
      city: '',
      country: 'NL',
      customer_id: String(next),
      archived: false,
      ...input,
      version: ++version,
      updated_at: stamp().toISOString(),
    };
    contacts.set(id, contact);

    return contact;
  };

  if (seedForeignContact) make({ company_name: 'Someone else B.V.' });

  const reply = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => ({
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () =>
      body === null || body === undefined ? '' : JSON.stringify(body),
  });

  const fetcher = async (href: string, init: Record<string, unknown>) => {
    const url = new URL(href);
    const method = String(init.method ?? 'GET');
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    calls.push({ method, path: url.pathname + url.search, headers });
    if (url.origin !== 'https://moneybird.com')
      return reply(404, { error: 'not moneybird' });
    if (headers.authorization !== `Bearer ${token}`)
      return reply(401, { error: 'Invalid token' });
    if (!url.pathname.startsWith('/api/v2/'))
      return reply(404, { error: 'not in the API' });
    const path = url.pathname.slice('/api/v2'.length);
    const body =
      typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    if (method === 'GET' && path === '/administrations.json')
      return reply(200, [
        { id: administration, name, currency: 'EUR' },
        ...(administration === ADMINISTRATION
          ? []
          : [{ id: ADMINISTRATION, name: 'Other', currency: 'EUR' }]),
      ]);

    const collection = path.match(/^\/(\d+)\/contacts\.json$/);
    const one = path.match(/^\/(\d+)\/contacts\/(\d+)\.json$/);
    const scope = (collection ?? one)?.[1];
    if (scope !== administration)
      return reply(404, { error: 'record not found' });

    if (collection && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const asked = Number(url.searchParams.get('per_page') ?? '50');
      if (!Number.isInteger(page) || page < 1 || !(asked >= 1 && asked <= 100))
        return reply(400, { error: 'Invalid pagination' });
      const all = [...contacts.values()].filter(
        c => url.searchParams.get('include_archived') === 'true' || !c.archived,
      );
      const size = Math.min(asked, pageCap);
      const link = new URL(url.href);
      link.searchParams.set('page', String(page + 1));

      return reply(
        200,
        structuredClone(all.slice((page - 1) * size, page * size)),
        page * size < all.length ? { link: `<${link.href}>; rel="next"` } : {},
      );
    }

    if (collection && method === 'POST') {
      const input = body?.contact;
      if (!input || typeof input !== 'object')
        return reply(422, { error: 'contact is required' });

      return reply(201, structuredClone(make(input)));
    }

    const existing = one ? contacts.get(one[2]!) : undefined;
    if (one && !existing) return reply(404, { error: 'record not found' });

    if (one && method === 'GET') return reply(200, structuredClone(existing));

    if (one && method === 'PATCH') {
      Object.assign(existing!, body?.contact ?? {}, {
        version: ++version,
        updated_at: stamp().toISOString(),
      });

      return reply(200, structuredClone(existing));
    }

    if (one && method === 'DELETE') {
      contacts.delete(one[2]!);

      return reply(204, null);
    }

    return reply(404, { error: 'not in the API' });
  };

  return { fetcher, calls, contacts };
}
