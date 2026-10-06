// @wc-ignore-file
/**
 * The Moneybird drive-app entry point (read-only contacts, hours and
 * financial mutations, atomic-plugins#102). The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`,
 * so this module exports `view` and does not render on import. One module,
 * one `<style>` element (the shared sync-status card's rules, embedded by
 * `build.mjs`), no network access of its own: every call goes through the
 * host's proxy relay.
 *
 * The shared sync-status card (Q-084, `../../sync-status/card.ts`) comes
 * first, under the heading, in every state but loading and an unsupported
 * table: when the last sync ran and what each collection did, that the app
 * is read-only and overwrites edits in the imported columns, the records it
 * skipped and why, and a wait for Moneybird's rate limit. The `role="status"`
 * line stays the one live region; while the card holds the same words
 * (syncing, synced) it is visually hidden, not removed.
 */
import { renderSyncStatus, syncStatusCss } from '../../sync-status/card.js';
import { COLLECTION_LABELS, COLLECTIONS, type Collection } from './binding.js';
import {
  createController,
  describe,
  type SyncHistory,
  type ViewState,
} from './controller.js';
import { syncStatusFor } from './status.js';
import type { ViewArgs } from './store.js';

/** Visually hidden, still read out: the status line while the card shows the same. */
const SR_ONLY =
  '.mb-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}';

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = doc.createElement(tag);
    node.textContent = text;

    return node;
  };

  const style = el('style', `${syncStatusCss}\n${SR_ONLY}`);
  const heading = el('h1', 'Moneybird');
  /** Holds the sync-status card, or nothing. */
  const card = el('div');
  const status = el('p');
  status.setAttribute('role', 'status');
  const connect = el('button', 'Connect Moneybird');
  const label = el('label', 'Administration ');
  const select = el('select');
  label.append(select);
  const what = el('fieldset');
  what.append(el('legend', 'What to import'));
  const boxes = new Map<Collection, HTMLInputElement>();

  for (const collection of COLLECTIONS) {
    const box = el('input');
    box.type = 'checkbox';
    box.value = collection;
    const option = el('label', ` ${COLLECTION_LABELS[collection]}`);
    option.prepend(box);
    option.style.display = 'block';
    what.append(option);
    boxes.set(collection, box);
  }

  const importButton = el('button', 'Import');
  const syncTable = el('button', 'Sync this table to Moneybird');
  const sync = el('button', 'Sync now');
  const change = el('button', 'Change settings');
  for (const button of [connect, importButton, syncTable, sync, change])
    button.type = 'button';
  const chooser = el('div');
  chooser.append(label, what, importButton);
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.padding = '1rem';
  root.replaceChildren(
    style,
    heading,
    card,
    status,
    connect,
    chooser,
    syncTable,
    sync,
    change,
  );

  const render = (state: ViewState, history: SyncHistory) => {
    const now = Date.now();
    const shown = syncStatusFor({ state, history, now });
    card.replaceChildren(
      ...(shown ? [renderSyncStatus(doc, shown, { now })] : []),
    );
    status.textContent = describe(state);
    status.classList.toggle(
      'mb-sr',
      state.kind === 'synced' || state.kind === 'syncing',
    );
    connect.hidden = !(
      state.kind === 'disconnected' ||
      (state.kind === 'error' && !state.connection)
    );
    chooser.hidden = state.kind !== 'choosing';

    if (state.kind === 'choosing') {
      select.replaceChildren(
        ...state.administrations.map(a => {
          const option = el('option', a.name);
          option.value = a.id;

          return option;
        }),
      );
      what.hidden = !state.selectable;
      for (const [collection, box] of boxes)
        box.checked = state.collections.includes(collection);
      importButton.disabled = state.administrations.length === 0;
    }

    syncTable.hidden = !(state.kind === 'unsynced' || state.kind === 'paused');
    syncTable.textContent =
      state.kind === 'paused'
        ? 'Allow editing again'
        : 'Sync this table to Moneybird';
    const known =
      state.kind === 'synced' ||
      state.kind === 'syncing' ||
      (state.kind === 'error' && !!state.administration);
    sync.hidden = !known;
    sync.disabled = state.kind === 'syncing';
    change.hidden = !known;
    change.disabled = state.kind === 'syncing';
  };

  const controller = createController(store, render);
  render(controller.state(), controller.history());
  connect.addEventListener('click', () => void controller.connect());
  importButton.addEventListener('click', () => {
    const chosen = [...boxes]
      .filter(([, box]) => box.checked)
      .map(([collection]) => collection);
    void controller.select(select.value, chosen);
  });
  syncTable.addEventListener('click', () => void controller.syncTable());
  sync.addEventListener('click', () => void controller.sync());
  change.addEventListener('click', () => void controller.change());

  await controller.load().catch((error: unknown) => {
    status.textContent = `Could not load: ${error instanceof Error ? error.message : String(error)}`;
  });
}
