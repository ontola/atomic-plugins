// @wc-ignore-file
/**
 * Every property and class the app reads or writes, in one place.
 *
 * Atomic's own properties are fixed URLs, and so are the shared
 * `time-entry-v1` fields (`fields.ts`, #177). The app's own fields (Clockify
 * ids, settings, the observation log, sync bookkeeping) are not: a host's
 * `/app-write` rejects a property URL that does not resolve to a Property
 * (`value_for` in atomic-server's `store_host.rs`), so the app creates one
 * Property per field under its own ontology, inside its own subtree, and
 * finds them again by shortname (`schema.ts`). The same pattern as the Pets
 * and Notion drive apps.
 */

const A = 'https://atomicdata.dev';

export const atomic = {
  name: `${A}/properties/name`,
  description: `${A}/properties/description`,
  shortname: `${A}/properties/shortname`,
  datatype: `${A}/properties/datatype`,
  parent: `${A}/properties/parent`,
  isA: `${A}/properties/isA`,
  properties: `${A}/properties/properties`,
  recommends: `${A}/properties/recommends`,
  classtype: `${A}/properties/classtype`,
  propertyClass: `${A}/classes/Property`,
  tableClass: `${A}/classes/Table`,
  /** The App's own ontology, as `createApp` sets it. */
  defaultOntology: `${A}/ontology/server/property/default-ontology`,
} as const;

export const NAME = atomic.name;

export const datatypes = {
  string: `${A}/datatypes/string`,
  timestamp: `${A}/datatypes/timestamp`,
  boolean: `${A}/datatypes/boolean`,
  integer: `${A}/datatypes/integer`,
  atomicURL: `${A}/datatypes/atomicURL`,
} as const;

export interface Field {
  shortname: string;
  name: string;
  datatype: string;
  description: string;
}

const field = (
  shortname: string,
  name: string,
  datatype: string,
  description: string,
): Field => ({ shortname, name, datatype, description });

/**
 * The app's own extra on each row (not a column): the Clockify entry the row
 * is bound to. The row's values are the shared `time-entry-v1` fields
 * (`fields.ts`); up to 0.4.0 they were Properties here too.
 */
export const ROW_FIELDS = {
  entryId: field(
    'clockify-entry-id',
    'Clockify entry id',
    datatypes.string,
    'The id of the Clockify time entry this row was imported from.',
  ),
} as const;

/**
 * The app's own extras on the rows of its Projects and People tables
 * (`work-project-v1`, `work-person-v1`): which Clockify project or user the
 * row stands for. Up to 0.4.0 they were on each time entry row.
 */
export const LINK_FIELDS = {
  projectId: field(
    'clockify-project-id',
    'Clockify project id',
    datatypes.string,
    'The id of the Clockify project this row stands for.',
  ),
  memberId: field(
    'clockify-user-id',
    'Clockify user id',
    datatypes.string,
    'The id of the Clockify user this row stands for.',
  ),
} as const;

/**
 * What the App resource stores about its Clockify setup: public ids and the
 * look-back window. For a table the app is a view of (#177 item 14) the same
 * fields sit on a sync binding under the App instead, which names the table
 * with `syncedTable`. There is deliberately no field for a connection id, code,
 * token or capability. The host page holds the connection and hands the app
 * only `{ platform, connectionId }` through `store.proxy.connections()` (#21).
 */
export const SETTING_FIELDS = {
  workspaceId: field(
    'clockify-workspace',
    'Clockify workspace id',
    datatypes.string,
    'The Clockify workspace this app imports from.',
  ),
  userId: field(
    'clockify-account',
    'Clockify account id',
    datatypes.string,
    'The Clockify user whose time entries this app imports.',
  ),
  lookbackDays: field(
    'clockify-lookback-days',
    'Look-back (days)',
    datatypes.integer,
    'How many days back each import reads: 7 or 30.',
  ),
  syncedTable: field(
    'clockify-synced-table',
    'Synced table',
    datatypes.atomicURL,
    'The time entry table, not the app’s own, that this sync binding keeps in step with Clockify (#177 item 14). On a binding under the app, next to its own workspace, account, look-back and observation log.',
  ),
} as const;

/**
 * The observation log (#123 M1, `observationLog.ts`), stored as Atomic
 * resources in the app's own subtree (#97 answer 4): a pointer on the App,
 * one head resource, and one resource per incremental and per snapshot
 * under it. JSON text in string properties, as the issue-tracker app does
 * with its sync state; editing them by hand breaks the log.
 */
export const LOG_FIELDS = {
  log: field(
    'clockify-observation-log',
    'Clockify observation log',
    datatypes.string,
    "The subject of this app's Clockify observation log head.",
  ),
  head: field(
    'clockify-log-head',
    'Clockify log head',
    datatypes.string,
    'JSON text: the current snapshot, the incrementals after it and what has been read. Written by the timesheets app; do not edit.',
  ),
  observation: field(
    'clockify-observation',
    'Clockify observation',
    datatypes.string,
    'JSON text: one read from Clockify, as a diff against what the app knew before. Written by the timesheets app; do not edit.',
  ),
  snapshot: field(
    'clockify-snapshot',
    'Clockify snapshot',
    datatypes.string,
    'JSON text: the Clockify mirror folded up to a point in the log. Written by the timesheets app; do not edit.',
  ),
  lease: field(
    'clockify-lease',
    'Clockify send lease',
    datatypes.string,
    'JSON text: which open copy of the timesheets app is sending changes to Clockify, and until when (#123 M5). Advisory. Written by the timesheets app; do not edit.',
  ),
  intent: field(
    'clockify-intent',
    'Clockify range edit',
    datatypes.string,
    'JSON text: one range edit or conflict resolution made in the timesheets app (#123 M5), with the rows it changed and the edits it replaces. Written by the timesheets app; do not edit.',
  ),
  intentOf: field(
    'clockify-intent-of',
    'Clockify range edit of',
    datatypes.string,
    'The Clockify observation log head this range edit belongs to, so the app can find every range edit.',
  ),
} as const;

/**
 * Sync bookkeeping on each row (#177 Q4: "bookkeeping lives on the row"),
 * as provider extras: not in the row class's `recommends`, so the table
 * does not show them as columns. JSON text in string properties.
 */
export const SYNC_FIELDS = {
  baseline: field(
    'clockify-sync-baseline',
    'Clockify sync baseline',
    datatypes.string,
    'JSON text: the values this row and Clockify last agreed on. A row that differs from it has changes to send. Written by the timesheets app; do not edit.',
  ),
  outbox: field(
    'clockify-outbox',
    'Clockify outbox',
    datatypes.string,
    'JSON text: a write to Clockify that was started and not yet confirmed; empty when none. Written by the timesheets app; do not edit.',
  ),
  deleteRequested: field(
    'clockify-delete',
    'Delete in Clockify',
    datatypes.boolean,
    'True when someone asked to delete this entry in Clockify and it has not been sent yet.',
  ),
  create: field(
    'clockify-create',
    'Clockify create',
    datatypes.string,
    'JSON text: this row is a new entry still to be created in Clockify (a range edit, #123 M4), and what it copies; empty once created. Written by the timesheets app; do not edit.',
  ),
} as const;

export type RowKey = keyof typeof ROW_FIELDS;
export type LinkKey = keyof typeof LINK_FIELDS;
export type SyncKey = keyof typeof SYNC_FIELDS;
export type SettingKey = keyof typeof SETTING_FIELDS;
export type LogKey = keyof typeof LOG_FIELDS;
