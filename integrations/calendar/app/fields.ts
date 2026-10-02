// @wc-ignore-file
/**
 * The shared `event-v1` class (ontola/atomic-plugins#177, §2.2) as this app
 * reads and writes it. Its subjects come from `ontology-kit/terms.mjs`, which
 * the build inlines; fields are read through `ontology-kit`'s strict
 * resolver: by exact property subject, never by shortname or column.
 *
 * The shortnames of the date fields are the host's `calendarFields`
 * (`atomic-calendar-day`, `-all-day`, `-end-day`), so the host table's own
 * Calendar view places and spans the rows as before (#172).
 */
import {
  createResolver,
  incompleteNote,
} from '../../../ontology-kit/resolver.mjs';
import { classes, properties } from '../../../ontology-kit/terms.mjs';

/** The shared class every row of the app's table is, from 0.2.0. */
export const EVENT = classes['event-v1'].subject;

/** The shared fields this app maps, by its own key. */
export const SHARED = {
  day: properties['atomic-calendar-day'].subject,
  endDay: properties['atomic-calendar-end-day'].subject,
  allDay: properties['atomic-calendar-all-day'].subject,
  start: properties['atomic-calendar-start'].subject,
  end: properties['atomic-calendar-end'].subject,
  location: properties['atomic-calendar-location'].subject,
  notes: properties['atomic-calendar-notes'].subject,
} as const;

export type SharedKey = keyof typeof SHARED;

/**
 * Up to 0.1.4 the app minted these fields in its own ontology, under these
 * shortnames. The first open of 0.2.0 copies their values to `SHARED` and
 * removes them (`adopt.ts`).
 */
export const LEGACY_SHORTNAMES: Record<SharedKey, string> = {
  day: 'atomic-calendar-day',
  endDay: 'atomic-calendar-end-day',
  allDay: 'atomic-calendar-all-day',
  start: 'start',
  end: 'end',
  location: 'location',
  notes: 'atomic-calendar-notes',
};

export const fields = createResolver({ classes: [classes['event-v1']] });

/** The required fields as the host table heads their columns. */
const COLUMN_NAMES: Readonly<Record<string, string>> = {
  'https://atomicdata.dev/properties/name': 'Name',
  [SHARED.day]: 'Day',
};

/**
 * "Incomplete: missing Name and Day" for a row without one of the class's
 * required fields (`name`, `atomic-calendar-day`), or undefined. Such a row
 * is shown, marked, and never sent (ontology-kit/README.md); the person
 * fixes it in the host table.
 */
export function incompleteOf(
  props: Readonly<Record<string, unknown>>,
): string | undefined {
  return incompleteNote(fields.read(props, EVENT).missing, COLUMN_NAMES);
}

/** The row's shared fields, by subject; empty strings count as absent. */
export function sharedValues(
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return fields.read(props, EVENT).values;
}
