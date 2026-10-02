// @wc-ignore-file
/**
 * "Changes to send": the strip that counts edits not yet in Notion, and the
 * review that lists them (before → after per field), resolves conflicts
 * and sends. Nothing reaches Notion until the person presses Send
 * (#177 Q4–Q7: review every send while testing). The changes come from the
 * controller (`changes.ts`), wherever the edit was made: since the browsing
 * views went (#177 Q9), that is the host's own table and views.
 */
import type { FieldChange, RowChange } from '../changes.js';
import { sendable } from '../changes.js';
import type { ConnectedState } from '../controller.js';
import type { SendOutcome } from '../send.js';
import type { JSONValue } from '../store.js';
import type { NotionOption } from '../sync.js';
import { h, icon, type Child } from '../ui/dom.js';
import { plural } from '../ui/format.js';
import { button } from '../ui/shell.js';

export interface ReviewActions {
  open(): void;
  close(): void;
  send(): void;
  discard(subject: string): void;
  resolve(subject: string, shortname: string, keep: 'mine' | 'notion'): void;
}

const OUTCOME: Record<SendOutcome['status'], string> = {
  sent: 'Sent to Notion',
  changed: 'Changed in Notion since; not sent',
  gone: 'Archived, deleted or no longer shared in Notion; not sent. The row is kept here',
  refused: 'Not sent',
  failed: 'Not sent; sending stopped',
  unknown: 'Unknown whether Notion applied it; sending stopped',
};

/** Notion's ten option colours; anything else renders as `default`. */
export const NOTION_COLOURS = new Set([
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
]);

/** A select, status or multi-select option as a pill in Notion's colour. */
export function optionPill(
  doc: Document,
  option: NotionOption | undefined,
  id: string,
  status: boolean,
): HTMLElement {
  const colour =
    option && NOTION_COLOURS.has(option.color) ? option.color : 'default';

  return h(
    doc,
    'span',
    {
      class: `nt-tag${status ? ' nt-status' : ''} c-${colour}`,
      title: option
        ? undefined
        : `Option ${id} is not in the last sync’s schema`,
    },
    option?.name || (option ? 'Untitled option' : 'Unknown option'),
  );
}

const fieldCount = (changes: readonly RowChange[]) =>
  changes.reduce((n, c) => n + c.fields.length, 0);

/** The one-line strip above the status card, when there is something to review. */
export function renderChangesBar(
  doc: Document,
  state: ConnectedState,
  open: boolean,
  actions: ReviewActions,
): HTMLElement | null {
  const changes = state.changes ?? [];
  if (open || (!changes.length && !state.outcomes?.length)) return null;
  const conflicts = changes.filter(c => c.fields.some(f => f.conflict)).length;

  return h(
    doc,
    'div',
    { class: 'nt-changes', 'data-key': 'changes-bar' },
    icon(doc, 'sync'),
    h(
      doc,
      'p',
      {},
      changes.length
        ? [
            h(doc, 'b', {}, plural(fieldCount(changes), 'change')),
            ` in ${plural(changes.length, 'row')} not sent to Notion yet`,
            conflicts
              ? ` · ${plural(conflicts, 'row')} also changed in Notion`
              : '',
          ]
        : 'All reviewed changes were handled.',
    ),
    button(doc, {
      kind: 'secondary',
      size: 'sm',
      label: changes.length ? 'Review changes' : 'Show results',
      key: 'review-open',
      onClick: actions.open,
    }),
  );
}

/** A value as the review shows it: option names in their colours. */
function shown(
  doc: Document,
  field: FieldChange,
  value: JSONValue | undefined,
  options: ReadonlyMap<string, { name: string; color: string }>,
): Child {
  const option = (id: string) =>
    optionPill(
      doc,
      options.has(id) ? { id, ...options.get(id)! } : undefined,
      id,
      field.type === 'status',
    );

  switch (field.type) {
    case 'select':
    case 'status':
      if (typeof value === 'string' && value) return option(value);
      if (Array.isArray(value) && value.length)
        // More than one Tag in a single-option cell: shown, held back.
        return h(
          doc,
          'span',
          { class: 'nt-tags' },
          value.map(v => option(String(v))),
        );

      return h(doc, 'i', {}, 'empty');
    case 'multi_select':
      return Array.isArray(value) && value.length
        ? h(
            doc,
            'span',
            { class: 'nt-tags' },
            value.map(v => option(String(v))),
          )
        : h(doc, 'i', {}, 'empty');
    case 'checkbox':
      return value === true ? 'Checked' : 'Not checked';
    default:
      return value === undefined || value === null || value === ''
        ? h(doc, 'i', {}, 'empty')
        : String(value);
  }
}

export function renderReview(
  doc: Document,
  state: ConnectedState,
  actions: ReviewActions,
): HTMLElement {
  const changes = state.changes ?? [];
  const outcomes = new Map(
    (state.outcomes ?? []).map(o => [o.subject, o] as const),
  );
  const ready = changes.filter(sendable);
  const busy = !!state.sending || state.kind !== 'ready';
  const optionsOf = (change: RowChange, field: FieldChange) =>
    new Map(
      (
        state.last?.dataSources
          .find(d => d.id === change.dataSource)
          ?.properties.find(p => p.id === field.id)?.options ?? []
      ).map(o => [o.id, o]),
    );

  const outcomeLine = (outcome: SendOutcome | undefined) =>
    outcome &&
    h(
      doc,
      'p',
      {
        class: `nt-r-outcome is-${outcome.status}`,
        'data-outcome': outcome.status,
      },
      icon(doc, outcome.status === 'sent' ? 'check' : 'alert', 'sm'),
      'message' in outcome
        ? `${OUTCOME[outcome.status]}: ${outcome.message}`
        : OUTCOME[outcome.status],
    );

  const items = changes.map(change =>
    h(
      doc,
      'li',
      { 'data-subject': change.subject },
      h(
        doc,
        'div',
        { class: 'nt-r-head' },
        h(doc, 'b', {}, change.name),
        h(
          doc,
          'span',
          { class: 'nt-dbname' },
          icon(doc, 'db'),
          change.dataSourceTitle,
        ),
        button(doc, {
          kind: 'ghost',
          size: 'sm',
          label: 'Discard',
          key: `discard:${change.subject}`,
          disabled: busy,
          onClick: () => actions.discard(change.subject),
        }),
      ),
      h(
        doc,
        'dl',
        { class: 'nt-r-fields' },
        change.fields.flatMap(field => {
          const options = optionsOf(change, field);

          return [
            h(doc, 'dt', {}, field.name),
            h(
              doc,
              'dd',
              {},
              h(
                doc,
                'span',
                { class: 'nt-r-change' },
                h(
                  doc,
                  'span',
                  { class: 'nt-r-before' },
                  shown(doc, field, field.before, options),
                ),
                ' → ',
                h(
                  doc,
                  'span',
                  { class: 'nt-r-after' },
                  shown(doc, field, field.after, options),
                ),
              ),
              field.problem &&
                h(
                  doc,
                  'p',
                  { class: 'nt-d-warn' },
                  icon(doc, 'alert', 'sm'),
                  h(
                    doc,
                    'span',
                    {},
                    `Can’t be sent: the value ${field.problem}. Fix it in the table, or discard it.`,
                  ),
                ),
              field.conflict &&
                h(
                  doc,
                  'div',
                  { class: 'nt-r-conflict' },
                  h(
                    doc,
                    'p',
                    { class: 'nt-d-warn' },
                    icon(doc, 'alert', 'sm'),
                    h(
                      doc,
                      'span',
                      {},
                      'Also changed in Notion, to ',
                      shown(doc, field, field.notion, options),
                    ),
                  ),
                  button(doc, {
                    kind: 'secondary',
                    size: 'sm',
                    label: 'Keep mine',
                    key: `keep-mine:${change.subject}:${field.shortname}`,
                    disabled: busy,
                    onClick: () =>
                      actions.resolve(change.subject, field.shortname, 'mine'),
                  }),
                  button(doc, {
                    kind: 'secondary',
                    size: 'sm',
                    label: 'Use Notion’s',
                    key: `use-notion:${change.subject}:${field.shortname}`,
                    disabled: busy,
                    onClick: () =>
                      actions.resolve(
                        change.subject,
                        field.shortname,
                        'notion',
                      ),
                  }),
                ),
            ),
          ];
        }),
      ),
      outcomeLine(outcomes.get(change.subject)),
    ),
  );

  // Rows that left the list (sent) still show what happened to them.
  const listed = new Set(changes.map(c => c.subject));
  const done = (state.outcomes ?? []).filter(o => !listed.has(o.subject));

  return h(
    doc,
    'section',
    {
      class: 'nt-review',
      'aria-label': 'Changes to send to Notion',
      'data-key': 'review',
      tabindex: -1,
    },
    h(
      doc,
      'div',
      { class: 'nt-r-top' },
      h(doc, 'h2', {}, 'Changes to send to Notion'),
      button(doc, {
        kind: 'ghost',
        size: 'sm',
        icon: 'close',
        label: 'Close',
        key: 'review-close',
        onClick: actions.close,
      }),
    ),
    h(
      doc,
      'p',
      { class: 'nt-muted' },
      'Edits to these rows, made here or anywhere else in Atomic, since they last matched Notion. Nothing is sent until you press Send. A row also changed in Notion waits until you choose which value to keep.',
    ),
    changes.length
      ? h(doc, 'ul', { class: 'nt-r-list' }, items)
      : h(doc, 'p', {}, 'Nothing left to send.'),
    done.length > 0 &&
      h(
        doc,
        'ul',
        { class: 'nt-r-list is-done' },
        done.map(o =>
          h(
            doc,
            'li',
            {},
            h(doc, 'b', {}, o.name || 'Sending'),
            outcomeLine(o),
          ),
        ),
      ),
    h(
      doc,
      'div',
      { class: 'nt-r-foot' },
      button(doc, {
        kind: 'primary',
        icon: 'sync',
        label: state.sending
          ? 'Sending…'
          : ready.length
            ? `Send ${plural(fieldCount(ready), 'change')}`
            : 'Send',
        key: 'review-send',
        busy: !!state.sending,
        disabled: !ready.length || busy,
        onClick: actions.send,
      }),
      ready.length < changes.length &&
        h(
          doc,
          'span',
          { class: 'nt-muted' },
          `${plural(changes.length - ready.length, 'row')} held back until resolved`,
        ),
    ),
  );
}
