// @wc-ignore-file
/**
 * The Calendar live check (integrations/LIVE_TESTING.md, "The live-check
 * kit"): the drive app's own controller and sync code, run from Node against
 * one real, disposable Google calendar through a relay stand-in. The mock e2e
 * (`../e2e/calendar.spec.ts`) covers the same scenarios against a fixture;
 * this runs them against Google and records evidence.
 *
 * What it does, in order, stopping at the first failed step (cleanup always
 * runs): preflight reads; seed five events (all-day, three-day all-day,
 * timed, a weekly series, one cancelled) with ids it chose, so cleanup never
 * searches by name; import; a re-sync that changes nothing; a Google-side
 * edit pulled in; a reviewed edit sent with `If-Match`; a stale send (412);
 * both-sides conflicts resolved both ways; Google-side deletes handled
 * without the app deleting anything in Google; cleanup of exactly the seeded
 * ids.
 *
 * The relay stand-in names one connection and adds the credential itself;
 * the controller never sees it. `allow` refuses any request that addresses
 * another calendar, and any write the app's declared scope
 * (`../app/operations.ts`) does not list.
 */
import { createController } from '../app/controller.js';
import { fakeStore } from '../app/fakeStore.js';
import type { HostProxy } from '../app/store.js';
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
  type StepContext,
} from '../../tooling/live-kit.mjs';

export const CALENDAR_API = 'https://www.googleapis.com';
const API = '/calendar/v3';

export interface CalendarCheckOptions {
  calendarId: string;
  token: string;
  fetcher?: Parameters<typeof createProvider>[0]['fetcher'];
  outDir?: string;
  maxMutations?: number;
  maxMs?: number;
  /** Only the preflight reads; nothing is written. */
  preflightOnly?: boolean;
  log?: (line: string) => unknown;
  now?: () => Date;
}

/** The scope of every request: one calendar, a few operations, no guest emails. */
export function allowFor(calendarId: string) {
  return ({
    who,
    method,
    pathname,
    query,
  }: {
    who: string;
    method: string;
    pathname: string;
    query: Record<string, string>;
  }) => {
    if (!pathname.startsWith(`${API}/`))
      throw new GuardError(`Refusing a request outside ${API}: ${pathname}`);
    const rest = pathname.slice(API.length);

    if (rest === '/users/me/calendarList') {
      if (method !== 'GET')
        throw new GuardError('Only reading the calendar list is allowed.');

      return;
    }

    const match = rest.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!match) throw new GuardError(`Refusing ${method} ${pathname}: not a calendar-list or events call.`);
    let named: string;
    try {
      named = decodeURIComponent(match[1]);
    } catch {
      throw new GuardError(`Refusing ${pathname}: the calendar id is not valid.`);
    }
    if (named !== calendarId)
      throw new GuardError(
        `Refusing ${method} on calendar ${JSON.stringify(named)}: this run may only touch the calendar named by --i-understand-this-writes-to.`,
      );

    const one = match[2] !== undefined;
    const permitted =
      who === 'app'
        ? (!one && method === 'GET') || (one && method === 'PATCH')
        : (!one && (method === 'GET' || method === 'POST')) ||
          (one && ['GET', 'PATCH', 'DELETE'].includes(method));
    if (!permitted)
      throw new GuardError(`Refusing ${who} ${method} ${rest}: not in this check's scope.`);
    if (method !== 'GET' && query.sendUpdates !== 'none')
      throw new GuardError('Refusing a write without sendUpdates=none: guests must never be emailed.');
  };
}

interface GoogleEvent {
  id: string;
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  recurrence?: string[];
}

const day = (base: Date, plus: number) =>
  new Date(base.getTime() + plus * 86_400_000).toISOString().slice(0, 10);

export const NOT_COVERED = [
  'A lost write response: it cannot be forced against Google (the mock e2e covers it).',
  'Recurring events beyond being skipped: one weekly series master is seeded, and the app only skips it.',
  'The consent bar, the integration proxy, its OAuth and credential refresh: this run uses a bearer token and a relay stand-in, not the host or the proxy.',
  'The host, the frame and the table: the controller ran against an in-memory store, so no row reached atomic-server.',
  'Calendars with more than 250 events (paging) and a revoked token (401).',
];

export async function runCalendarCheck(options: CalendarCheckOptions): Promise<{
  doc: EvidenceDocument;
  files: { json: string; markdown: string };
}> {
  const { calendarId, token } = options;
  const redact = createRedactor({ GOOGLE_CALENDAR_ACCESS_TOKEN: token }, { keep: [calendarId] });
  const log = createLogger(redact, options.log);
  const budget = createBudget({
    ...(options.maxMutations === undefined ? {} : { maxMutations: options.maxMutations }),
    ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
  });
  const provider: Provider = createProvider({
    baseUrl: CALENDAR_API,
    authHeaders: () => ({ authorization: `Bearer ${token}` }),
    allow: allowFor(calendarId),
    budget,
    redact,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const recorder = createRecorder({
    app: 'calendar',
    provider: 'Google Calendar',
    apiVersion: 'Calendar API v3',
    candidate: describeCandidate('calendar'),
    target: { kind: 'calendar', id: calendarId },
    redact,
    log,
    limits: budget,
    ...(options.now ? { now: options.now } : {}),
  });
  const target: { kind: string; id: string; name?: string } = { kind: 'calendar', id: calendarId };

  const eventsPath = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const base = (path: string) => `${API}${path}`;
  const driver = {
    async list(query: Record<string, string> = {}) {
      const r = await provider.request({
        who: 'driver',
        path: base(eventsPath),
        query: { maxResults: '250', ...query },
      });
      if (r.status !== 200) throw new Error(`events.list answered ${r.status}`);

      return (r.body as { items?: GoogleEvent[] }).items ?? [];
    },
    async get(id: string) {
      const r = await provider.request({ who: 'driver', path: base(`${eventsPath}/${encodeURIComponent(id)}`) });
      if (r.status !== 200) throw new Error(`events.get ${id} answered ${r.status}`);

      return r.body as GoogleEvent;
    },
    async insert(event: Record<string, unknown>) {
      const r = await provider.request({
        who: 'driver',
        method: 'POST',
        path: base(eventsPath),
        query: { sendUpdates: 'none' },
        body: JSON.stringify(event),
      });
      if (r.status !== 200) throw new Error(`events.insert answered ${r.status}`);

      return r.body as GoogleEvent;
    },
    async patch(id: string, fields: Record<string, unknown>) {
      const r = await provider.request({
        who: 'driver',
        method: 'PATCH',
        path: base(`${eventsPath}/${encodeURIComponent(id)}`),
        query: { sendUpdates: 'none' },
        body: JSON.stringify(fields),
      });
      if (r.status !== 200) throw new Error(`events.patch ${id} answered ${r.status}`);

      return r.body as GoogleEvent;
    },
    async remove(id: string) {
      const r = await provider.request({
        who: 'driver',
        method: 'DELETE',
        path: base(`${eventsPath}/${encodeURIComponent(id)}`),
        query: { sendUpdates: 'none' },
      });

      return r.status;
    },
  };

  const created: string[] = [];
  const deleted = new Set<string>();
  const removeTracked = async (id: string) => {
    const status = await driver.remove(id);
    if (status === 204 || status === 200 || status === 410 || status === 404) deleted.add(id);

    return status;
  };

  const runHex = recorder.prefix.slice(-6);
  const ids = {
    allDay: `lc${runHex}0`,
    trip: `lc${runHex}1`,
    timed: `lc${runHex}2`,
    series: `lc${runHex}3`,
    gone: `lc${runHex}4`,
  };
  const title = (name: string) => `${recorder.prefix} ${name}`;
  const base0 = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const D = day(base0, 14);

  // The app, as the host would run it: its controller over an in-memory
  // store, reaching Google only through the relay stand-in.
  const store = fakeStore({ relay: false });
  (store as { proxy?: HostProxy }).proxy = relayStandIn(provider, 'google-calendar') as unknown as HostProxy;
  const controller = createController(store, () => {});

  const ready = () => {
    const state = controller.state();
    if (state.kind !== 'ready')
      throw new Error(
        `The controller is ${state.kind}${state.kind === 'error' ? `: ${state.message}` : ''}, not ready.`,
      );

    return state;
  };
  const row = (name: string) => controller.snapshot().events.find(e => e.title === title(name));
  const appWrites = () => provider.requests.filter(r => r.who === 'app' && r.method !== 'GET');
  const instant = (s: string) => Date.parse(s);

  const events = () => controller.snapshot().events;
  const rowOf = (id: string) => events().find(e => e.id === id);

  {
    await recorder.step('S0', 'Preflight: the calendar is disposable and empty', async ({ check, equal, note }: StepContext) => {
      let pageToken: string | undefined;
      let entry: { id: string; summary?: string; primary?: boolean; accessRole?: string } | undefined;
      for (let page = 0; page < 10 && !entry; page++) {
        const r = await provider.request({
          who: 'driver',
          path: base('/users/me/calendarList'),
          query: { maxResults: '250', ...(pageToken ? { pageToken } : {}) },
        });
        if (r.status !== 200) throw new Error(`calendarList answered ${r.status}`);
        const body = r.body as { items?: typeof entry[]; nextPageToken?: string };
        entry = body.items?.find(i => i?.id === calendarId);
        pageToken = body.nextPageToken;
        if (!pageToken) break;
      }
      if (!entry)
        throw new GuardError('The calendar named by --i-understand-this-writes-to is not in this account\'s calendar list.');
      target.name = entry.summary;
      check('the calendar is in the account\'s calendar list', true);
      check('it is not the account\'s primary calendar', entry.primary !== true);
      check('the account may write to it (owner or writer)', ['owner', 'writer'].includes(entry.accessRole ?? ''));
      if (entry.primary === true) throw new GuardError('Refusing to run against the primary calendar.');
      requireDisposableName('calendar', entry.summary);
      check('its name looks disposable', true);
      const existing = (await driver.list({ singleEvents: 'false', showDeleted: 'false' })).filter(e => e.status !== 'cancelled');
      equal('it has no existing events', existing.length, 0);
      if (existing.length) throw new GuardError('The calendar already has events; use a new, empty calendar so counts are exact.');
      note(`Run prefix ${recorder.prefix}; seeded dates start ${D} (UTC).`);
    });

    if (options.preflightOnly) {
      // Done: nothing was written.
    } else {
      await recorder.step('S1', 'Seed five events through the Google API', async ({ equal }) => {
        const seed = async (id: string, event: Record<string, unknown>) => {
          created.push(id);
          const out = await driver.insert({ id, ...event });
          equal(`events.insert ${id} kept the chosen id`, out.id, id);
        };
        await seed(ids.allDay, { summary: title('all-day'), description: 'Invented text', start: { date: D }, end: { date: day(base0, 15) } });
        await seed(ids.trip, { summary: title('three-day'), start: { date: D }, end: { date: day(base0, 17) } });
        await seed(ids.timed, {
          summary: title('timed'),
          location: 'Room 4',
          start: { dateTime: `${D}T09:00:00Z`, timeZone: 'UTC' },
          end: { dateTime: `${D}T10:00:00Z`, timeZone: 'UTC' },
        });
        await seed(ids.series, {
          summary: title('weekly'),
          recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
          start: { dateTime: `${D}T11:00:00Z`, timeZone: 'UTC' },
          end: { dateTime: `${D}T11:30:00Z`, timeZone: 'UTC' },
        });
        await seed(ids.gone, { summary: title('cancelled'), start: { date: D }, end: { date: day(base0, 15) } });
        await removeTracked(ids.gone);
      });

      await recorder.step('S2', 'Import: connect, choose the calendar, read every event', async ({ check, equal }) => {
        await controller.load();
        const state = controller.state();
        if (state.kind !== 'choosing')
          throw new Error(`Expected the calendar picker, got ${state.kind}${state.kind === 'error' ? `: ${state.message}` : ''}`);
        check('the picker lists the test calendar', state.calendars.some(c => c.id === calendarId));
        await controller.choose(calendarId);
        const { summary } = ready();
        equal('three single events were added', summary.added, 3);
        check('the weekly series was skipped as recurring', summary.skipped.recurring >= 1, summary.skipped);
        check('nothing was unreadable', summary.unreadable.length === 0, summary.unreadable);
        equal('the rows are exactly the three single events', events().map(e => e.title).sort(), [title('all-day'), title('three-day'), title('timed')].sort());
        const allDay = row('all-day');
        equal('all-day: allDay, start and exclusive end as Google has them', [allDay?.allDay, allDay?.start, allDay?.end], [true, D, day(base0, 15)]);
        const trip = row('three-day');
        equal('three-day: start and exclusive end', [trip?.allDay, trip?.start, trip?.end], [true, D, day(base0, 17)]);
        const timed = row('timed');
        check(
          'timed: start and end are the same instants',
          timed !== undefined && instant(timed.start) === instant(`${D}T09:00:00Z`) && instant(timed.end) === instant(`${D}T10:00:00Z`),
          { start: timed?.start, end: timed?.end },
        );
        equal('timed: location', timed?.location, 'Room 4');
        check('every row is bound to a Google event and shows no pending edit', events().every(e => e.id && !e.pending && !e.conflict));
        equal('the app wrote nothing to Google', appWrites().length, 0);
      });

      await recorder.step('S3', 'A second sync changes nothing', async ({ equal }) => {
        await controller.refresh();
        const { summary } = ready();
        equal('unchanged, no review, no conflict', [summary.added, summary.updated, summary.unchanged, summary.review.length, summary.conflicts.length], [0, 0, 3, 0, 0]);
      });

      await recorder.step('S4', 'A Google-side edit is pulled in', async ({ check, equal }) => {
        await driver.patch(ids.timed, { location: 'Room 9' });
        await controller.refresh();
        const { summary } = ready();
        equal('one row updated', summary.updated, 1);
        equal('the row has Google\'s location', row('timed')?.location, 'Room 9');
        check('no review or conflict from a Google-only edit', summary.review.length === 0 && summary.conflicts.length === 0);
      });

      await recorder.step('S5', 'A reviewed edit is sent: only the changed fields, with If-Match', async ({ check, equal }) => {
        const before = row('all-day')!;
        await controller.saveEvent(before.subject, { ...before, title: title('all-day (edited)'), location: 'Test room' });
        equal('nothing is sent before review', appWrites().length, 0);
        await controller.prepareReview();
        const review = ready().summary.review;
        equal('the review lists the two fields', review[0]?.fields.map(f => f.field).sort(), ['Location', 'Title']);
        await controller.send();
        equal('the outcome is sent', ready().outcomes.map(o => o.status), ['sent']);
        const patches = appWrites().filter(r => r.method === 'PATCH');
        equal('one PATCH, of only summary and location', patches.map(p => p.bodyKeys), [['location', 'summary']]);
        check('the PATCH carried If-Match and sendUpdates=none', patches.every(p => p.ifMatch && p.path.includes('sendUpdates=none')));
        const at = await driver.get(ids.allDay);
        equal('Google has the new title and location', [at.summary, at.location], [title('all-day (edited)'), 'Test room']);
        equal('Google\'s all-day dates are unchanged', [at.start?.date, at.end?.date], [D, day(base0, 15)]);
        await controller.refresh();
        equal('the next sync agrees: no review, no conflict', [ready().summary.review.length, ready().summary.conflicts.length], [0, 0]);
      });

      await recorder.step('S6', 'A write after a Google-side change is refused (412) and reviewed again', async ({ check, equal }) => {
        const trip = row('three-day')!;
        await controller.saveEvent(trip.subject, { ...trip, title: title('three-day (edited)') });
        await controller.refresh();
        equal('the preview lists the edit', ready().summary.review.length, 1);
        await driver.patch(ids.trip, { description: 'Edited in Google after the preview' });
        await controller.send();
        equal('the outcome is stale (412)', ready().outcomes.map(o => o.status), ['stale']);
        const patch = provider.requests.filter(r => r.who === 'app' && r.method === 'PATCH').at(-1);
        equal('Google answered 412', patch?.status, 412);
        equal('Google still has the old title', (await driver.get(ids.trip)).summary, title('three-day'));
        await controller.refresh();
        const { summary } = ready();
        check('different fields: no conflict', summary.conflicts.length === 0);
        equal('the edit is listed for review again', summary.review.map(r => r.fields.map(f => f.field)), [['Title']]);
        await controller.send();
        equal('the second send is sent', ready().outcomes.map(o => o.status), ['sent']);
        const at = await driver.get(ids.trip);
        equal('Google has our title and its own description', [at.summary, at.description], [title('three-day (edited)'), 'Edited in Google after the preview']);
      });

      await recorder.step('S7', 'The same field changed on both sides is a conflict, resolved both ways', async ({ check, equal }) => {
        const timed = rowOf(ids.timed)!;
        const allDay = rowOf(ids.allDay)!;
        await controller.saveEvent(timed.subject, { ...timed, title: title('timed (mine)') });
        await controller.saveEvent(allDay.subject, { ...allDay, title: title('all-day (mine)') });
        await driver.patch(ids.timed, { summary: title('timed (theirs)') });
        await driver.patch(ids.allDay, { summary: title('all-day (theirs)') });
        const writesBefore = appWrites().length;
        await controller.refresh();
        const { conflicts } = ready().summary;
        equal('two conflicts, both on the title', conflicts.map(c => [c.kind, c.fields]), [
          ['both', ['title']],
          ['both', ['title']],
        ]);
        const onTimed = conflicts.find(c => c.id === ids.timed)!;
        const onAllDay = conflicts.find(c => c.id === ids.allDay)!;
        equal('the app has not written to Google', appWrites().length, writesBefore);

        await controller.resolve(onTimed, { title: 'google' });
        await controller.resolve(onAllDay, { title: 'mine' });
        equal('"Use Google\'s" put Google\'s title in the row', row('timed (theirs)')?.title, title('timed (theirs)'));
        equal('"Keep mine" has not sent anything', appWrites().length, writesBefore);
        await controller.prepareReview();
        const review = ready().summary.review;
        equal('only the kept value is up for review', review.map(r => r.fields), [[{ field: 'Title', before: title('all-day (theirs)'), after: title('all-day (mine)') }]]);
        await controller.send();
        equal('sending it is sent', ready().outcomes.map(o => o.status), ['sent']);
        equal('Google has the kept value', (await driver.get(ids.allDay)).summary, title('all-day (mine)'));
        equal('Google kept its own value for the other', (await driver.get(ids.timed)).summary, title('timed (theirs)'));
        await controller.refresh();
        check('then everything agrees', ready().summary.conflicts.length === 0 && ready().summary.review.length === 0);
      });

      await recorder.step('S8', 'Events deleted in Google are never deleted by the app', async ({ equal }) => {
        await removeTracked(ids.trip);
        await removeTracked(ids.timed);
        await controller.refresh();
        const { conflicts } = ready().summary;
        equal('both are listed as gone from Google', conflicts.map(c => c.kind).sort(), ['missing-remote', 'missing-remote']);
        const trip = conflicts.find(c => c.id === ids.trip)!;
        const timed = conflicts.find(c => c.id === ids.timed)!;
        await controller.keepAsLocal(trip);
        await controller.removeLocal(timed);
        await controller.refresh();
        const { summary } = ready();
        equal('no conflicts remain; one row is now local only', [summary.conflicts.length, summary.localOnly], [0, 1]);
        equal('the kept row is still here, the removed one is gone', events().map(e => e.title).sort(), [title('all-day (mine)'), title('three-day (edited)')].sort());
        equal('the app sent no DELETE', provider.requests.filter(r => r.who === 'app' && r.method === 'DELETE').length, 0);
      });
    }
  }

  // Cleanup: exactly the ids this run created, never a search by name.
  const cleanup: EvidenceDocument['cleanup'] = {
    status: 'passed',
    created: [...created],
    deleted: [] as string[],
    leftover: [] as string[],
  };
  if (created.length) {
    // Cleanup is bounded by what this run created, so it may go past the budget.
    budget.extendForCleanup(created.length);
    for (const id of created) {
      if (deleted.has(id)) continue;
      try {
        await removeTracked(id);
      } catch (error) {
        cleanup.note = redact(error instanceof Error ? error.message : String(error));
      }
    }
    cleanup.deleted = created.filter(id => deleted.has(id));
    cleanup.leftover = created.filter(id => !deleted.has(id));
    if ((cleanup.leftover as string[]).length) {
      cleanup.status = 'failed';
      cleanup.note = `${cleanup.note ?? ''} Delete these event ids by hand in the test calendar: ${(cleanup.leftover as string[]).join(', ')}`.trim();
    }
  } else {
    cleanup.note = 'Nothing was created.';
  }

  const doc = recorder.document({
    cleanup,
    notCovered: NOT_COVERED,
    preflightOnly: options.preflightOnly === true,
    requests: provider.requests,
  });
  doc.target = redact.deep({ ...doc.target, ...target });
  const files = writeEvidence(doc, options.outDir ?? defaultEvidenceDir('calendar'), redact);

  return { doc, files };
}
