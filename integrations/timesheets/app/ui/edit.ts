// @wc-ignore-file
/**
 * Editing entries and the "Changes to send" list (#123 M3, #177 §4.3).
 *
 * An edit in the drawer is saved to the entry's table row, like an edit in
 * the table itself; nothing reaches Clockify until it is sent from the
 * list. The list shows every row that differs from what Clockify last had,
 * however it was changed, field by field, with Discard per entry.
 */
import type { ChangesState, EntryEdit } from '../controller.js';
import type { ClockifyProject } from '../../devonian/clockify/lens/index.js';
import { dayKey, formatDay, formatTime } from '../model/time.js';
import type { TimeEntry, Timesheet } from '../model/types.js';
import { instantsOf, wallClock } from '../timeZone.js';
import type {
  EntryField,
  EntryValues,
  PendingChange,
  SendOutcome,
} from '../writeBack.js';
import { banner, button } from './components.js';
import type { Child, H } from './dom.js';

const LABELS: Record<EntryField, string> = {
  name: 'Description',
  projectId: 'Project',
  billable: 'Billable',
  start: 'Start',
  end: 'End',
};

/** `2026-09-22T09:30` in `timeZone`, for a `datetime-local` input. */
export const localInput = (at: number, timeZone: string) =>
  new Date(wallClock(at, timeZone)).toISOString().slice(0, 16);

/** A `datetime-local` value in `timeZone` back to an instant (the earlier
 * one in a repeated hour); undefined when it is not a valid time. */
export function fromLocalInput(
  value: string,
  timeZone: string,
): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall)) return undefined;

  return instantsOf(wall, timeZone)[0];
}

/** A value as the list shows it. */
export function valueText(
  field: EntryField,
  values: EntryValues,
  timeZone: string,
): string {
  switch (field) {
    case 'name':
      return values.name;
    case 'projectId':
      return (
        values.project ?? (values.projectId ? values.projectId : 'No project')
      );
    case 'billable':
      return values.billable ? 'Yes' : 'No';
    case 'start':
    case 'end':
      return `${formatDay(dayKey(values[field], timeZone))} ${formatTime(values[field], timeZone)}`;
  }
}

/** One line per changed field: `Start: 22 Sep 09:00 → 22 Sep 09:15`. */
export function changeLines(change: PendingChange, timeZone: string): string[] {
  if (change.kind === 'delete') return ['Delete this entry in Clockify'];
  if (change.kind === 'create')
    return [
      `${change.copyOf ? 'Create the rest of the split entry' : 'Create a new entry'}: ${valueText('start', change.desired, timeZone)} – ${formatTime(change.desired.end, timeZone)}, ${valueText('projectId', change.desired, timeZone)}`,
    ];

  return change.fields.map(
    f =>
      `${LABELS[f]}: ${valueText(f, change.base, timeZone)} → ${valueText(f, change.desired, timeZone)}`,
  );
}

const OUTCOME_TEXT: Record<SendOutcome['status'], string> = {
  sent: 'Sent',
  adjusted: 'Sent; Clockify stored other values',
  already: 'Clockify already had this',
  conflict: 'Not sent: changed in Clockify, Clockify’s values kept',
  refused: 'Not sent',
  failed: 'Failed',
  uncertain: 'Unknown whether it arrived',
  'not-sent': 'Not sent (stopped after an earlier one)',
  changed: 'Not sent: changed after review',
  gone: 'Deleted in Clockify; row removed',
  bound: 'Clockify already had it',
};

export function outcomeText(outcome: SendOutcome): string {
  const what =
    outcome.kind === 'delete'
      ? `Delete “${outcome.title}”`
      : `“${outcome.title}”`;

  return `${what}: ${OUTCOME_TEXT[outcome.status]}${outcome.message ? `. ${outcome.message}` : ''}`;
}

export interface ChangesActions {
  onSend: () => void;
  onDiscard: (entryId: string) => void;
  /** Opens the entry's drawer. */
  onOpen: (entryId: string) => void;
}

/**
 * The "Changes to send" region, or null when there is nothing to show:
 * no change, no notice, no outcome.
 */
export function renderChanges(
  h: H,
  changes: ChangesState,
  sheet: Timesheet,
  actions: ChangesActions,
  busy: boolean,
): HTMLElement | null {
  const { review, providerWon, recovered, outcomes, sending, error } = changes;
  if (
    !review.length &&
    !providerWon.length &&
    !recovered.length &&
    !outcomes?.results.length &&
    !error
  )
    return null;
  const tz = sheet.timeZone;
  const sendable = review.filter(c => !c.blockers.length);
  const parts: Child[] = [];

  if (review.length)
    parts.push(
      h(
        'p',
        null,
        h(
          'strong',
          null,
          `${review.length} ${review.length === 1 ? 'change' : 'changes'} to send to Clockify`,
        ),
        ' Made in this drive and not sent yet. Nothing is sent until you press Send.',
      ),
      h(
        'ul',
        { class: 'chg' },
        review.map(change =>
          h(
            'li',
            { 'data-entry': change.entryId },
            h(
              'div',
              { class: 'chg-head' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'link',
                  'data-open': change.entryId,
                },
                change.title,
              ),
              button(h, 'Discard', {
                variant: 'ghost',
                key: `discard:${change.entryId}`,
                label: `Discard the change to ${change.title}`,
                disabled: busy,
                onClick: () => actions.onDiscard(change.entryId),
              }),
            ),
            h(
              'ul',
              null,
              changeLines(change, tz).map(line => h('li', null, line)),
            ),
            change.blockers.length
              ? h(
                  'p',
                  { class: 'chg-blocked' },
                  `Cannot be sent: ${change.blockers.join(' ')}`,
                )
              : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        button(
          h,
          sending
            ? `Sending ${Math.min(sending.done + 1, sending.total)} of ${sending.total}…`
            : `Send ${sendable.length} to Clockify`,
          {
            key: 'send-changes',
            disabled: busy || !sendable.length,
            onClick: actions.onSend,
          },
        ),
      ),
    );

  if (providerWon.length)
    parts.push(
      h(
        'div',
        {
          class: 'chg-notes',
          role: 'note',
          'aria-label': 'Kept from Clockify',
        },
        h(
          'strong',
          null,
          'Changed here and in Clockify: Clockify’s values were kept.',
        ),
        h(
          'ul',
          null,
          providerWon.map(p =>
            h(
              'li',
              null,
              `“${p.title}”: `,
              p.fields
                .map(f =>
                  f.field === 'delete'
                    ? 'your deletion was dropped'
                    : `${LABELS[f.field]} is “${String(f.clockify ?? '')}” (yours was “${String(f.yours ?? '')}”)`,
                )
                .join('; '),
            ),
          ),
        ),
      ),
    );

  if (recovered.length)
    parts.push(
      h(
        'p',
        { class: 'muted' },
        recovered
          .map(r =>
            r.applied
              ? `An interrupted send of “${r.title}” had arrived in Clockify.`
              : `An interrupted send of “${r.title}” had not arrived; it is listed again.`,
          )
          .join(' '),
      ),
    );

  if (outcomes?.results.length)
    parts.push(
      h(
        'div',
        { 'aria-label': 'Last send' },
        h('strong', null, 'Last send'),
        h(
          'ul',
          null,
          outcomes.results.map(o =>
            h('li', { 'data-status': o.status }, outcomeText(o)),
          ),
        ),
      ),
    );

  if (error)
    parts.push(
      banner(h, {
        tone: 'neg',
        icon: 'err',
        lead: 'Could not change this:',
        text: error,
        role: 'alert',
      }),
    );

  const section = h(
    'section',
    { class: 'changes', 'aria-label': 'Changes to send' },
    ...parts,
  );

  section.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest('[data-open]');
    const id = target?.getAttribute('data-open');
    if (id) actions.onOpen(id);
  });

  return section;
}

/** "Not sent" on an entry row and in the drawer. */
export const pendingTag = (h: H, kind: TimeEntry['pending']) =>
  kind
    ? h(
        'span',
        { class: 'tag-pending' },
        kind === 'delete'
          ? 'Delete not sent'
          : kind === 'create'
            ? 'New, not sent'
            : 'Not sent',
      )
    : null;

export interface EditorProps {
  timeZone: string;
  projects: ClockifyProject[];
  projectRequired: boolean;
  onSave: (edit: EntryEdit) => void;
  onCancel: () => void;
}

/**
 * The drawer's edit form: Description, Project, Billable, Start and End
 * (in `timeZone`, to the minute). Returns the body and the footer.
 */
export function entryEditor(
  h: H,
  entry: TimeEntry,
  p: EditorProps,
): { body: HTMLElement; footer: HTMLElement[] } {
  const description = h('input', {
    id: 'ed-desc',
    type: 'text',
    class: 'inp',
    value: entry.description,
  });
  const projectSelect = h(
    'select',
    { id: 'ed-proj', class: 'sel' },
    p.projectRequired
      ? null
      : h('option', { value: '', selected: !entry.project }, 'No project'),
    ...p.projects.map(project =>
      h(
        'option',
        { value: project.id, selected: entry.project?.id === project.id },
        project.name,
      ),
    ),
    entry.project && !p.projects.some(x => x.id === entry.project!.id)
      ? h(
          'option',
          { value: entry.project.id, selected: true },
          entry.project.name ?? entry.project.id,
        )
      : null,
  );
  const billable = h('input', {
    id: 'ed-bill',
    type: 'checkbox',
    checked: entry.billable,
  });
  const start = h('input', {
    id: 'ed-start',
    type: 'datetime-local',
    class: 'inp',
    step: 60,
    value: localInput(entry.start, p.timeZone),
  });
  const end = h('input', {
    id: 'ed-end',
    type: 'datetime-local',
    class: 'inp',
    step: 60,
    value: localInput(entry.end, p.timeZone),
  });
  const problem = h('p', { class: 'chg-blocked', role: 'alert', hidden: true });
  const field = (id: string, label: string, control: HTMLElement) =>
    h('div', { class: 'field' }, h('label', { for: id }, label), control);

  const save = () => {
    const from = fromLocalInput(start.value, p.timeZone);
    const to = fromLocalInput(end.value, p.timeZone);

    if (from === undefined || to === undefined || !(from < to)) {
      problem.textContent = 'Start has to be a time before end.';
      problem.hidden = false;

      return;
    }

    const edit: EntryEdit = {};
    const name = description.value.trim();
    if (name !== entry.description) edit.name = name;
    const projectId = projectSelect.value || null;
    if (projectId !== (entry.project?.id ?? null)) edit.projectId = projectId;
    if (billable.checked !== entry.billable) edit.billable = billable.checked;
    // Unchanged minutes keep the entry's seconds.
    if (localInput(entry.start, p.timeZone) !== start.value) edit.start = from;
    if (localInput(entry.end, p.timeZone) !== end.value) edit.end = to;
    p.onSave(edit);
  };

  const body = h(
    'form',
    { class: 'edit', 'aria-label': 'Edit entry' },
    field('ed-desc', 'Description', description),
    field('ed-proj', 'Project', projectSelect),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'ed-bill', class: 'check' }, billable, ' Billable'),
    ),
    field('ed-start', `Start (${p.timeZone})`, start),
    field('ed-end', `End (${p.timeZone})`, end),
    problem,
    h(
      'p',
      { class: 'prov' },
      'Saved to this drive first. It reaches Clockify only when you send it from “Changes to send”.',
    ),
  );
  body.addEventListener('submit', event => {
    event.preventDefault();
    save();
  });

  return {
    body,
    footer: [
      button(h, 'Save', { key: 'edit-save', onClick: save }),
      button(h, 'Cancel', {
        variant: 'ghost',
        key: 'edit-cancel',
        onClick: p.onCancel,
      }),
    ],
  };
}
