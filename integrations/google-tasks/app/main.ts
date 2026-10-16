// @wc-ignore-file
/**
 * The Google Tasks drive-app entry point (read-only import of the task lists
 * a person ticks). The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`,
 * so this module exports `view` and does not render on import. One module,
 * one `<style>` (the shared sync-status card's rules and a visually hidden
 * class), no network access of its own: every call goes through the host's
 * proxy client. Plain DOM, no framework: a heading, the shared sync-status
 * card first (Q-084; `status.ts` maps the state onto it), the connect and
 * sync buttons, the task lists as checkboxes, a visually hidden
 * `role="status"` line, and the table's tasks with their presence. A row
 * missing the class's required Name is listed with "Incomplete: missing
 * Name" and, where the host can show a row, an "Open row" button (#177;
 * ontology-kit's rule: shown as incomplete, never skipped).
 */
import { renderSyncStatus, syncStatusCss } from '../../sync-status/card.js';
import { createController, describe, type ViewState } from './controller.js';
import { syncStatusFor } from './status.js';
import type { ViewArgs } from './store.js';
import type { TaskRow } from './sync.js';

const COLUMNS: [string, (t: TaskRow) => string][] = [
  ['Task', t => t.name || '(no name)'],
  ['Status', t => (t.done ? 'Done' : 'Todo')],
  ['Presence', t => t.presence],
  ['Due', t => t.dueDay ?? ''],
  ['List', t => t.list ?? ''],
  ['Parent task', t => t.parent ?? ''],
  ['Last seen', t => t.lastSeen ?? ''],
];

/** The app's own rules, then the shared card's (`.ss-*`). */
const css = `.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.ss{margin:0 0 .75rem}fieldset{margin:0 0 .75rem;padding:.5rem .75rem}fieldset label{display:block}\n${syncStatusCss}`;

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;

    return node;
  };

  const style = el('style', css);
  const heading = el('h1', 'Google Tasks');
  /** Replaced on every render: the card, or the plain notice where there is none. */
  let card: HTMLElement = el('section');
  const status = el('p');
  status.setAttribute('role', 'status');
  status.className = 'sr';
  const connect = el('button', 'Connect Google Tasks');
  const sync = el('button', 'Sync now');
  for (const button of [connect, sync]) button.type = 'button';
  const controls = el('p');
  controls.append(connect, ' ', sync);
  const lists = el('fieldset');
  lists.append(el('legend', 'Task lists to import'));
  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  for (const [label] of COLUMNS) headRow.append(el('th', label));
  const canOpen = typeof store.openResource === 'function';
  if (canOpen) headRow.append(el('th', 'Row'));
  head.append(headRow);
  const body = el('tbody');
  table.append(head, body);
  table.setAttribute('aria-label', 'Imported tasks');
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  table.style.borderCollapse = 'collapse';
  table.style.marginTop = '1rem';
  root.replaceChildren(style, heading, card, controls, lists, status, table);

  const openRow = (subject: string) =>
    void store.openResource!(subject).catch(() => undefined);

  const render = (state: ViewState) => {
    const mapped = syncStatusFor({
      state,
      ...(canOpen ? { onOpenRow: openRow } : {}),
    });
    // No card on another app's table (`status.ts`): the notice alone.
    const next = mapped
      ? renderSyncStatus(doc, mapped, { now: Date.now() })
      : el('p', describe(state));
    card.replaceWith(next);
    card = next;
    status.textContent = describe(state);
    connect.hidden = !(
      state.kind === 'disconnected' ||
      (state.kind === 'error' && !state.connection)
    );
    const known =
      state.kind === 'synced' ||
      state.kind === 'syncing' ||
      (state.kind === 'error' && !!state.connection);
    sync.hidden = !known;
    sync.disabled = state.kind === 'syncing';

    // The task lists Google named in the last read, each ticked when chosen.
    const entries = 'lists' in state ? state.lists : [];
    const chosen = 'chosen' in state ? state.chosen : [];
    lists.hidden = entries.length === 0;
    lists.disabled = state.kind !== 'synced' && state.kind !== 'error';
    lists.replaceChildren(
      el('legend', 'Task lists to import'),
      ...entries.map(entry => {
        const label = el('label');
        const box = el('input');
        box.type = 'checkbox';
        box.value = entry.id;
        box.checked = chosen.includes(entry.id);
        box.addEventListener('change', () => {
          const ids = [...lists.querySelectorAll('input:checked')].map(
            input => (input as HTMLInputElement).value,
          );
          void controller.chooseLists(ids);
        });
        label.append(box, ` ${entry.title || entry.id}`);

        return label;
      }),
    );

    const tasks = 'tasks' in state ? state.tasks : [];
    table.hidden = tasks.length === 0;
    body.replaceChildren(
      ...tasks.map(task => {
        const row = el('tr');
        if (task.taskId) row.dataset.task = task.taskId;
        else row.dataset.local = '';
        row.dataset.subject = task.subject;
        row.dataset.presence = task.presence;

        for (const [label, cell] of COLUMNS) {
          const td = el('td', cell(task));
          td.style.padding = '0.25rem 0.75rem 0.25rem 0';

          if (label === 'Task' && task.incomplete) {
            const tag = el('small', ` ${task.incomplete}`);
            tag.style.color = 'var(--t-warn, #a15c00)';
            tag.style.fontWeight = '650';
            td.append(tag);
          }

          row.append(td);
        }

        if (canOpen) {
          const td = el('td');
          td.style.padding = '0.25rem 0.75rem 0.25rem 0';
          const open = el('button', 'Open row');
          open.type = 'button';
          open.setAttribute(
            'aria-label',
            `Open row ${task.name || '(no name)'}`,
          );
          open.addEventListener('click', () => openRow(task.subject));
          td.append(open);
          row.append(td);
        }

        return row;
      }),
    );
  };

  const controller = createController(store, render);
  render(controller.state());
  connect.addEventListener('click', () => void controller.connect());
  sync.addEventListener('click', () => void controller.sync());

  // `load()` ends in an `error` state itself when the host fails it; this
  // is the last resort for anything it did not foresee, shown on the card
  // too, never only on the hidden status line.
  await controller.load().catch((error: unknown) => {
    const current = controller.state();
    render({
      kind: 'error',
      message: `Could not load: ${error instanceof Error ? error.message : String(error)}`,
      at: Date.now(),
      tasks: 'tasks' in current ? current.tasks : [],
      lists: 'lists' in current ? current.lists : [],
      chosen: 'chosen' in current ? current.chosen : [],
    });
  });
}
