// @wc-ignore-file
/**
 * DOM-free state for the Money app: what `main.ts` renders, and the only
 * place that talks to the store. Tests drive it with `fakeStore.ts`.
 */
import {
  compare,
  formatOfText,
  isBlocked,
  problemOf,
  read,
  tooLarge,
  type FileInfo,
  type Preview,
  type Problem,
} from './check.js';
import {
  defaultPeriod,
  noFilters,
  WINDOW,
  type Filters,
  type Period,
} from './ledger.js';
import { adopt } from './adopt.js';
import { localToday } from './format.js';
import type { OwnSchema } from './own.js';
import {
  atomic,
  canAnnotate,
  classFields,
  readMany,
  readRows,
  readStatement,
  resolver,
  type StoredStatement,
  resolveFields,
  type Fields,
  type Txn,
} from './rows.js';
import type { ImporterRun, PluginStore } from './store.js';
import { writeImport, type WriteProgress } from './write.js';

export { localToday };

export type ViewState =
  | { kind: 'loading'; loaded: number; total?: number }
  | { kind: 'empty' }
  | { kind: 'populated'; count: number }
  | { kind: 'error'; message: string };

export type Tab = 'transactions' | 'imports' | 'sources';

export type NoteKey = 'category' | 'note';

export type StepStatus = 'done' | 'now' | 'todo';

/** The import sheet (DESIGN.md 6.2–6.5). */
export type ImportSheet =
  | {
      step: 'checking';
      file: FileInfo;
      /** Read file · Check balances · Compare with existing transactions. */
      lines: [StepStatus, StepStatus, StepStatus];
      counts?: { statements: number; entries: number };
    }
  | {
      step: 'preview';
      file: FileInfo;
      preview: Preview;
      tab: 'new' | 'already' | 'blocked';
      applying?: boolean;
      /** Rows written so far, when the app writes them itself. */
      progress?: WriteProgress;
      /** Why applying failed, when it did. */
      failure?: string;
    }
  | { step: 'error' | 'blocked'; file: FileInfo; problem: Problem };

/** A file handed to the app: its name, size, and a way to read it as text. */
export interface ChosenFile {
  name: string;
  size: number;
  text(): Promise<string>;
}

/**
 * Applies a checked statement. On the importer's table: through the importer,
 * with the host's own review (`store.importer.run`, atomic-server#1774); an
 * older host has none, and the preview then says where to import instead. On
 * a table of the shared class: the app's own writes (`write.ts`). Tests pass
 * a fake.
 */
export interface ImportPort {
  apply(
    text: string,
    file: FileInfo,
    preview: Preview,
    onProgress?: (progress: WriteProgress) => void,
  ): Promise<ImporterRun>;
}

/**
 * Whose table the app shows: the Bank statements importer's (its drive-local
 * class, imports through the importer), the app's own table of the shared
 * class (an install from the catalog; the app imports and edits it itself),
 * or another table of the shared class the app is a view of (imports and
 * edits after "Allow editing").
 */
export type Source = 'importer' | 'own' | 'shared';

/** The host's importer, when it has one, as an ImportPort. */
export function hostImporter(store: PluginStore): ImportPort | undefined {
  const importer = store.importer;
  if (!importer) return undefined;

  return {
    apply: (text, file) =>
      importer.run({
        file: {
          name: file.name,
          mediaType:
            file.format === 'camt053' ? 'application/xml' : 'text/plain',
          text,
        },
      }),
  };
}

/** A save of one annotation field, kept until the row is closed. */
export interface Edit {
  value: string;
  /** `asking`: waiting for the person to allow editing in the host's bar. */
  status: 'asking' | 'saving' | 'saved' | 'error';
  /** For `error`: one sentence of cause, and the host's raw message. */
  message?: string;
  details?: string;
}

export interface State {
  view: ViewState;
  tab: Tab;
  /** The complete rows: everything the ledger sums, filters and compares. */
  rows: Txn[];
  /**
   * Rows of the class missing a required field (`Txn.incomplete`; #177,
   * ontology-kit's rule: shown as incomplete, never skipped). Kept apart
   * from `rows`, so no balance, total, account list, statement or import
   * check ever counts one.
   */
  incomplete: Txn[];
  /** Whether the host can show a row's page (`store.openResource`). */
  canOpenRows: boolean;
  fields: Fields;
  filters: Filters;
  /** How many of the filtered rows the ledger renders. */
  limit: number;
  /** Subject of the row whose detail is open. */
  selected?: string;
  /** Rows that arrived through the table subscription since the last load. */
  arrived?: { count: number };
  /** Saves of the open row's annotations, by field. */
  edits: Partial<Record<NoteKey, Edit>>;
  /** What is typed but not yet saved, by field; kept across re-renders. */
  drafts: Partial<Record<NoteKey, string>>;
  importing?: ImportSheet;
  /** Whether the host can apply an import from the app (M-8). */
  canApply: boolean;
  /** The keyboard shortcuts popover (`?`). */
  help?: boolean;
  /**
   * The importer that owns the table (the table's parent), when the host
   * can open it for the person (`store.openResource`).
   */
  importer?: string;
  /** Why opening the importer failed, when it did. */
  openFailure?: string;
  /**
   * The importer's stored statements (atomic-server#1768), or undefined
   * where the table has none: then the Imports tab is built from the rows.
   */
  statements?: StoredStatement[];
  /**
   * Whether this app may edit the viewed table's rows (atomic-server#1788):
   * `unknown` on a host that cannot say.
   */
  rowAccess: 'granted' | 'none' | 'denied' | 'unavailable' | 'unknown';
  /** Why the person or host refused editing, when they did. */
  rowAccessReason?: string;
  /** Whose table this is; `undefined` until loaded. */
  source?: Source;
}

export const NOT_A_BANK_TABLE =
  'This app shows a Bank transactions table: the one the Bank statements importer created, or a table of the shared Bank transaction class (bank-transaction-v1), such as the one this app got when it was installed. Open it from the app tab of such a table.';

export interface Controller {
  state(): State;
  load(): Promise<void>;
  setTab(tab: Tab): void;
  setFilters(patch: Partial<Filters>): void;
  clearFilters(): void;
  showMore(): void;
  select(subject: string | undefined): void;
  /** Remembers typed text without re-rendering. */
  draft(field: NoteKey, value: string): void;
  /** Saves one annotation of the open row (on blur); no-op when unchanged. */
  saveNote(field: NoteKey, value: string): Promise<void>;
  /** Checks a statement file and shows the import sheet. */
  importFile(file: ChosenFile): Promise<void>;
  setPreviewTab(tab: 'new' | 'already' | 'blocked'): void;
  applyImport(): Promise<void>;
  /** Closes the import sheet; during a check, abandons it. */
  closeImport(): void;
  toggleHelp(open?: boolean): void;
  /** Asks the person, in the host's bar, to allow editing the rows. */
  allowEditing(): Promise<boolean>;
  /** Leaves the app for the importer's page, where Import applies (M-8). */
  openImporter(): Promise<void>;
  /** Leaves the app for a row's page in the host, to complete it there. */
  openRow(subject: string): Promise<void>;
  /** ISO date the period filters are relative to. */
  today(): string;
  dispose(): void;
}

export interface Options {
  /** ISO date of "today"; the harness and tests pin it. */
  today?: () => string;
  importer?: ImportPort;
  /** Yields between check steps so each line can render; tests may pin it. */
  tick?: () => Promise<void>;
}

export function createController(
  store: PluginStore,
  render: (state: State) => void,
  {
    today = localToday,
    importer,
    tick = () => new Promise(resolve => setTimeout(resolve, 0)),
  }: Options = {},
): Controller {
  let state: State = {
    view: { kind: 'loading', loaded: 0 },
    tab: 'transactions',
    rows: [],
    incomplete: [],
    canOpenRows: Boolean(store.openResource),
    fields: {},
    filters: noFilters({ kind: 'all' }),
    limit: WINDOW,
    edits: {},
    drafts: {},
    canApply: false,
    rowAccess: 'unknown',
  };
  /** Set by `load()`, once it knows whose table this is. */
  let port: ImportPort | undefined = importer;
  state.canApply = Boolean(port);
  let statementsTable: string | undefined;
  let statementFields: Fields = {};
  /** `money-table` on the app's own statement rows (`own.ts`). */
  let tableField: string | undefined;
  let own: OwnSchema | undefined;
  let unsubscribeStatements: (() => void) | undefined;
  /** Bumped on every new check or close, so a stale check stops. */
  let run = 0;
  let pendingText: string | undefined;
  let pendingPreview: Preview | undefined;
  let table: string | undefined;
  /** The table's row class: only children of it are rows. */
  let rowClass: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let refreshing: Promise<void> | undefined;
  let again = false;

  const update = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    render(state);
  };

  /** Populated while there is anything to list, incomplete rows included. */
  const settled = (rows: Txn[], incomplete: Txn[]): ViewState =>
    rows.length || incomplete.length
      ? { kind: 'populated', count: rows.length }
      : { kind: 'empty' };

  /** Complete rows apart from incomplete ones (`Txn.incomplete`). */
  const split = (all: Txn[]) => ({
    rows: all.filter(row => !row.incomplete),
    incomplete: all.filter(row => row.incomplete),
  });

  /**
   * Re-reads the table's children, fetching only rows not seen complete
   * before. The incomplete ones are read again each time (there are few):
   * the subscription says only that the table changed, and a row completed
   * in the host should move into the ledger without a reload. A complete
   * row edited elsewhere is still picked up only at the next load.
   */
  const refresh = async () => {
    if (!table || !rowClass) return;
    const subjects = await store.query({
      property: atomic.parent,
      value: table,
    });
    const known = new Set(state.rows.map(row => row.subject));
    const wereIncomplete = new Set(state.incomplete.map(row => row.subject));
    const fresh = subjects.filter(s => !known.has(s));
    const read = await readRows(store, fresh, state.fields, rowClass);
    const added = split(read);
    const present = new Set(subjects);
    const wasEmpty = state.rows.length === 0;
    const rows = [
      ...state.rows.filter(row => present.has(row.subject)),
      ...added.rows,
    ];
    const incomplete = added.incomplete;
    const arrived = read.filter(row => !wereIncomplete.has(row.subject)).length;
    update({
      rows,
      incomplete,
      view: settled(rows, incomplete),
      ...(arrived ? { arrived: { count: arrived } } : {}),
      // A first import into an empty table opens where its rows are.
      ...(wasEmpty && rows.length
        ? { filters: noFilters(defaultPeriod(rows, today())) }
        : {}),
    });
  };

  /**
   * True while the app writes rows itself: each write notifies the table, and
   * one refresh after the last of them reports the batch as "Imported N".
   */
  let writing = false;

  const queueRefresh = () => {
    if (writing) return;

    if (refreshing) {
      again = true;

      return;
    }

    refreshing = refresh()
      .catch(() => {
        // Keep what is shown; the next change notification retries.
      })
      .finally(() => {
        refreshing = undefined;

        if (again) {
          again = false;
          queueRefresh();
        }
      });
  };

  const loadStatements = async () => {
    if (!statementsTable) return;
    const subjects = await store.query({
      property: atomic.parent,
      value: statementsTable,
    });
    const statements = (
      await readMany(store, subjects, r =>
        readStatement(r, statementFields, tableField),
      )
    )
      // The app's own statements table serves every table it imports into.
      .filter(s => !tableField || s.table === table);
    update({ statements });
  };

  /**
   * The app's own import into a table of the shared class (`write.ts`). On
   * a table that is not the app's own, the person's "Allow editing" first.
   */
  const writePort = (fields: Fields, schema: OwnSchema): ImportPort => ({
    apply: async (_text, _file, preview, onProgress) => {
      if (state.source === 'shared' && state.rowAccess !== 'granted') {
        const granted = await askForAccess().catch(() => false);
        if (!granted)
          return {
            status: 'blocked',
            errors: [
              `You didn't allow Money to edit this table, so nothing was imported.${state.rowAccessReason ? ` (${state.rowAccessReason})` : ''}`,
            ],
          };
      }

      writing = true;

      try {
        return await writeImport(
          store,
          {
            table: table!,
            fields,
            own: schema,
            stored: new Set(
              (state.statements ?? []).map(s => s.sourceId).filter(Boolean),
            ),
          },
          preview,
          onProgress,
          { today },
        );
      } finally {
        writing = false;
      }
    },
  });

  const askForAccess = async (): Promise<boolean> => {
    if (!store.requestRowAccess) return false;
    const answer = await store.requestRowAccess();

    if (answer.status === 'granted') {
      update({ rowAccess: 'granted', rowAccessReason: undefined });

      return true;
    }

    update({ rowAccess: 'denied', rowAccessReason: answer.reason });

    return false;
  };

  const PROPERTY: Record<NoteKey, 'money-category' | 'money-note'> = {
    category: 'money-category',
    note: 'money-note',
  };

  const setEdit = (field: NoteKey, edit: Edit | undefined) =>
    update({ edits: { ...state.edits, [field]: edit } });

  const fail = (message: string) =>
    update({ view: { kind: 'error', message } });

  return {
    state: () => state,
    async load() {
      update({ view: { kind: 'loading', loaded: 0 } });

      try {
        // Offered on bank-transaction-v1 tables and the importer's, and its
        // own table one of the former (adopt.ts). Best effort: a refusal
        // leaves the app as installed.
        const found = await store.getData();
        const adopted = await adopt(store, found).catch(() => undefined);
        const data = adopted?.data ?? found;
        if (!data?.rowClass) return fail(NOT_A_BANK_TABLE);
        own = adopted?.own;
        const fields = await resolveFields(store, data.rowClass, own?.extras);
        if (!fields) return fail(NOT_A_BANK_TABLE);
        table = data.table;
        rowClass = data.rowClass;
        const source: Source = resolver.accepts(data.rowClass)
          ? adopted?.ownTable
            ? 'own'
            : 'shared'
          : 'importer';
        update({ source });

        if (source === 'importer') {
          port = importer ?? hostImporter(store);
          const owner = store.openResource
            ? await store
                .getResource(table)
                .then(r => r.get(atomic.parent))
                .catch(() => undefined)
            : undefined;
          if (typeof owner === 'string') update({ importer: owner });
        } else
          port =
            importer ??
            (own &&
            (source === 'own' || (store.rowAccess && store.requestRowAccess))
              ? writePort(fields, own)
              : undefined);

        update({ canApply: Boolean(port) });
        const subjects = await store.query({
          property: atomic.parent,
          value: table,
        });
        update({
          fields,
          view: { kind: 'loading', loaded: 0, total: subjects.length },
        });
        const statements = data.tables?.statements;

        if (source === 'importer' && statements) {
          statementsTable = statements.table;
          tableField = undefined;
          statementFields = await classFields(store, statements.rowClass);
        } else if (source !== 'importer' && own) {
          statementsTable = own.statementsTable;
          tableField = own.tableField;
          statementFields = own.statementFields;
        }

        if (statementsTable) {
          await loadStatements().catch(() => undefined);
          unsubscribeStatements?.();
          unsubscribeStatements = store.subscribe(statementsTable, () => {
            void loadStatements().catch(() => undefined);
          });
        }

        // The app's own table needs no grant: it is inside its own subtree.
        if (source === 'own') update({ rowAccess: 'granted' });
        else if (store.rowAccess) {
          const access = await store.rowAccess().catch(() => undefined);
          if (access) update({ rowAccess: access.status });
        }

        const { rows, incomplete } = split(
          await readRows(store, subjects, fields, rowClass, loaded => {
            // Progress in steps, not per row: each update re-renders.
            if (loaded % 50 === 0)
              update({
                view: { kind: 'loading', loaded, total: subjects.length },
              });
          }),
        );
        update({
          rows,
          incomplete,
          view: settled(rows, incomplete),
          filters: noFilters(defaultPeriod(rows, today())),
          limit: WINDOW,
          arrived: undefined,
        });
        unsubscribe?.();
        unsubscribe = store.subscribe(table, queueRefresh);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    setTab(tab) {
      update({ tab });
    },
    setFilters(patch) {
      update({
        filters: { ...state.filters, ...patch },
        limit: WINDOW,
        arrived: undefined,
      });
    },
    clearFilters() {
      const period: Period = { kind: 'all' };
      update({ filters: noFilters(period), limit: WINDOW });
    },
    showMore() {
      update({ limit: state.limit + WINDOW });
    },
    select(subject) {
      if (subject === state.selected) return;
      update({ selected: subject, edits: {}, drafts: {} });
    },
    draft(field, value) {
      state.drafts = { ...state.drafts, [field]: value };
    },
    async saveNote(field, value) {
      const subject = state.selected;
      const row = state.rows.find(r => r.subject === subject);
      const property = state.fields[PROPERTY[field]];
      if (!subject || !row || !property || !canAnnotate(state.fields)) return;
      const next = field === 'note' ? value : value.trim();
      const edit = state.edits[field];
      if (next === row[field] && edit?.status !== 'error') return;

      // A host that can grant editing the viewed table's rows: ask first,
      // in the host's bar, and keep what was typed meanwhile.
      if (store.rowAccess && state.rowAccess !== 'granted') {
        setEdit(field, { value: next, status: 'asking' });
        const granted = await askForAccess().catch(() => false);

        if (!granted) {
          if (state.selected === subject)
            setEdit(field, {
              value: next,
              status: 'error',
              message:
                "You didn't allow Money to edit this table, so it wasn't saved. Your text is kept here.",
              details: state.rowAccessReason,
            });

          return;
        }
      }

      setEdit(field, { value: next, status: 'saving' });

      try {
        const resource = await store.getResource(subject);
        if (next) resource.set(property, next);
        else resource.remove(property);
        await resource.save();
        // Written; the row now carries it, whether or not it is still open.
        const rows = state.rows.map(r =>
          r.subject === subject ? { ...r, [field]: next } : r,
        );

        if (state.selected === subject) {
          const drafts = { ...state.drafts };
          delete drafts[field];
          update({
            rows,
            drafts,
            edits: {
              ...state.edits,
              [field]: { value: next, status: 'saved' },
            },
          });
        } else update({ rows });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        if (state.selected === subject)
          setEdit(field, {
            value: next,
            status: 'error',
            message: saveFailure(details),
            details,
          });
      }
    },
    async importFile(file) {
      const mine = ++run;
      const info: FileInfo = { name: file.name, size: file.size };
      const stale = () => mine !== run;
      const stop = (problem: Problem) =>
        update({
          importing: {
            step: isBlocked(problem) ? 'blocked' : 'error',
            file: info,
            problem,
          },
        });
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['now', 'todo', 'todo'],
        },
      });
      const large = tooLarge(file.size);
      if (large) return stop(large);
      let text: string;

      try {
        text = await file.text();
      } catch (error) {
        if (!stale()) stop(problemOf(error));

        return;
      }

      if (stale()) return;
      info.format = formatOfText(text);
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['now', 'todo', 'todo'],
        },
      });
      await tick();
      if (stale()) return;
      // The readers parse and reconcile in one pass; the checklist shows the
      // two halves as the design's first two lines.
      const parsed = read(text);
      if (!parsed.ok) return stop(parsed.problem);
      const counts = {
        statements: parsed.statements.length,
        entries: parsed.statements.reduce(
          (n, s) => n + s.transactions.length,
          0,
        ),
      };
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['done', 'now', 'todo'],
          counts,
        },
      });
      await tick();
      if (stale()) return;
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['done', 'done', 'now'],
          counts,
        },
      });
      await tick();
      if (stale()) return;
      const checked = compare(parsed.format, parsed.statements, state.rows);
      if (!checked.ok) return stop(checked.problem);
      pendingText = text;
      pendingPreview = checked.preview;
      update({
        importing: {
          step: 'preview',
          file: info,
          preview: checked.preview,
          tab: checked.preview.fresh.length ? 'new' : 'already',
        },
      });
    },
    setPreviewTab(tab) {
      if (state.importing?.step === 'preview')
        update({ importing: { ...state.importing, tab } });
    },
    async applyImport() {
      const sheet = state.importing;
      if (sheet?.step !== 'preview' || !port || !pendingText || !pendingPreview)
        return;
      const mine = run;
      update({
        importing: {
          ...sheet,
          applying: true,
          progress: undefined,
          failure: undefined,
        },
      });

      try {
        const outcome = await port.apply(
          pendingText,
          sheet.file,
          pendingPreview,
          progress => {
            const current = state.importing;
            if (mine === run && current?.step === 'preview')
              update({ importing: { ...current, progress } });
          },
        );
        if (mine !== run) return;

        if (outcome.status === 'applied' || outcome.status === 'nothing') {
          pendingText = undefined;
          pendingPreview = undefined;
          // The new rows, and "Imported N", arrive through the table
          // subscription (`created` also counts the statement rows). Read
          // again now and shortly after as well: a subscription can miss
          // writes made while the host's socket reconnects.
          update({ importing: undefined });

          if (outcome.status === 'applied')
            for (const delay of [0, 1000, 4000])
              setTimeout(() => {
                queueRefresh();
                void loadStatements().catch(() => undefined);
              }, delay);
        } else if (outcome.status === 'cancelled')
          // Closed in the host's review: back to the preview, unchanged.
          update({ importing: { ...sheet, applying: false } });
        else
          update({
            importing: {
              ...sheet,
              applying: false,
              progress: undefined,
              failure:
                ('errors' in outcome ? outcome.errors?.join('\n') : '') ||
                'The importer blocked this file.',
            },
          });
      } catch (error) {
        if (mine === run)
          update({
            importing: {
              ...sheet,
              applying: false,
              progress: undefined,
              failure: error instanceof Error ? error.message : String(error),
            },
          });
        // Rows the app wrote before the failure are there; show them, so the
        // next check of the same file proposes only the rest.
        queueRefresh();
        void loadStatements().catch(() => undefined);
      }
    },
    closeImport() {
      run++;
      pendingText = undefined;
      pendingPreview = undefined;
      if (state.importing) update({ importing: undefined });
    },
    async openImporter() {
      if (!state.importer || !store.openResource) return;

      try {
        await store.openResource(state.importer);
      } catch (error) {
        update({
          openFailure: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async openRow(subject) {
      if (!store.openResource) return;

      try {
        await store.openResource(subject);
      } catch (error) {
        update({
          openFailure: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async allowEditing() {
      return askForAccess().catch(() => false);
    },
    toggleHelp(open = !state.help) {
      update({ help: open });
    },
    today,
    dispose() {
      unsubscribeStatements?.();
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** One sentence of cause for a failed annotation save. */
export function saveFailure(message: string): string {
  if (/only write its own data/i.test(message))
    return "This app isn't allowed to write to the importer's table yet. Your text is kept here.";
  if (/did not answer|timed? ?out|network/i.test(message))
    return "Your server didn't respond.";

  return 'Your server refused the change.';
}
