// @wc-ignore-file
/**
 * What a Todoist task becomes in the `issue-v1` table, through the shared
 * lens catalog's `todoist-task-issue-v2` (ontology-kit/LENSES.md) instead of
 * mapping code of this app's own: name, body, status and due day.
 *
 * The lens and its interpreter are bundled at build time, like terms.mjs:
 * `lenses.mjs` holds the published file's mapping (only this lens is
 * bundled), `lens.mjs` runs it. A
 * pass writes the table from a task, which is the lens's backward put: the
 * view is the task as Todoist returned it, the previous row is the row's
 * current issue-v1 values. So unchanged values keep their exact form, and a
 * due date Todoist no longer has is removed (`absent: "unset"`).
 *
 * A task the lens refuses (a deleted one, one without content, one whose
 * due date has a fixed time zone; LensError codes `out-of-domain` and
 * `bad-value`) changes no issue-v1 value: the row keeps what it last had,
 * and the pass reports the task (`SyncSummary.unmapped`).
 */
import { LensError, lensPut } from '../../../ontology-kit/lens.mjs';
import { todoistTaskIssueV2 } from '../../../ontology-kit/lenses.mjs';
import {
  ISSUE_V1,
  NAME,
  TASK_BODY,
  TASK_DUE_DATE,
  TASK_STATUS,
} from './drive.js';
import type { JSONValue } from './store.js';

export const TODOIST_LENS = todoistTaskIssueV2;

/** The issue-v1 properties the lens writes, which a pass may set or remove. */
export const LENS_FIELDS = [NAME, TASK_BODY, TASK_STATUS, TASK_DUE_DATE];

if (
  !('class' in TODOIST_LENS.target) ||
  TODOIST_LENS.target.class !== ISSUE_V1 ||
  TODOIST_LENS.mapping.fields.some(f => !LENS_FIELDS.includes(f.target))
)
  throw new Error(
    `${TODOIST_LENS['@id']} does not write the issue-v1 fields this app expects`,
  );

export type TaskMapping =
  | { set: Record<string, JSONValue>; unset: string[] }
  | { refused: string };

/**
 * The issue-v1 values for one task, written onto `previous` (a row's
 * current values of `LENS_FIELDS`, or `{}` for a new row).
 */
export function issueFromTask(
  task: Record<string, unknown>,
  previous: Record<string, JSONValue>,
): TaskMapping {
  let next: Record<string, unknown>;

  try {
    next = lensPut(TODOIST_LENS.mapping, task, previous, 'backward');
  } catch (error) {
    if (error instanceof LensError) return { refused: error.message };
    throw error;
  }

  const set: Record<string, JSONValue> = {};
  const unset: string[] = [];

  for (const property of LENS_FIELDS)
    if (next[property] === undefined) {
      if (previous[property] !== undefined) unset.push(property);
    } else set[property] = next[property] as JSONValue;

  return { set, unset };
}
