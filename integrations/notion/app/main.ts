// @wc-ignore-file
/**
 * The drive-plugin entry point. The host's shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module exports
 * `view` and renders nothing on import. One module: its stylesheet is
 * injected by `createApp` as one `<style>` element.
 *
 * On open it reads the rows already in the drive (to compare them with their
 * baselines, `changes.ts`), then syncs in the background when the last sync
 * is unknown or older than 15 minutes (DESIGN.md §7), and again on "Sync
 * now". What it renders is a sync-status view (#177 Q9): the rows are
 * browsed and edited in the host's table.
 */
import {
  createController,
  isConnected,
  type Controller,
} from './controller.js';
import type { ViewArgs } from './store.js';
import { createApp } from './view/app.js';

/** How long table changes made elsewhere settle before the rows are re-read. */
const REFRESH_DEBOUNCE_MS = 500;

export async function view({ root, store }: ViewArgs): Promise<void> {
  let controller: Controller | undefined;
  let table: string | undefined;
  const app = createApp(root, {
    sync: () => void controller?.sync(),
    connect: () => void controller?.connect(),
    // Host operations since atomic-server 007869464, each feature-detected.
    ...(store.openResource
      ? {
          openTable: () => {
            if (table) void store.openResource!(table);
          },
        }
      : {}),
    ...(store.proxy?.disconnect
      ? { disconnect: () => void controller?.disconnect?.() }
      : {}),
    send: () => void controller?.send(),
    discard: subject => void controller?.discard(subject),
    resolve: (subject, shortname, keep) =>
      void controller?.resolve(subject, shortname, keep),
  });
  if (store.getTheme) app.setColorScheme(store.getTheme().colorScheme);
  store.onThemeChange?.(({ colorScheme }) => app.setColorScheme(colorScheme));
  controller = createController(store, state => app.render(state));
  app.render(controller.state());

  try {
    const state = await controller.load();

    if (isConnected(state) && state.connectionId && controller.isStale())
      void controller.sync();

    const data = await store.getData();
    table = data?.table;

    if (data?.table) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      store.subscribe(data.table, () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => void controller?.refreshRows(),
          REFRESH_DEBOUNCE_MS,
        );
      });
    }
  } catch (error) {
    app.fatal(error instanceof Error ? error.message : String(error));
  }
}
