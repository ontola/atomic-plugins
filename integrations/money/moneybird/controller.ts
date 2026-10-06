// @wc-ignore-file
/**
 * The view's state machine. One open: adopt (own Properties, tables,
 * `renders`, `row-extras`), find where this view is (the app's own table, or
 * a table it is a view of and its binding), find the connection and the
 * settings, then sync the chosen collections once. Every collection is
 * synced on its own: one that fails is reported next to the ones that
 * succeeded, and its rows imported earlier are kept.
 */
import {
  bindTable,
  COLLECTION_LABELS,
  COLLECTIONS,
  ensureRowAccess,
  findHome,
  formatCollections,
  hasRowAccess,
  layout,
  parseCollections,
  unbindTable,
  type Collection,
  type Layout,
} from './binding.js';
import { WORK_PERSON, WORK_PROJECT } from './hours.js';
import { adopt, COLLECTIONS_TERM, ensureTables, type Adopted } from './own.js';
import { readAdministrations, type Administration } from './read.js';
import {
  ADMINISTRATION,
  PLATFORM,
  relayGet,
  syncContacts,
  syncHours,
  syncMutations,
  type SyncSummary,
} from './sync.js';
import type { ConnectionReference, PluginStore } from './store.js';

export type Results = Partial<
  Record<Collection, SyncSummary | { error: string }>
>;

export type ViewState =
  | { kind: 'loading' }
  /** The host has no proxy relay (atomic-server#1624 not in this build). */
  | { kind: 'no-relay' }
  /** A table the app is a view of, of a class it cannot sync into. */
  | { kind: 'unsupported'; message: string }
  /** A table the app is a view of, not synced: offer "Sync this table". */
  | {
      kind: 'unsynced';
      table: string;
      collection: Collection;
      message?: string;
    }
  /** Bound, but the grant lapsed: offer "Allow editing" again. */
  | { kind: 'paused'; table: string; collection: Collection }
  | { kind: 'disconnected'; table?: string }
  | { kind: 'connecting' }
  | {
      kind: 'choosing';
      connection: ConnectionReference;
      administrations: Administration[];
      /** Pre-selected collections. */
      collections: Collection[];
      /** False on a table the app is a view of: the collection is fixed. */
      selectable: boolean;
      table?: string;
    }
  | {
      kind: 'syncing';
      connection: ConnectionReference;
      administration: string;
      collections: Collection[];
    }
  | {
      kind: 'synced';
      connection: ConnectionReference;
      administration: string;
      collections: Collection[];
      at: Date;
      results: Results;
    }
  | {
      kind: 'error';
      message: string;
      connection?: ConnectionReference;
      administration?: string;
      collections?: Collection[];
    };

const NOUNS: Record<Collection, string> = {
  contacts: 'contacts',
  hours: 'time entries',
  mutations: 'mutations',
};

const labels = (collections: readonly Collection[]) =>
  collections.map(c => COLLECTION_LABELS[c].toLowerCase()).join(', ');

export function describeResult(
  collection: Collection,
  result: SyncSummary | { error: string },
): string {
  if ('error' in result)
    return `${NOUNS[collection]}: refresh failed: ${result.error} Rows imported earlier are kept.`;
  const skipped = result.skipped ? `, ${result.skipped} skipped` : '';

  return `${result.total} ${NOUNS[collection]} (${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged${skipped})`;
}

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-relay':
      return 'This host cannot reach the integration proxy for apps yet.';
    case 'unsupported':
      return state.message;
    case 'unsynced':
      return `Not synced with Moneybird. “${state.table}” can hold Moneybird ${COLLECTION_LABELS[state.collection].toLowerCase()}; “Sync this table to Moneybird” imports them here, read-only on the Moneybird side.${state.message ? ` ${state.message}` : ''}`;
    case 'paused':
      return `Syncing “${state.table}” with Moneybird is paused: this app may no longer edit its rows. Allow editing again to resume.`;
    case 'disconnected':
      return state.table
        ? `Not connected. Connect Moneybird to import into “${state.table}” (read-only).`
        : 'Not connected. Connect Moneybird to import your contacts, hours and financial mutations (read-only).';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'choosing':
      if (!state.administrations.length)
        return 'This Moneybird account has no administrations to import from.';

      return state.table
        ? `Choose the Moneybird administration to import ${labels(state.collections)} into “${state.table}” from.`
        : 'Choose the Moneybird administration and what to import.';
    case 'syncing':
      return `Importing ${labels(state.collections)}…`;

    case 'synced': {
      const parts = COLLECTIONS.filter(c => state.results[c]).map(c =>
        describeResult(c, state.results[c]!),
      );

      return `Last synced ${state.at.toLocaleTimeString()}: ${parts.join('; ')}.`;
    }

    case 'error':
      return `Refresh failed: ${state.message} Rows imported earlier are kept.`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Collections for an administration chosen by 0.1.x, before there was a choice. */
const LEGACY_COLLECTIONS: Collection[] = ['contacts'];

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
) {
  let state: ViewState = { kind: 'loading' };
  let where: Layout | undefined;
  let adopted: Adopted | undefined;
  /** The App (own table) or the table's binding: where the settings live. */
  let home: string | undefined;

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  const term = (shortname: string) => adopted!.properties.get(shortname)!;
  /** The table's name, on every table but the contacts one (the install's). */
  const tableName = () =>
    where && where.placement !== 'contacts' ? where.name : undefined;

  /** The one collection a shared-class table (a view, or the app's own) holds. */
  const fixed = (): Collection | undefined => where?.collection;

  const settings = async () => {
    const resource = await store.getResource(home!);
    const administration = resource.get(term(ADMINISTRATION.shortname));
    const chosen = fixed();
    const collections = chosen
      ? [chosen]
      : parseCollections(resource.get(term(COLLECTIONS_TERM.shortname)));

    return {
      administration:
        typeof administration === 'string' && administration
          ? administration
          : undefined,
      collections,
    };
  };

  const choose = async (connection: ConnectionReference) => {
    const administrations = await readAdministrations(
      relayGet(store.proxy!, connection),
    );
    const chosen = fixed();
    const stored = (await settings()).collections;
    set({
      kind: 'choosing',
      connection,
      administrations,
      collections: chosen
        ? [chosen]
        : stored.length
          ? stored
          : [...COLLECTIONS],
      selectable: !chosen,
      ...(tableName() ? { table: tableName()! } : {}),
    });
  };

  /** From "adopted and placed" on: the connection, the settings, then a sync. */
  const proceed = async (): Promise<{ syncing?: Promise<void> }> => {
    const proxy = store.proxy!;
    const [connection] = await proxy.connections({ platform: PLATFORM });

    if (!connection) {
      set({
        kind: 'disconnected',
        ...(tableName() ? { table: tableName()! } : {}),
      });

      return {};
    }

    try {
      const { administration, collections } = await settings();

      if (!administration) {
        await choose(connection);

        return {};
      }

      return {
        syncing: controller.sync(
          connection,
          administration,
          collections.length ? collections : LEGACY_COLLECTIONS,
        ),
      };
    } catch (error) {
      set({ kind: 'error', connection, message: message(error) });

      return {};
    }
  };

  const controller = {
    state: () => state,

    /**
     * Adopts, finds where this view is and its settings, then starts one
     * sync. Resolves once that is known, not when the sync ends.
     */
    async load(): Promise<{ syncing?: Promise<void> }> {
      if (!store.proxy) return (set({ kind: 'no-relay' }), {});

      try {
        where = await layout(store);
        adopted = await adopt(store);

        if (where.placement === 'other') {
          set({
            kind: 'unsupported',
            message:
              where.rowClass === WORK_PROJECT || where.rowClass === WORK_PERSON
                ? `“${where.name}” is this app’s own ${where.rowClass === WORK_PROJECT ? 'projects' : 'people'} table, filled from the hours it imports; open the app on its hours table or its contacts table instead.`
                : `“${where.name}” is not a table this app can sync: its rows are neither time entries (time-entry-v1) nor bank transactions (bank-transaction-v1).`,
          });

          return {};
        }

        if (where.placement === 'view') {
          const collection = where.collection!;
          home = await findHome(store, where, adopted);

          if (!home) {
            set({ kind: 'unsynced', table: where.name, collection });

            return {};
          }

          if (!(await hasRowAccess(store, where, adopted))) {
            set({ kind: 'paused', table: where.name, collection });

            return {};
          }
        } else {
          home = where.app;
        }
      } catch (error) {
        set({ kind: 'error', message: message(error) });

        return {};
      }

      return proceed();
    },

    /**
     * "Sync this table to Moneybird" (or "Allow editing" again): asks for
     * the host's grant, makes the binding, then goes on as on an open.
     */
    async syncTable(): Promise<void> {
      if (!where || !adopted || where.placement !== 'view') return;
      const collection = where.collection!;

      try {
        const answer = await ensureRowAccess(store, where, adopted);

        if (answer.status !== 'granted') {
          await unbindTable(store, where, adopted);
          set({
            kind: 'unsynced',
            table: where.name,
            collection,
            message: answer.reason,
          });

          return;
        }

        home = await bindTable(store, where, adopted);
      } catch (error) {
        set({ kind: 'error', message: message(error) });

        return;
      }

      await (
        await proceed()
      ).syncing;
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting' });

      try {
        // On consent the host navigates away and this view reloads; the
        // promise only settles when the person cancels.
        await proxy.connect({ platform: PLATFORM });
        set({
          kind: 'disconnected',
          ...(tableName() ? { table: tableName()! } : {}),
        });
      } catch (error) {
        set({ kind: 'error', message: message(error) });
      }
    },

    /** Stores the administration and collections on the home, then imports. */
    async select(
      administration: string,
      collections: readonly Collection[] = COLLECTIONS,
    ): Promise<void> {
      if (state.kind !== 'choosing' || !home) return;
      const { connection } = state;
      const chosen = fixed();
      const wanted = chosen
        ? [chosen]
        : COLLECTIONS.filter(c => collections.includes(c));

      if (!wanted.length)
        return set({
          kind: 'error',
          connection,
          message: 'Choose at least one collection to import.',
        });

      try {
        const resource = await store.getResource(home);
        resource.set(term(ADMINISTRATION.shortname), administration);
        if (!chosen)
          resource.set(
            term(COLLECTIONS_TERM.shortname),
            formatCollections(wanted),
          );
        await resource.save();
      } catch (error) {
        return set({ kind: 'error', connection, message: message(error) });
      }

      await this.sync(connection, administration, wanted);
    },

    async change(): Promise<void> {
      if (!('connection' in state) || !state.connection) return;
      const { connection } = state;

      try {
        await choose(connection);
      } catch (error) {
        set({ kind: 'error', connection, message: message(error) });
      }
    },

    async sync(
      connection = 'connection' in state ? state.connection : undefined,
      administration = 'administration' in state
        ? state.administration
        : undefined,
      collections = 'collections' in state && state.collections
        ? state.collections
        : undefined,
    ): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (
        !connection ||
        !administration ||
        !collections?.length ||
        !where ||
        !adopted ||
        state.kind === 'syncing'
      )
        return;
      const chosen = fixed();

      if (chosen && !(await hasRowAccess(store, where, adopted)))
        return set({ kind: 'paused', table: where.name, collection: chosen });

      set({ kind: 'syncing', connection, administration, collections });
      const get = relayGet(proxy, connection);
      const results: Results = {};

      // Only the own tables this view needs are made: the contacts table's
      // view makes the hours (plus projects and people) and mutations tables
      // it imports into; a view on a shared-class table makes only the
      // projects and people tables hours link to.
      for (const collection of collections) {
        try {
          if (collection === 'contacts') {
            if (where.placement !== 'contacts')
              throw new Error(
                'Contacts are imported from the app’s own contacts table.',
              );
            results.contacts = await syncContacts(store, get, administration);
          } else if (collection === 'hours') {
            const own = await ensureTables(
              store,
              where.app,
              chosen === 'hours'
                ? ['projects', 'people']
                : ['hours', 'projects', 'people'],
            );
            results.hours = await syncHours(store, get, administration, {
              hours: chosen === 'hours' ? where.table : own.hours!,
              projects: own.projects!,
              people: own.people!,
            });
          } else {
            const table =
              chosen === 'mutations'
                ? where.table
                : (await ensureTables(store, where.app, ['mutations']))
                    .mutations!;
            results.mutations = await syncMutations(
              store,
              get,
              administration,
              table,
            );
          }
        } catch (error) {
          results[collection] = { error: message(error) };
        }
      }

      set({
        kind: 'synced',
        connection,
        administration,
        collections,
        at: new Date(),
        results,
      });
    },
  };

  return controller;
}
