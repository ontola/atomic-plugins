// @wc-ignore-file
/**
 * The first open of 0.5.0 (#177 §5, item 7): a 0.4.0 table moves onto the
 * shared `time-entry-v1` class in place, with unsent edits kept; the app is
 * then offered on other `time-entry-v1` tables, where it shows their rows
 * read only.
 */
import { describe, expect, it } from 'vitest';
import { adopt, ROW_EXTRAS } from './adopt.js';
import { createController } from './controller.js';
import {
  APP,
  fakeStore,
  IS_A,
  ONTOLOGY,
  OTHER_TABLE,
  PARENT,
  RENDERS,
  ROW_CLASS,
  ROW_EXTRAS_PROPERTY,
  TABLE,
  type FakeStore,
} from './fakeStore.js';
import { SHARED, TIME_ENTRY, WORK_PERSON, WORK_PROJECT } from './fields.js';
import { atomic, NAME } from './ontology.js';
import { ensureSchema } from './schema.js';
import type { JSONValue } from './store.js';
import { localValues } from './writeBack.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-09-22T08:00:00Z');
const DT = 'https://atomicdata.dev/datatypes';

/** The Properties 0.4.0 made in the app's ontology, by shortname. */
const OLD = {
  start: `${DT}/timestamp`,
  end: `${DT}/timestamp`,
  billable: `${DT}/boolean`,
  project: `${DT}/string`,
  member: `${DT}/string`,
  'clockify-entry-id': `${DT}/string`,
  'clockify-project-id': `${DT}/string`,
  'clockify-user-id': `${DT}/string`,
  'clockify-sync-baseline': `${DT}/string`,
} as const;

type Old = Record<keyof typeof OLD, string>;

/** A drive as 0.4.0 left it: its own row class, Properties and two rows. */
function legacyStore(): { store: FakeStore; old: Old } {
  const store = fakeStore();
  const old = {} as Old;

  for (const [shortname, datatype] of Object.entries(OLD)) {
    const subject = `${ONTOLOGY}/property/${shortname}`;
    store.resources.set(subject, {
      [PARENT]: ONTOLOGY,
      [IS_A]: [atomic.propertyClass],
      [atomic.shortname]: shortname,
      [atomic.datatype]: datatype,
    });
    old[shortname as keyof Old] = subject;
  }

  store.resources.get(ONTOLOGY)![atomic.properties] = Object.values(old);
  store.resources.get(ROW_CLASS)![atomic.recommends] = [
    NAME,
    old.start,
    old.end,
    old.billable,
    old.project,
  ];

  const row = (
    subject: string,
    values: Record<string, JSONValue>,
    baseline: Record<string, JSONValue>,
  ) =>
    store.resources.set(subject, {
      [PARENT]: TABLE,
      [IS_A]: [ROW_CLASS],
      ...values,
      [old['clockify-sync-baseline']]: JSON.stringify(baseline),
    });

  const base = {
    start: START,
    end: START + HOUR,
    billable: true,
    projectId: 'p1',
    project: 'Atomic plugins',
  };
  // In agreement with Clockify.
  row(
    'did:ad:row-1',
    {
      [NAME]: 'Fix plugin source loading',
      [old['clockify-entry-id']]: 'entry-1',
      [old.start]: START,
      [old.end]: START + HOUR,
      [old.billable]: true,
      [old['clockify-project-id']]: 'p1',
      [old.project]: 'Atomic plugins',
      [old['clockify-user-id']]: 'u1',
      [old.member]: 'Ada Lovelace',
    },
    { name: 'Fix plugin source loading', ...base },
  );
  // Edited in the table and not sent: a new name, and a project name
  // typed over the old one.
  row(
    'did:ad:row-2',
    {
      [NAME]: 'Mine',
      [old['clockify-entry-id']]: 'entry-2',
      [old.start]: START + 2 * HOUR,
      [old.end]: START + 3 * HOUR,
      [old.billable]: false,
      [old['clockify-project-id']]: 'p1',
      [old.project]: 'Research',
      [old['clockify-user-id']]: 'u1',
      [old.member]: 'Ada Lovelace',
    },
    {
      name: 'Weekly sync',
      ...base,
      start: START + 2 * HOUR,
      end: START + 3 * HOUR,
      billable: false,
    },
  );

  return { store, old };
}

describe('first open of 0.5.0 (#177 §5)', () => {
  it('moves 0.4.0 rows onto time-entry-v1 in place, with links, then the class, renders and row extras', async () => {
    const { store, old } = legacyStore();

    expect(await adopt(store)).toEqual({ own: true, migrated: 2 });

    const schema = await ensureSchema(store);
    const first = store.resources.get('did:ad:row-1')!;
    expect(first[IS_A]).toEqual([TIME_ENTRY]);
    expect(first).toMatchObject({
      [NAME]: 'Fix plugin source loading',
      [SHARED.start]: START,
      [SHARED.end]: START + HOUR,
      [SHARED.billable]: true,
      [schema.row.entryId]: 'entry-1',
    });
    // The old fields are gone from the row; the extras keep their subjects.
    for (const key of [
      'start',
      'end',
      'billable',
      'project',
      'member',
      'clockify-project-id',
      'clockify-user-id',
    ] as const)
      expect(first).not.toHaveProperty(old[key]);
    expect(schema.row.entryId).toBe(old['clockify-entry-id']);
    expect(schema.sync.baseline).toBe(old['clockify-sync-baseline']);

    // Project and person are links to the app's Projects and People rows.
    expect(store.resources.get(first[SHARED.project] as string)).toMatchObject({
      [PARENT]: schema.tables.projects,
      [IS_A]: [WORK_PROJECT],
      [NAME]: 'Atomic plugins',
      [schema.link.projectId]: 'p1',
    });
    expect(store.resources.get(first[SHARED.person] as string)).toMatchObject({
      [PARENT]: schema.tables.people,
      [IS_A]: [WORK_PERSON],
      [NAME]: 'Ada Lovelace',
      [schema.link.memberId]: 'u1',
    });

    // The unsent edit survives: the name, and the typed project name as a
    // link to a project row of that name without a Clockify id.
    const second = store.resources.get('did:ad:row-2')!;
    expect(second[NAME]).toBe('Mine');
    expect(second[SHARED.person]).toBe(first[SHARED.person]);
    expect(
      await localValues(await store.getResource('did:ad:row-2'), schema),
    ).toEqual({
      name: 'Mine',
      start: START + 2 * HOUR,
      end: START + 3 * HOUR,
      billable: false,
      projectId: null,
      project: 'Research',
    });

    // Then the table, the App's renders and its row extras.
    expect(store.resources.get(TABLE)![atomic.classtype]).toBe(TIME_ENTRY);
    expect(store.resources.get(APP)![RENDERS]).toEqual([ROW_CLASS, TIME_ENTRY]);
    expect(store.resources.get(APP)![ROW_EXTRAS_PROPERTY]).toEqual(
      ROW_EXTRAS.map(key =>
        key === 'entryId' ? schema.row.entryId : schema.sync[key],
      ),
    );

    // Done once: a second open writes nothing.
    const writes = store.writes.length;
    expect(await adopt(store)).toEqual({ own: true, migrated: 0 });
    expect(store.writes.length).toBe(writes);
  });

  it('as the view of another time-entry-v1 table, shows its rows read only and syncs nothing', async () => {
    const store = fakeStore({ view: 'other' });
    const person = 'did:ad:drive/people/grace';
    store.resources.set(person, { [NAME]: 'Grace Hopper' });
    const project = 'did:ad:drive/projects/compiler';
    store.resources.set(project, { [NAME]: 'Compiler' });
    store.resources.set('did:ad:drive/team-hours/1', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [TIME_ENTRY],
      [NAME]: 'Pairing',
      [SHARED.start]: START,
      [SHARED.end]: START + HOUR,
      [SHARED.billable]: true,
      [SHARED.project]: project,
      [SHARED.person]: person,
    });
    // A running timer: no end.
    store.resources.set('did:ad:drive/team-hours/2', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [TIME_ENTRY],
      [SHARED.start]: START + 2 * HOUR,
    });
    // Rows missing the class's required Start (#177; ontology-kit's rule:
    // shown as incomplete, never skipped): one named, one not; and one
    // whose Start is not a timestamp.
    store.resources.set('did:ad:drive/team-hours/3', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [TIME_ENTRY],
      [NAME]: 'Forgot the start',
      [SHARED.end]: START + 3 * HOUR,
    });
    store.resources.set('did:ad:drive/team-hours/4', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [TIME_ENTRY],
      [SHARED.billable]: true,
    });
    store.resources.set('did:ad:drive/team-hours/5', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [TIME_ENTRY],
      [NAME]: 'Typed a date',
      [SHARED.start]: '2026-09-23',
    });
    const before = structuredClone(store.resources.get(OTHER_TABLE));
    const controller = createController(
      store,
      () => {},
      () => START,
    );

    await controller.load();

    // No proxy and no row grant in this store: no "Sync this table".
    expect(controller.state()).toEqual({
      kind: 'local',
      tableName: 'Team hours',
      canSync: false,
    });
    expect(store.resources.get(OTHER_TABLE)).toEqual(before);
    // The app's own table is left as it is; the App renders the class.
    expect(store.resources.get(TABLE)![atomic.classtype]).toBe(ROW_CLASS);
    expect(store.resources.get(APP)![RENDERS]).toEqual([ROW_CLASS, TIME_ENTRY]);
    const sheet = controller.sheet()!;
    expect(sheet.entries).toEqual([
      {
        id: 'did:ad:drive/team-hours/1',
        description: 'Pairing',
        start: START,
        end: START + HOUR,
        billable: true,
        project: { id: project, name: 'Compiler' },
        member: 'Grace Hopper',
      },
    ]);
    expect(sheet.running).toBe(1);
    expect(sheet.incomplete).toEqual([
      {
        id: 'did:ad:drive/team-hours/3',
        description: 'Forgot the start',
        note: 'Incomplete: missing Start',
      },
      {
        id: 'did:ad:drive/team-hours/4',
        description: '',
        note: 'Incomplete: missing Start',
      },
      {
        id: 'did:ad:drive/team-hours/5',
        description: 'Typed a date',
        note: 'Incomplete: Start is not a time',
      },
    ]);
    expect(controller.editBlockers('did:ad:drive/team-hours/1')).not.toEqual(
      [],
    );
    // Nothing reaches Clockify: there is not even a proxy call.
    expect(await controller.sync()).toEqual(controller.state());
  });
});
