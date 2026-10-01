/**
 * The sample Clockify account: the mock proxy's clockify fixture
 * (`integrations/timesheets/fixtures/clockify/scenario.mjs`), with its test
 * names and entries replaced by an invented design studio's last two weeks
 * of work, relative to when the sample account was made. Every name is made
 * up. The fixture's module constants are renamed in place: this bundle is
 * their only user.
 */
import {
  ARCHIVED_PROJECT,
  DEFAULT_TIME_ZONE,
  PROJECT,
  PROJECT_2,
  USER,
  WORKSPACE,
  clockifyEntry,
  clockifyFixture,
  wallClockToInstant,
} from '../../integrations/timesheets/fixtures/clockify/scenario.mjs';

Object.assign(WORKSPACE, { name: 'Acme Studio' });
Object.assign(USER, { name: 'Alex Sample' });
Object.assign(PROJECT, {
  name: 'Webshop phase 2',
  clientName: 'Fietsenmaker Snel VOF',
});
Object.assign(PROJECT_2, {
  name: 'Packaging labels',
  clientName: 'Bakkerij Zonnig BV',
});
Object.assign(ARCHIVED_PROJECT, { name: 'Website 2025' });

const DAY = 86_400_000;

/** [days ago, start, end, description, project (2: PROJECT_2), extra] */
const ENTRIES = [
  [1, '09:00', '12:30', 'Product page layout', 1],
  [1, '13:30', '15:00', 'Checkout flow review with client', 1],
  [1, '15:15', '17:00', 'Label sketches, round 2', 2],
  [2, '09:30', '11:00', 'Weekly planning', 1, { billable: false }],
  [2, '11:00', '12:30', 'Colour proofs', 2],
  [2, '13:30', '17:30', 'Category page templates', 1],
  [3, '09:00', '10:30', 'Label printing quotes', 2],
  [3, '10:30', '12:00', 'Image export for product photos', 1],
  [6, '09:00', '12:00', 'Wireframes cart and checkout', 1],
  [6, '13:00', '16:30', 'Label final artwork', 2],
  [7, '10:00', '11:00', 'Call with printer', 2, { billable: false }],
  [7, '11:00', '16:00', 'Style guide for the webshop', 1],
  [8, '09:00', '12:00', 'Kick-off notes and estimate', 1],
  [9, '14:00', '17:00', 'Packaging mood board', 2],
];

function entries(now) {
  const today = new Date(now).toISOString().slice(0, 10);
  const instant = (daysAgo, time) =>
    wallClockToInstant(
      Date.parse(`${today}T${time}:00Z`) - daysAgo * DAY,
      DEFAULT_TIME_ZONE,
    );

  return ENTRIES.map(([ago, start, end, description, project, extra], i) =>
    clockifyEntry(
      `sample-${String(i + 1).padStart(2, '0')}`,
      description,
      instant(ago, start),
      instant(ago, end),
      { projectId: project === 2 ? PROJECT_2.id : PROJECT.id, ...extra },
    ),
  );
}

export default {
  platform: 'clockify',
  name: 'Clockify',
  seed: () => ({ now: Date.now() }),
  create({ now }) {
    const fixture = clockifyFixture();
    fixture.state.entries = entries(now);

    return fixture;
  },
};
