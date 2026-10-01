/**
 * The sample Google Calendar: the mock proxy's google-calendar fixture
 * (`integrations/calendar/fixtures/google-calendar/scenario.mjs`), with its
 * test events replaced by an invented design studio's fortnight around the
 * day the sample account was made. Every name and place is made up. There is
 * no `htmlLink`, so nothing offers to open a Google page that doesn't exist.
 */
import { calendarFixture } from '../../integrations/calendar/fixtures/google-calendar/scenario.mjs';

const ZONE = 'Europe/Amsterdam';

const addDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** `+02:00` or `+01:00`: Amsterdam's offset on that day at noon. */
function offset(day) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find(p => p.type === 'timeZoneName').value;

  return name === 'GMT' ? '+00:00' : name.slice(3);
}

const at = (day, time) => ({
  dateTime: `${day}T${time}:00${offset(day)}`,
  timeZone: ZONE,
});

/** [id, title, day offset, start, end, extra]; `start`/`end` null: all day,
 * `end` then the number of days. */
const EVENTS = [
  [
    'review-zonnig',
    'Design review: Bakkerij Zonnig packaging',
    0,
    '09:30',
    '10:30',
    {
      location: 'Studio, room 2',
      description:
        'Walk through the three label options and pick one for print.',
    },
  ],
  [
    'lunch-ravi',
    'Lunch with Ravi',
    1,
    '12:30',
    '13:30',
    { location: 'Lunchroom Het Plein' },
  ],
  ['lotte-off', 'Lotte off', 1, null, 1, {}],
  [
    'kickoff-snel',
    'Kick-off: Fietsenmaker Snel webshop phase 2',
    2,
    '10:00',
    '11:30',
    {
      location: 'Fietsenmaker Snel, Utrecht',
      description:
        'Scope, planning and who does what. Bring the phase 1 numbers.',
    },
  ],
  [
    'call-theater',
    'Call with Theater De Kleine Zaal',
    3,
    '15:00',
    '15:30',
    {
      description: 'Programme booklet: deadlines for the winter season.',
    },
  ],
  ['offsite', 'Studio offsite, Texel', 6, null, 3, { location: 'Texel' }],
  ['dentist', 'Dentist', 9, '08:30', '09:00', {}],
  [
    'workshop',
    'Typography workshop',
    13,
    '14:00',
    '16:00',
    {
      location: 'Studio',
      description: 'Half a day on pairing typefaces. Coffee and cake provided.',
    },
  ],
  ['invoices', 'Invoice run', -2, '16:00', '17:00', {}],
  [
    'photos',
    'Portfolio photo shoot',
    -5,
    '11:00',
    '12:30',
    { location: 'Studio' },
  ],
  [
    'groen-plein',
    'Newsletter check-in, Stichting Groen Plein',
    -8,
    '10:00',
    '10:30',
    {},
  ],
];

function events(day) {
  const list = EVENTS.map(([id, summary, n, start, end, extra]) => {
    const d = addDays(day, n);

    return {
      id,
      summary,
      status: 'confirmed',
      ...extra,
      ...(start === null
        ? { start: { date: d }, end: { date: addDays(d, end) } }
        : { start: at(d, start), end: at(d, end) }),
    };
  });
  // A weekly series and a cancelled event, as a real calendar has: the app
  // does not import either yet (a known limit).
  const monday = addDays(
    day,
    (8 - new Date(`${day}T00:00:00Z`).getUTCDay()) % 7,
  );
  list.push(
    {
      id: 'planning',
      summary: 'Monday planning',
      status: 'confirmed',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      start: at(monday, '09:00'),
      end: at(monday, '09:30'),
    },
    {
      id: 'planning_1',
      summary: 'Monday planning',
      status: 'confirmed',
      recurringEventId: 'planning',
      originalStartTime: at(monday, '09:00'),
      start: at(monday, '09:00'),
      end: at(monday, '09:30'),
    },
    { id: 'moved', status: 'cancelled' },
  );

  return list;
}

export default {
  platform: 'google-calendar',
  name: 'Google Calendar',
  seed: () => ({ day: new Date().toISOString().slice(0, 10) }),
  create({ day }) {
    const fixture = calendarFixture(day);
    const [work, team] = fixture.calendars;
    work.summary = 'Acme Studio';
    team.summary = 'Acme team';
    fixture.events.splice(
      0,
      fixture.events.length,
      ...events(day).map((event, i) => ({ ...event, etag: `"s${i + 1}"` })),
    );

    return fixture;
  },
};
