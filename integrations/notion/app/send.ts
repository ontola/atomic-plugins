// @wc-ignore-file
/**
 * Sends reviewed edits to Notion, one page at a time, through the host's
 * proxy (`store.proxy.request`). Nothing is sent without the person pressing
 * Send in the review (#177 Q4–Q7: review every send while testing).
 *
 * Per row:
 * 1. `GET /v1/pages/{id}`: the page as Notion has it now. A page that is gone
 *    (404), archived or in trash is not written: the row is kept and
 *    reported, never deleted.
 * 2. Every field to send must still hold its baseline value in Notion. One
 *    that Notion changed since is a conflict: nothing of that row is sent,
 *    and Notion's value is reported for "Keep mine" / "Use Notion's".
 *    Formatted text in Notion is never overwritten with plain text.
 * 3. `PATCH /v1/pages/{id}` with only the changed properties, keyed by
 *    Notion's stable property id. The baseline advances only for fields
 *    Notion confirmed, from the page it answers with.
 *
 * Notion has no conditional writes (no ETag or If-Match on pages), so an
 * edit made in Notion between steps 1 and 3 is overwritten. That window is
 * one round trip; it is a declared limit, not handled.
 *
 * A relay call that throws on the PATCH may or may not have reached Notion:
 * that row is "unknown", and the batch stops. So is a 5xx answer (a gateway
 * may answer 502 or 504 after Notion applied the PATCH). A refusal by the
 * proxy or a rate limit also stops the batch; those wrote nothing.
 */
import {
  notionFieldValue,
  notionPropertyValue,
  type JSONValue as LensValue,
} from '../devonian/notion/index.js';
import {
  BASELINE_SHORTNAME,
  nameForTitle,
  normalize,
  parseBaseline,
  same,
  sendable,
  TITLE_ID,
  type FieldChange,
  type RowChange,
} from './changes.js';
import { hostValueFor } from './options.js';
import type { Column, Schema } from './record.js';
import type {
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';
import { atomic } from './sync.js';
import { PLATFORM, proxyRefusal } from './transport.js';

export type SendOutcome = { subject: string; name: string } & (
  | { status: 'sent'; fields: number }
  /** Changed in Notion since the baseline: now conflicts to resolve. */
  | { status: 'changed'; notion: Record<string, JSONValue | undefined> }
  /** Archived, in trash, or no longer shared with the integration. */
  | { status: 'gone' }
  /**
   * Not sent: the value cannot be written, or Notion refused it. With
   * `written`, the opposite: Notion applied the PATCH, but the row here
   * could not be updated from its answer; the next sync reads it back.
   */
  | { status: 'refused'; message: string; written?: true }
  /** Not sent, and the batch stopped (a proxy refusal, a rate limit). */
  | { status: 'failed'; message: string }
  /**
   * The PATCH got no usable answer (none, or a 5xx a gateway may send after
   * Notion applied it): Notion may or may not have applied it. The batch
   * stops; the next sync settles the row (`changes.ts` `isSettled`).
   */
  | { status: 'unknown'; message: string }
);

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Notion's error message from a response body, else the status. */
const notionMessage = (status: number, body: unknown) => {
  const text = object(body).message;

  return typeof text === 'string' && text
    ? `Notion answered ${status}: ${text}`
    : `Notion answered ${status}`;
};

/** A page's raw property by stable id. */
const property = (page: unknown, id: string) =>
  Object.values(object(object(page).properties))
    .map(object)
    .find(p => p.id === id);

/** The value Notion holds for a field, `undefined` for its empty. */
function notionValue(
  page: unknown,
  field: FieldChange,
): { value: JSONValue | undefined } | { problem: string } {
  const raw = property(page, field.id);
  if (!raw) return { problem: `${field.name} is no longer in Notion` };
  if (raw.type !== field.type)
    return { problem: `${field.name} is now a ${String(raw.type)} in Notion` };
  const value = notionFieldValue(field.type, raw[field.type]);
  if (value === undefined)
    return {
      problem: `${field.name} has formatting in Notion; edit it there`,
    };

  return { value: value ?? undefined };
}

export interface SendArgs {
  store: PluginStore;
  proxy: HostProxy;
  connectionId: string;
  schema: Schema;
  changes: readonly RowChange[];
  onOutcome?: (outcome: SendOutcome) => void;
}

/** Sends every sendable row in `changes`, in order. */
export async function sendChanges({
  store,
  proxy,
  connectionId,
  schema,
  changes,
  onOutcome = () => {},
}: SendArgs): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];

  const report = (outcome: SendOutcome) => {
    outcomes.push(outcome);
    onOutcome(outcome);

    return outcome.status;
  };

  for (const change of changes.filter(sendable)) {
    const who = { subject: change.subject, name: change.name };
    const path = `/v1/pages/${encodeURIComponent(change.pageId)}`;
    const call = (method: 'GET' | 'PATCH', body?: unknown) =>
      proxy.request({
        platform: PLATFORM,
        connectionId,
        path,
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    let current;

    try {
      current = await call('GET');
    } catch (error) {
      report({
        ...who,
        status: 'failed',
        message: `Could not read the page from Notion: ${message(error)}`,
      });
      break;
    }

    const refusedRead = proxyRefusal(current);

    if (refusedRead) {
      report({ ...who, status: 'failed', message: refusedRead.message });
      break;
    }

    const page = object(current.body);

    if (
      current.status === 404 ||
      (current.status === 200 &&
        (page.archived === true || page.in_trash === true))
    ) {
      report({ ...who, status: 'gone' });
      continue;
    }

    if (current.status < 200 || current.status >= 300) {
      report({
        ...who,
        status: 'failed',
        message: notionMessage(current.status, current.body),
      });
      break;
    }

    const notion: Record<string, JSONValue | undefined> = {};
    const problems: string[] = [];
    const properties: Record<string, unknown> = {};

    for (const field of change.fields) {
      const found = notionValue(page, field);

      if ('problem' in found) {
        problems.push(found.problem);
        continue;
      }

      if (!same(field.type, found.value, field.before))
        notion[field.shortname] = found.value;

      try {
        properties[field.id] = {
          [field.type]: notionPropertyValue(
            field.type,
            normalize(field.type, field.after) as LensValue,
          ),
        };
      } catch (error) {
        problems.push(`${field.name}: ${message(error)}`);
      }
    }

    if (problems.length) {
      report({ ...who, status: 'refused', message: problems.join('; ') });
      continue;
    }

    if (Object.keys(notion).length) {
      report({ ...who, status: 'changed', notion });
      continue;
    }

    let answer;

    try {
      answer = await call('PATCH', { properties });
    } catch (error) {
      report({
        ...who,
        status: 'unknown',
        message: `No answer from Notion, so it is unknown whether the change was applied: ${message(error)}`,
      });
      break;
    }

    const refused = proxyRefusal(answer);

    if (refused) {
      report({ ...who, status: 'failed', message: refused.message });
      break;
    }

    if (answer.status === 429) {
      report({
        ...who,
        status: 'failed',
        message: notionMessage(answer.status, answer.body),
      });
      break;
    }

    // A 5xx may come from a gateway after Notion applied the PATCH (502,
    // 504), so it is not "nothing was written": unknown, like a lost answer.
    if (answer.status >= 500) {
      report({
        ...who,
        status: 'unknown',
        // Short: the review's own prefix already says it is unknown.
        message: `Notion answered ${answer.status}: ${notionMessage(answer.status, answer.body)}`,
      });
      break;
    }

    if (answer.status === 404) {
      report({ ...who, status: 'gone' });
      continue;
    }

    if (answer.status < 200 || answer.status >= 300) {
      report({
        ...who,
        status: 'refused',
        message: notionMessage(answer.status, answer.body),
      });
      continue;
    }

    try {
      await confirm(store, schema, change, answer.body);
    } catch (error) {
      report({
        ...who,
        status: 'refused',
        written: true,
        message: `Sent to Notion, but this row could not be updated here: ${message(error)}. The next sync reads it back.`,
      });
      continue;
    }

    report({ ...who, status: 'sent', fields: change.fields.length });
  }

  return outcomes;
}

/**
 * Writes a lens value (an option id or ids for a select column) into a host
 * cell as the host holds it (Tag subjects, `options.ts`), or removes it.
 */
function setCell(
  row: PluginResource,
  schema: Schema,
  column: Column | undefined,
  value: JSONValue | undefined,
): void {
  if (!column) return;
  const host = hostValueFor(column, value, schema.options);
  if (host === undefined) row.remove(column.subject);
  else row.set(column.subject, host);
}

/**
 * After Notion confirmed a PATCH: the sent fields and the baseline take the
 * values from the page Notion answered with, and so does the last-edited
 * time. Other fields are left for the next sync.
 */
async function confirm(
  store: PluginStore,
  schema: Schema,
  change: RowChange,
  page: unknown,
): Promise<void> {
  const row = await store.getResource(change.subject);
  const baselineColumn = schema.columns.get(BASELINE_SHORTNAME);
  if (!baselineColumn) throw new Error('No baseline column');
  const baseline = parseBaseline(row.get(baselineColumn.subject));
  if (!baseline) throw new Error('The row lost its baseline');

  for (const field of change.fields) {
    const found = notionValue(page, field);
    const value = 'value' in found ? found.value : field.after;
    if (value === undefined) delete baseline.fields[field.shortname];
    else baseline.fields[field.shortname] = value;
    setCell(row, schema, schema.columns.get(field.shortname), value);
    if (field.id === TITLE_ID) row.set(atomic.name, nameForTitle(value));
  }

  const edited = object(page).last_edited_time;
  const editedColumn = schema.columns.get('notion-last-edited');
  if (editedColumn && typeof edited === 'string' && Date.parse(edited))
    row.set(editedColumn.subject, Date.parse(edited));
  row.set(baselineColumn.subject, JSON.stringify(baseline));
  await row.save();
}

/**
 * "Use Notion's" for a conflicting field: the row and the baseline take
 * Notion's value. "Keep mine": only the baseline does, so the row's value
 * stays a change to review and send.
 */
export async function resolveConflict(
  store: PluginStore,
  schema: Schema,
  change: RowChange,
  field: FieldChange,
  keep: 'mine' | 'notion',
): Promise<void> {
  const row = await store.getResource(change.subject);
  const baselineColumn = schema.columns.get(BASELINE_SHORTNAME);
  const baseline = baselineColumn
    ? parseBaseline(row.get(baselineColumn.subject))
    : undefined;
  if (!baselineColumn || !baseline) throw new Error('The row has no baseline');
  const value = field.notion;
  if (value === undefined) delete baseline.fields[field.shortname];
  else baseline.fields[field.shortname] = value;

  // The column takes the value that stays: Notion's, or the row's own. For
  // the title that row value may have come from a rename of the row, so the
  // column is written either way and stays in step with the name.
  const kept = keep === 'notion' ? value : field.after;
  setCell(row, schema, schema.columns.get(field.shortname), kept);
  if (field.id === TITLE_ID) row.set(atomic.name, nameForTitle(kept));

  row.set(baselineColumn.subject, JSON.stringify(baseline));
  await row.save();
}

/** "Discard": the row's changed fields go back to the baseline. */
export async function discardChange(
  store: PluginStore,
  schema: Schema,
  change: RowChange,
): Promise<void> {
  const row = await store.getResource(change.subject);

  for (const field of change.fields) {
    const value = field.before;
    setCell(row, schema, schema.columns.get(field.shortname), value);
    if (field.id === TITLE_ID) row.set(atomic.name, nameForTitle(value));
  }

  await row.save();
}
