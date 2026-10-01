// @wc-ignore-file
/**
 * Entry detail (#89 frame D), with Edit and Delete entry (#123 M3) when the
 * entry can be written back: an edit is saved to the row and listed under
 * "Changes to send". A drawer from the right at ≥ 720px,
 * a full-height sheet below. Focus goes to the heading, stays inside while
 * open, and Esc or Close hand it back to the row that opened it (the caller
 * restores focus by the row's `data-k`).
 */
import {
  dayKey,
  formatDay,
  formatDuration,
  formatTime,
  longWeekday,
  shortWeekday,
  spokenDuration,
} from '../model/time.js';
import type { TimeEntry } from '../model/types.js';
import { projectLabel } from '../model/views.js';
import { button, extLink } from './components.js';
import type { H } from './dom.js';
import { entryEditor, pendingTag, type EditorProps } from './edit.js';
import { dot } from './week.js';

export const CLOCKIFY_TRACKER = 'https://app.clockify.me/tracker';

/** What the drawer offers for writing back; absent: read-only. */
export interface DetailEdit {
  /** Why it cannot be edited; empty: Edit and Delete are offered. */
  blockers: string[];
  mode: 'view' | 'edit' | 'confirm-delete';
  editor: EditorProps;
  onEdit: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  /** Offered while the entry has a change not sent yet. */
  onDiscard: () => void;
}

export interface Overlay {
  node: HTMLElement;
  /** The element to focus once it is in the document. */
  focus: HTMLElement;
}

/** A modal sheet: scrim, dialog, Esc to close, Tab kept inside. */
export function sheet(
  h: H,
  p: {
    title: string;
    full: boolean;
    body: (HTMLElement | null)[];
    footer: (HTMLElement | null)[];
    onClose: () => void;
  },
): Overlay {
  const heading = h('h2', { id: 'sheet-h', tabindex: '-1' }, p.title);
  const close = button(h, 'Close', {
    variant: 'ghost',
    icon: 'x',
    iconOnly: true,
    onClick: p.onClose,
  });
  const dialog = h(
    'div',
    {
      class: `drawer${p.full ? ' full' : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'sheet-h',
    },
    h('header', null, heading, close),
    h('div', { class: 'body' }, ...p.body),
    p.footer.length ? h('footer', null, ...p.footer) : null,
  );
  const scrim = h('div', { class: 'scrim' });
  scrim.addEventListener('click', p.onClose);
  const node = h('div', null, scrim, dialog);

  node.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      p.onClose();

      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], select, input, [tabindex="0"]',
      ),
    ];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = h.doc.activeElement;

    if (event.shiftKey && (active === first || active === heading)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return { node, focus: heading };
}

export function entryDetail(
  h: H,
  entry: TimeEntry,
  p: {
    timeZone: string;
    full: boolean;
    lastChecked?: string | undefined;
    onClose: () => void;
    /** The host's `openExternal`, when it has one. */
    openExternal?: ((url: string) => void) | undefined;
    /** Shows the entry's table row in the host, when it can. */
    openRow?: (() => void) | undefined;
    edit?: DetailEdit | undefined;
  },
): Overlay {
  const edit = p.edit;
  const title = entry.description || '(no description)';

  if (edit?.mode === 'edit') {
    const form = entryEditor(h, entry, edit.editor);

    return sheet(h, {
      title: `Edit: ${title}`,
      full: p.full,
      onClose: edit.editor.onCancel,
      body: [form.body],
      footer: form.footer,
    });
  }

  const day = dayKey(entry.start, p.timeZone);
  const ms = entry.end - entry.start;
  const at = (t: number) =>
    `${formatDay(dayKey(t, p.timeZone), true)}, ${formatTime(t, p.timeZone)}`;
  const checked = p.lastChecked ? Date.parse(p.lastChecked) : NaN;
  const kv = (label: string, value: HTMLElement | string) => [
    h('dt', null, label),
    h('dd', null, value),
  ];

  const writable = !!edit && !edit.blockers.length;
  const confirming = edit?.mode === 'confirm-delete';
  const writeNote: HTMLElement | null = !edit
    ? null
    : edit.blockers.length
      ? h(
          'p',
          { class: 'muted', style: 'font-size: 12.5px; margin: 0' },
          `Not editable here: ${edit.blockers.join(' ')}`,
        )
      : null;

  return sheet(h, {
    title,
    full: p.full,
    onClose: p.onClose,
    body: [
      entry.pending
        ? h(
            'p',
            { style: 'margin: 0' },
            pendingTag(h, entry.pending),
            entry.pending === 'delete'
              ? ' Deleting it in Clockify is listed under “Changes to send”.'
              : ' Shown with your change, which is listed under “Changes to send”.',
          )
        : null,
      confirming && edit
        ? h(
            'div',
            { class: 'confirm', role: 'group', 'aria-label': 'Delete entry' },
            h(
              'p',
              null,
              'Delete this entry in Clockify? It is listed under “Changes to send” first, and deleted only when you send it.',
            ),
            h(
              'div',
              { class: 'row' },
              button(h, 'Delete in Clockify', {
                variant: 'danger',
                key: 'confirm-delete',
                onClick: edit.onConfirmDelete,
              }),
              button(h, 'Keep', {
                variant: 'ghost',
                key: 'cancel-delete',
                onClick: edit.onCancelDelete,
              }),
            ),
          )
        : null,
      h(
        'div',
        null,
        h(
          'div',
          { class: 'bigdur' },
          h('span', { 'aria-hidden': 'true' }, formatDuration(ms)),
          h('span', { class: 'sr' }, spokenDuration(ms)),
        ),
        h(
          'div',
          { class: 'muted', style: 'font-size: 12.5px; margin-top: 4px' },
          `${p.full ? shortWeekday(day) : longWeekday(day)} ${formatDay(day, !p.full)} · ${formatTime(entry.start, p.timeZone)} – ${formatTime(entry.end, p.timeZone)}`,
        ),
      ),
      h(
        'dl',
        { class: 'kv' },
        ...kv(
          'Project',
          h(
            'span',
            { class: 'proj', style: 'display: inline-flex' },
            dot(h, entry.project),
            projectLabel(entry.project),
          ),
        ),
        ...(entry.project?.client ? kv('Client', entry.project.client) : []),
        ...kv('Billable', entry.billable ? 'Yes' : 'No'),
        ...(entry.member ? kv('Member', entry.member) : []),
        ...kv('Start', h('span', { class: 'num' }, at(entry.start))),
        ...kv('End', h('span', { class: 'num' }, at(entry.end))),
      ),
      h(
        'div',
        { class: 'prov' },
        `Imported from Clockify${
          Number.isFinite(checked)
            ? `, last checked ${formatDay(dayKey(checked, p.timeZone))} ${formatTime(checked, p.timeZone)}`
            : ''
        }. ${
          edit
            ? 'Edits are saved in this drive and reach Clockify only when you send them. If Clockify changes the same field, Clockify’s value is kept.'
            : 'Changes made in Clockify replace this copy on the next sync.'
        }`,
      ),
      writeNote,
    ],
    footer: [
      writable && edit && !confirming && entry.pending !== 'delete'
        ? button(h, 'Edit', { key: 'edit', onClick: edit.onEdit })
        : null,
      writable && edit && !confirming && entry.pending !== 'delete'
        ? button(h, 'Delete entry…', {
            variant: 'danger',
            key: 'delete',
            onClick: edit.onDelete,
          })
        : null,
      edit && entry.pending
        ? button(h, 'Discard change', {
            variant: 'sec',
            key: 'discard',
            onClick: edit.onDiscard,
          })
        : null,
      p.openRow
        ? button(h, 'Open row in Atomic', {
            variant: 'sec',
            key: 'open-row',
            onClick: p.openRow,
          })
        : null,
      extLink(
        h,
        CLOCKIFY_TRACKER,
        'Open Clockify',
        'btn ghost',
        p.openExternal,
      ),
    ],
  });
}
