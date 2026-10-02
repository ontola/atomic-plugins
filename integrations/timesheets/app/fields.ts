// @wc-ignore-file
/**
 * The shared classes (ontola/atomic-plugins#177 §2.4) as this app reads and
 * writes them: `time-entry-v1` for the rows, and `work-project-v1` and
 * `work-person-v1` for the projects and people the rows link to (#177 Q11:
 * linked records). Their subjects come from `ontology-kit/terms.mjs`, which
 * the build inlines; fields are read through `ontology-kit`'s strict
 * resolver only: by exact property subject, never by shortname or column.
 *
 * The Clockify ids (entry, project, user) and the sync bookkeeping are not
 * part of these classes: they are Properties of the app's own ontology
 * (`ontology.ts`), kept on the rows as provider extras.
 */
import { createResolver } from '../../../ontology-kit/resolver.mjs';
import { classes, properties } from '../../../ontology-kit/terms.mjs';

/** The shared class every row of the app's table is, from 0.5.0. */
export const TIME_ENTRY = classes['time-entry-v1'].subject;
/** The class of the rows in the app's Projects table. */
export const WORK_PROJECT = classes['work-project-v1'].subject;
/** The class of the rows in the app's People table. */
export const WORK_PERSON = classes['work-person-v1'].subject;

/** The shared fields this app maps, by its own key (besides Atomic's `name`). */
export const SHARED = {
  start: properties['work-start'].subject,
  end: properties['work-end'].subject,
  billable: properties['work-billable'].subject,
  /** A link to a `work-project-v1` resource. */
  project: properties['work-project'].subject,
  /** A link to a `work-person-v1` resource. */
  person: properties['work-person'].subject,
} as const;

export type SharedKey = keyof typeof SHARED;

/**
 * Up to 0.4.0 the app minted its row fields in its own ontology, under
 * these shortnames. The first open of 0.5.0 moves their values to `SHARED`
 * and removes them (`adopt.ts`). Project and member were a Clockify id plus
 * a name on the row; they become links.
 */
export const LEGACY_SHORTNAMES = {
  start: 'start',
  end: 'end',
  billable: 'billable',
  projectId: 'clockify-project-id',
  projectName: 'project',
  memberId: 'clockify-user-id',
  memberName: 'member',
} as const;

export const fields = createResolver({ classes: [classes['time-entry-v1']] });

/** The row's shared `time-entry-v1` fields, by subject. */
export function sharedValues(
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return fields.read(props, TIME_ENTRY).values;
}
