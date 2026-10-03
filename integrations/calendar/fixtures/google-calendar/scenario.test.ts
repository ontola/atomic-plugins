// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import fixture, { PRIMARY, TEAM, calendarFixture } from './scenario.mjs';

const url = (path: string) =>
  new URL(`http://mock.test/proxy/google-calendar/calendar/v3${path}`);

describe('google-calendar fixture drivers', () => {
  it('declares reset as a driver', () => {
    expect(fixture.drivers).toContain('reset');
  });

  it('reset restores events and ETags, and forgets requests and writes', () => {
    const google = calendarFixture('2026-10-02');
    const before = structuredClone(google.events);
    const timedEtag = google.events.find(e => e.id === 'timed')!.etag;

    google.editRemote('timed', { location: 'Room 2' });
    google.cancel('series');
    const patched = google.request(
      'PATCH',
      url(`/calendars/${PRIMARY}/events/timed`),
      { summary: 'Edited' },
      { 'if-match': google.events.find(e => e.id === 'timed')!.etag },
    );
    expect(patched.status).toBe(200);
    expect(google.state().writes).toHaveLength(1);
    expect(google.received()).toHaveLength(1);

    google.reset();

    expect(google.events).toEqual(before);
    expect(google.events.find(e => e.id === 'timed')!.etag).toBe(timedEtag);
    expect(google.state().writes).toEqual([]);
    expect(google.received()).toEqual([]);
  });

  it('reset restores the team calendar, and writes go through again', () => {
    const google = calendarFixture('2026-10-02');
    google.editRemote('standup', { summary: 'Moved' }, TEAM);
    google.reset();
    const standup = google.request(
      'GET',
      url(`/calendars/${encodeURIComponent(TEAM)}/events/standup`),
    );
    expect(standup.body.summary).toBe('Team standup');
    const etag = google.events.find(e => e.id === 'timed')!.etag;
    const sent = google.request(
      'PATCH',
      url(`/calendars/${PRIMARY}/events/timed`),
      { location: 'Room 5' },
      { 'if-match': etag },
    );
    expect(sent.status).toBe(200);
  });
});
