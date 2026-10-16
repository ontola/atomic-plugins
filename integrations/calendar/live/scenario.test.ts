// @wc-ignore-file
/**
 * Offline tests of the Calendar live check: the script's scenarios run
 * against an in-memory Google (`fakeGoogle.ts`), and its guard rails against
 * refusals. They say nothing about Google; they say the script does what its
 * assertions claim before anyone points it at a real account.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeGoogle, TEST_CALENDAR } from './fakeGoogle.js';
import { allowFor, runCalendarCheck } from './scenario.js';

const TOKEN = 'ya29.FAKE-token-for-the-offline-test-0123456789';
const dirs: string[] = [];

const out = () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-calendar-'));
  dirs.push(dir);

  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const run = (
  fake: ReturnType<typeof fakeGoogle>,
  extra: Partial<Parameters<typeof runCalendarCheck>[0]> = {},
) => {
  const logs: string[] = [];
  const dir = out();

  return runCalendarCheck({
    calendarId: TEST_CALENDAR,
    token: TOKEN,
    fetcher: fake.fetcher,
    outDir: dir,
    log: line => logs.push(line),
    ...extra,
  }).then(result => ({ ...result, logs, dir }));
};

const writes = (fake: ReturnType<typeof fakeGoogle>) =>
  fake.calls.filter(c => c.method !== 'GET');

describe('the scenarios, against an in-memory Google', () => {
  it('passes every step, cleans up exactly what it created and writes evidence', async () => {
    const fake = fakeGoogle({ token: TOKEN });
    const { doc, files, logs } = await run(fake);

    const failed = doc.steps.flatMap(s =>
      s.assertions.filter(a => !a.ok).map(a => `${s.id}: ${a.name}`),
    );
    expect({ failed, errors: doc.steps.map(s => s.error) }).toEqual({
      failed: [],
      errors: doc.steps.map(() => undefined),
    });
    expect(doc.steps.map(s => [s.id, s.status])).toEqual([
      ['S0', 'passed'],
      ['S1', 'passed'],
      ['S2', 'passed'],
      ['S3', 'passed'],
      ['S4', 'passed'],
      ['S5', 'passed'],
      ['S6', 'passed'],
      ['S7', 'passed'],
      ['S8', 'passed'],
    ]);
    expect(doc.status).toBe('passed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect((doc.cleanup.created as string[]).length).toBe(5);
    // Every event the run made is a tombstone; nothing else was touched.
    expect([...fake.events.values()].every(e => e.status === 'cancelled')).toBe(
      true,
    );
    expect(fake.events.size).toBe(5);
    expect(doc.limits.mutations).toBeLessThanOrEqual(doc.limits.maxMutations);
    expect(
      doc.requests.filter(r => r.who === 'app' && r.method === 'DELETE'),
    ).toEqual([]);
    // Every write to the calendar carried sendUpdates=none.
    expect(writes(fake).every(c => c.path.includes('sendUpdates=none'))).toBe(
      true,
    );
    // The app's PATCHes carried If-Match; the credential is added by the client only.
    expect(
      fake.calls.filter(c => c.method === 'PATCH' && c.headers['if-match'])
        .length,
    ).toBeGreaterThanOrEqual(3);
    expect(logs.join('')).toContain('step  S5');

    expect(readdirSync(files.json.replace(/\/[^/]+$/, '')).sort()).toEqual(
      [
        files.json.replace(/^.*\//, ''),
        files.markdown.replace(/^.*\//, ''),
      ].sort(),
    );
  });

  it('never writes the credential or an email address to evidence or logs', async () => {
    const fake = fakeGoogle({ token: TOKEN });
    const { files, logs, doc } = await run(fake);

    for (const text of [
      readFileSync(files.json, 'utf8'),
      readFileSync(files.markdown, 'utf8'),
      logs.join(''),
    ]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('FAKE-token');
      expect(text).not.toContain('owner@example.com');
      expect(text).not.toMatch(/Bearer\s+\S{8,}/);
    }

    // The test calendar's own id is the one thing kept, by design.
    expect(JSON.parse(readFileSync(files.json, 'utf8')).target.id).toBe(
      TEST_CALENDAR,
    );
    expect(doc.steps.length).toBe(9);
  });

  it('records requests without bodies: key names only', async () => {
    const fake = fakeGoogle({ token: TOKEN });
    const { doc } = await run(fake);
    const patches = doc.requests.filter(
      r => r.who === 'app' && r.method === 'PATCH',
    );
    expect(patches[0]).toMatchObject({
      bodyKeys: ['location', 'summary'],
      ifMatch: true,
    });
    expect(JSON.stringify(doc.requests)).not.toContain('Invented text');
  });
});

describe('guard rails', () => {
  it('refuses a calendar whose name does not look disposable, before any write', async () => {
    const fake = fakeGoogle({ token: TOKEN, calendarName: 'Family' });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0]).toMatchObject({ id: 'S0', status: 'failed' });
    expect(doc.steps[0].error).toMatch(/does not look disposable/);
    expect(doc.steps.slice(1).every(s => s.status === 'skipped')).toBe(true);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses the primary calendar', async () => {
    const fake = fakeGoogle({ token: TOKEN, primary: true });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/primary/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses a calendar the account cannot write to', async () => {
    const fake = fakeGoogle({ token: TOKEN, accessRole: 'reader' });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
  });

  it('refuses a calendar that already has events', async () => {
    const fake = fakeGoogle({
      token: TOKEN,
      existing: [
        {
          id: 'abcde1',
          summary: 'Mine',
          status: 'confirmed',
          start: { date: '2026-01-01' },
          end: { date: '2026-01-02' },
        },
      ],
    });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/already has events/);
    expect(writes(fake)).toEqual([]);
    expect(fake.events.get('abcde1')?.status).toBe('confirmed');
  });

  it('refuses an id that is not in the account at all', async () => {
    const fake = fakeGoogle({ token: TOKEN });
    const { doc } = await run(fake, {
      calendarId: 'someone-else@group.calendar.google.com',
    });
    expect(doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
  });

  it('a preflight-only run writes nothing', async () => {
    const fake = fakeGoogle({ token: TOKEN });
    const { doc } = await run(fake, { preflightOnly: true });
    expect(doc.status).toBe('preflight-only');
    expect(doc.steps.map(s => s.id)).toEqual(['S0']);
    expect(writes(fake)).toEqual([]);
  });

  it('stops at the write budget, fails, and still removes what it created', async () => {
    const fake = fakeGoogle({ token: TOKEN });
    const { doc } = await run(fake, { maxMutations: 4 });
    expect(doc.status).toBe('failed');
    expect(doc.steps.find(s => s.status === 'failed')?.error).toMatch(
      /provider writes were used/,
    );
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect([...fake.events.values()].every(e => e.status === 'cancelled')).toBe(
      true,
    );
  });

  it('reports leftovers when cleanup cannot delete', async () => {
    const fake = fakeGoogle({ token: TOKEN });
    const refusing: typeof fake.fetcher = (href, init) =>
      String(init.method) === 'DELETE'
        ? Promise.resolve({
            status: 500,
            headers: { get: () => null },
            text: async () => '{}',
          })
        : fake.fetcher(href, init);
    const { doc } = await run(fake, { fetcher: refusing });
    expect(doc.cleanup.status).toBe('failed');
    expect((doc.cleanup.leftover as string[]).length).toBeGreaterThan(0);
    expect(doc.cleanup.note).toMatch(/Delete these event ids by hand/);
  });

  describe('allowFor: the scope of every request', () => {
    const allow = allowFor('cal@group.calendar.google.com');
    const events =
      '/calendar/v3/calendars/cal%40group.calendar.google.com/events';
    const call =
      (
        who: string,
        method: string,
        pathname: string,
        query: Record<string, string> = {},
      ) =>
      () =>
        allow({ who, method, pathname, query });

    it('permits the app its three operations on the named calendar', () => {
      expect(
        call('app', 'GET', '/calendar/v3/users/me/calendarList'),
      ).not.toThrow();
      expect(call('app', 'GET', events)).not.toThrow();
      expect(
        call('app', 'PATCH', `${events}/e1`, { sendUpdates: 'none' }),
      ).not.toThrow();
    });

    it('refuses another calendar, "primary" and any calendar-list write', () => {
      expect(
        call('app', 'GET', '/calendar/v3/calendars/primary/events'),
      ).toThrow(/may only touch the calendar/);
      expect(
        call('driver', 'POST', '/calendar/v3/calendars/other%40x.com/events', {
          sendUpdates: 'none',
        }),
      ).toThrow(/may only touch/);
      expect(
        call('driver', 'POST', '/calendar/v3/users/me/calendarList', {
          sendUpdates: 'none',
        }),
      ).toThrow(/Only reading/);
    });

    it('refuses what the app does not declare: DELETE, POST, a path outside the API', () => {
      expect(
        call('app', 'DELETE', `${events}/e1`, { sendUpdates: 'none' }),
      ).toThrow(/not in this check's scope/);
      expect(call('app', 'POST', events, { sendUpdates: 'none' })).toThrow(
        /not in this check's scope/,
      );
      expect(call('app', 'GET', '/drive/v3/files')).toThrow(/outside/);
      expect(call('app', 'GET', '/calendar/v3/settings')).toThrow(
        /not a calendar-list/,
      );
    });

    it('lets the driver insert, patch and delete, but never without sendUpdates=none', () => {
      expect(
        call('driver', 'POST', events, { sendUpdates: 'none' }),
      ).not.toThrow();
      expect(
        call('driver', 'DELETE', `${events}/e1`, { sendUpdates: 'none' }),
      ).not.toThrow();
      expect(call('driver', 'POST', events)).toThrow(/sendUpdates=none/);
      expect(
        call('driver', 'DELETE', `${events}/e1`, { sendUpdates: 'all' }),
      ).toThrow(/sendUpdates=none/);
    });
  });
});
