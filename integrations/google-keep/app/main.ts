// @wc-ignore-file
/**
 * The Google Keep drive-app entry point: two-way sync between the
 * connected Keep account and the app's table, every minute while the view
 * is open. The host's shell does `await plugin.view({ root, store })`. One
 * module, one `<style>`, no network access of its own: every call goes
 * through the host's proxy client. Plain DOM: a heading, the shared
 * sync-status card, the connect and sync buttons, the notes with their
 * presence and anything held back (a conflict offers both versions), and
 * the notes deleted here that are still in Keep, with "Bring back" and
 * "Delete in Keep" (which asks first: Keep's delete is permanent), and the
 * settings: whether edits are sent to Keep (off until turned on, which asks
 * first) and the one note title to sync, if any.
 */
import { renderSyncStatus, syncStatusCss } from '../../sync-status/card.js';
import {
  createController,
  DEFAULT_SETTINGS,
  describe,
  type ViewState,
} from './controller.js';
import { modeFor, syncStatusFor } from './status.js';
import type { ViewArgs } from './store.js';
import { CONFLICT, type NoteRow } from './sync.js';

const COLUMNS: [string, (n: NoteRow) => string][] = [
  ['Note', n => n.title],
  ['Kind', n => n.kind],
  ['In Keep', n => (n.presence === 'local' ? 'not yet' : n.presence)],
  [
    'Held back',
    n => (n.hold === CONFLICT ? 'changed on both sides' : (n.hold ?? '')),
  ],
];

const css = `.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.ss{margin:0 0 .75rem}th,td{padding:.25rem .75rem .25rem 0;vertical-align:top;text-align:left}.scroll{overflow-x:auto;max-width:100%}td button{white-space:nowrap}\n${syncStatusCss}`;

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;

    return node;
  };

  const button = (label: string, onClick: () => void, aria?: string) => {
    const b = el('button', label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);

    return b;
  };

  let card: HTMLElement = el('section');
  const status = el('p');
  status.setAttribute('role', 'status');
  status.className = 'sr';
  const connect = button(
    'Connect Google Keep',
    () => void controller.connect(),
  );
  const sync = button('Sync now', () => void controller.sync());
  const controls = el('p');
  controls.append(connect, ' ', sync);
  const table = el('table');
  const head = el('tr');
  for (const [label] of COLUMNS) head.append(el('th', label));
  head.append(el('th', ''));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  table.append(thead, body);
  table.setAttribute('aria-label', 'Notes');
  table.style.borderCollapse = 'collapse';
  // Narrow screens scroll the table sideways instead of clipping it.
  const scroll = el('div');
  scroll.className = 'scroll';
  scroll.append(table);
  // Settings: off and every note until the person changes them.
  const settings = el('fieldset');
  settings.append(el('legend', 'Settings'));
  const writeBack = el('input');
  writeBack.type = 'checkbox';
  writeBack.id = 'keep-write-back';
  const writeLabel = el('label', ' Send edits to Google Keep');
  writeLabel.htmlFor = writeBack.id;
  writeLabel.prepend(writeBack);
  const onlyTitle = el('input');
  onlyTitle.type = 'text';
  onlyTitle.id = 'keep-only-title';
  onlyTitle.placeholder = 'Every note';
  const onlyLabel = el('label', 'Only the note titled ');
  onlyLabel.htmlFor = onlyTitle.id;
  let dirty = false;
  for (const input of [writeBack, onlyTitle])
    input.addEventListener('input', () => (dirty = true));
  const save = button('Save settings', () => {
    const state = controller.state();
    const was = 'settings' in state && state.settings.writeBack;

    // Turning sending on can replace notes in Keep: ask first.
    if (
      writeBack.checked &&
      !was &&
      !doc.defaultView?.confirm(
        'Send edits made here to Google Keep? An edited note is sent as a new note and the old one deleted (the Keep API has no update), so its colour, labels, pin and reminders are lost. Shared notes and notes with images are never replaced.',
      )
    )
      return;
    dirty = false;
    void controller.configure({
      writeBack: writeBack.checked,
      onlyTitle: onlyTitle.value,
    });
  });
  const writeLine = el('p');
  writeLine.append(writeLabel);
  const onlyLine = el('p');
  onlyLine.append(onlyLabel, onlyTitle);
  const saveLine = el('p');
  saveLine.append(save);
  settings.append(writeLine, onlyLine, saveLine);
  const removed = el('section');
  removed.setAttribute('aria-label', 'Deleted here, still in Google Keep');
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(
    el('style', css),
    el('h1', 'Google Keep'),
    card,
    controls,
    status,
    settings,
    scroll,
    removed,
  );

  const render = (state: ViewState) => {
    const mapped = syncStatusFor({ state });
    const next = mapped
      ? renderSyncStatus(doc, mapped, { now: Date.now() })
      : el('p', describe(state));
    const mode = next.querySelector('.ss-mode');
    if (mode) mode.textContent = modeFor(state);
    card.replaceWith(next);
    card = next;
    status.textContent = describe(state);
    connect.hidden = !(
      state.kind === 'disconnected' ||
      (state.kind === 'error' && !state.connection)
    );
    sync.hidden = !('connection' in state && state.connection);
    sync.disabled = state.kind === 'syncing';

    settings.hidden = !('settings' in state);
    if ('settings' in state && !dirty) {
      writeBack.checked = state.settings.writeBack;
      onlyTitle.value = state.settings.onlyTitle;
    }
    save.disabled = state.kind === 'syncing';
    const sending = 'settings' in state && state.settings.writeBack;

    const notes = 'notes' in state ? state.notes : [];
    table.hidden = notes.length === 0;
    body.replaceChildren(
      ...notes.map(note => {
        const row = el('tr');
        row.dataset.subject = note.subject;
        row.dataset.presence = note.presence;
        if (note.noteId) row.dataset.note = note.noteId;
        if (note.hold)
          row.dataset.hold = note.hold === CONFLICT ? CONFLICT : 'blocked';
        for (const [, cell] of COLUMNS) row.append(el('td', cell(note)));
        const actions = el('td');

        if (note.hold === CONFLICT) {
          actions.append(
            button(
              'Keep mine',
              () => void controller.resolve(note.subject, 'mine'),
              `Keep this table's version of ${note.title}`,
            ),
            ' ',
            button(
              'Take Keep’s',
              () => void controller.resolve(note.subject, 'theirs'),
              `Take Google Keep's version of ${note.title}`,
            ),
          );
        } else if (store.openResource) {
          actions.append(
            button(
              'Open row',
              () =>
                void store.openResource!(note.subject).catch(() => undefined),
              `Open row ${note.title}`,
            ),
          );
        }

        row.append(actions);

        return row;
      }),
    );

    const gone = 'removedHere' in state ? state.removedHere : [];
    removed.hidden = gone.length === 0;
    removed.replaceChildren(
      el('h2', 'Deleted here, still in Google Keep'),
      ...gone.map(note => {
        const p = el('p', `${note.title} `);
        p.dataset.note = note.id;
        p.append(
          button(
            'Bring back',
            () => void controller.restore(note.id),
            `Bring back ${note.title}`,
          ),
        );
        // Only while sending to Keep is on.
        if (sending)
          p.append(
            ' ',
            button(
              'Delete in Keep',
              () => {
                // Keep's delete is permanent: ask, every time.
                if (
                  doc.defaultView?.confirm(
                    `Delete “${note.title}” in Google Keep for good? This cannot be undone.`,
                  )
                )
                  void controller.deleteInKeep(note.id);
              },
              `Delete ${note.title} in Google Keep`,
            ),
          );

        return p;
      }),
    );
  };

  const controller = createController(store, render);
  render(controller.state());

  await controller.load().catch((error: unknown) => {
    const current = controller.state();
    render({
      kind: 'error',
      message: `Could not load: ${error instanceof Error ? error.message : String(error)}`,
      at: Date.now(),
      notes: 'notes' in current ? current.notes : [],
      removedHere: 'removedHere' in current ? current.removedHere : [],
      settings: 'settings' in current ? current.settings : DEFAULT_SETTINGS,
    });
  });
}
