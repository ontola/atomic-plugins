// @wc-ignore-file
/**
 * The Todoist drive-app entry point (read-only active tasks, #99's host
 * journey). The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`,
 * so this module exports `view` and does not render on import. One module,
 * no stylesheet, no network access of its own: every call goes through the
 * host's proxy client. Plain DOM, no framework: a heading, a status line,
 * the connect and sync buttons, and the table's tasks with their presence.
 */
import { createController, describe, type ViewState } from './controller.js';
import type { ViewArgs } from './store.js';
import type { TaskRow } from './sync.js';

const COLUMNS: [string, (t: TaskRow) => string][] = [
  ['Task', t => t.name],
  ['Status', t => (t.done ? 'Done' : 'Todo')],
  ['Presence', t => t.presence],
  ['Due', t => t.dueDay ?? ''],
  ['Priority', t => t.priority ?? ''],
  ['Project', t => t.project ?? ''],
  ['Last seen', t => t.lastSeen ?? ''],
];

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;

    return node;
  };

  const heading = el('h1', 'Todoist');
  const status = el('p');
  status.setAttribute('role', 'status');
  const connect = el('button', 'Connect Todoist');
  const sync = el('button', 'Sync now');
  for (const button of [connect, sync]) button.type = 'button';
  const note = el(
    'p',
    'Read-only: closing or editing a task here is not sent to Todoist. A task that stops appearing is checked by id and shown as completed only when Todoist says so.',
  );
  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  for (const [label] of COLUMNS) headRow.append(el('th', label));
  head.append(headRow);
  const body = el('tbody');
  table.append(head, body);
  table.setAttribute('aria-label', 'Imported tasks');
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  table.style.borderCollapse = 'collapse';
  table.style.marginTop = '1rem';
  root.replaceChildren(heading, status, connect, sync, note, table);

  const render = (state: ViewState) => {
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
    const tasks = 'tasks' in state ? state.tasks : [];
    table.hidden = tasks.length === 0;
    body.replaceChildren(
      ...tasks.map(task => {
        const row = el('tr');
        row.dataset.task = task.taskId;
        row.dataset.subject = task.subject;
        row.dataset.presence = task.presence;

        for (const [, cell] of COLUMNS) {
          const td = el('td', cell(task));
          td.style.padding = '0.25rem 0.75rem 0.25rem 0';
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

  await controller.load().catch((error: unknown) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
