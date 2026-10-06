// @wc-ignore-file
/**
 * The status view's regions, each a function of a `ViewContext`: the
 * databases block under the shared sync-status card (which databases the
 * table syncs with, when the last sync ran, Open table), sync details,
 * first-import progress, and the per-state banners and empty states.
 * `app.ts` owns the state and calls these on every render. The rows
 * themselves are browsed and edited in the host's table (#177 Q9), not here.
 */
import type { ConnectedState, ViewState } from '../controller.js';
import type { SyncProgress } from '../sync.js';
import { h, icon, type Child } from '../ui/dom.js';
import { clock, plural, when } from '../ui/format.js';
import { button, emptyGlyph, renderBanner, renderEmpty } from '../ui/shell.js';
import type { Source } from './model.js';

export interface UiState {
  /** The "Sync details" panel is open. */
  details: boolean;
  /** The "⋯" menu is open. */
  menu: boolean;
  /** Asking to confirm "Disconnect Notion". */
  confirmDisconnect?: boolean;
  /** The "Changes to send" review is open in place of the status card. */
  review?: boolean;
}

export interface ViewContext {
  doc: Document;
  now: number;
  locale?: string;
  state: ConnectedState;
  /** The databases the table syncs with, with their row counts. */
  sources: Source[];
  /** Whether a banner is the answer to an action (role=alert). */
  alert: boolean;
  update(patch: Partial<UiState>): void;
  sync(): void;
  connect(): void;
  /** Shows the app's table in the host; absent on a host without `openResource`. */
  openTable?: () => void;
}

/** Human names for Notion types the lens does not copy. */
export const TYPE_NAMES: Record<string, string> = {
  rich_text: 'text',
  phone_number: 'phone',
  multi_select: 'multi-select',
  created_time: 'created time',
  last_edited_time: 'last edited time',
  created_by: 'created by',
  last_edited_by: 'last edited by',
  unique_id: 'ID',
};

export const typeName = (type: string) =>
  TYPE_NAMES[type] ?? type.replaceAll('_', ' ');

// ---------------------------------------------------------------- databases

/**
 * The Notion block right below the shared sync-status card (`status.ts`,
 * Q-084): the databases the table syncs with and their row counts, when the
 * last sync ran and how long it took, where to browse and edit, and "Open
 * table". The row total, the last sync's outcome and its counts are the
 * card's. Before 0.5.0 this was the status view's one card (#177 Q9).
 */
export function renderDatabases(ctx: ViewContext): HTMLElement {
  const { doc, state } = ctx;
  const last = state.last;

  return h(
    doc,
    'section',
    { class: 'nt-summary', 'aria-label': 'Databases synced with this table' },
    h(doc, 'h2', {}, 'Databases synced with this table'),
    ctx.sources.length
      ? h(
          doc,
          'ul',
          { class: 'nt-s-dbs', 'aria-label': 'Databases' },
          ctx.sources.map(s =>
            h(
              doc,
              'li',
              {},
              icon(doc, 'db'),
              h(doc, 'b', {}, s.title),
              h(doc, 'span', { class: 'nt-s-count' }, plural(s.count, 'row')),
            ),
          ),
        )
      : h(
          doc,
          'p',
          { class: 'nt-muted' },
          state.kind === 'no-databases'
            ? 'Notion shares no database with Atomic any more.'
            : 'Known after the first sync.',
        ),
    // When and how long: the card says how long ago and what it did.
    last &&
      h(
        doc,
        'dl',
        { class: 'nt-s-facts' },
        h(doc, 'dt', {}, 'Last sync'),
        h(
          doc,
          'dd',
          { 'data-key': 'last-sync' },
          when(last.at, ctx.now, ctx.locale),
          ` · took ${Math.max(1, Math.round(last.durationMs / 1000))} s`,
        ),
      ),
    h(
      doc,
      'p',
      { class: 'nt-s-note' },
      icon(doc, 'info'),
      h(
        doc,
        'span',
        {},
        'Browse and edit the rows in the table. An edit waits under “Review changes” here until you send it to Notion; edits made in Notion arrive on the next sync.',
      ),
    ),
    ctx.openTable &&
      h(
        doc,
        'div',
        { class: 'nt-s-actions' },
        button(doc, {
          kind: 'secondary',
          icon: 'table',
          label: 'Open table',
          key: 'open-table',
          onClick: ctx.openTable,
        }),
      ),
  );
}

// ---------------------------------------------------------------- details

export function renderDetails(ctx: ViewContext): HTMLElement | null {
  const { doc } = ctx;
  const last = ctx.state.last;
  if (!last) return null;
  const raw: string[] = [...last.general];

  const items = last.dataSources.map(d => {
    const skipped = d.properties.filter(p => !p.shortname);
    const byProperty = new Map<string, number>();
    for (const f of d.formatted)
      byProperty.set(f.property, (byProperty.get(f.property) ?? 0) + 1);
    for (const f of d.formatted)
      raw.push(
        `${d.title}: page ${f.page} (${f.title}) property "${f.property}" has formatting`,
      );
    for (const a of d.archived)
      raw.push(`${d.title}: page ${a} is archived or in trash`);
    raw.push(...d.errors.map(e => `${d.title}: ${e}`));
    const counts: Child[] = [
      h(doc, 'b', {}, d.pages),
      ` ${d.pages === 1 ? 'row' : 'rows'}`,
    ];
    if (d.created) counts.push(` · ${d.created} new`);
    if (d.updated) counts.push(` · ${d.updated} updated`);
    if (d.unchanged) counts.push(` · ${d.unchanged} unchanged`);

    return h(
      doc,
      'li',
      {},
      h(doc, 'p', { class: 'nt-d-name' }, icon(doc, 'db'), d.title),
      h(doc, 'p', { class: 'nt-d-counts' }, counts),
      skipped.length > 0 &&
        h(
          doc,
          'p',
          { class: 'nt-d-skip' },
          'Not copied: ',
          skipped.flatMap((p, i) => [
            i ? ', ' : '',
            h(doc, 'span', {}, p.name),
            ` ${typeName(p.type)}`,
          ]),
        ),
      [...byProperty].map(([property, n]) =>
        warning(doc, [
          `${plural(n, 'page')} ${n === 1 ? 'has' : 'have'} formatting in `,
          h(doc, 'b', {}, property),
          `, so ${property} was not copied for ${n === 1 ? 'it' : 'them'}.`,
        ]),
      ),
      d.archived.length > 0 &&
        warning(
          doc,
          `${plural(d.archived.length, 'page')} ${d.archived.length === 1 ? 'was' : 'were'} archived in Notion. ${d.archived.length === 1 ? 'Its row is' : 'Their rows are'} kept here.`,
        ),
      d.errors.map(e => warning(doc, e)),
    );
  });

  return h(
    doc,
    'div',
    {
      class: 'nt-details',
      role: 'dialog',
      'aria-label': 'Sync details',
      // Esc closes it and returns focus to its toggle (`app.ts`'s key handler).
      'data-key': 'details',
      tabindex: -1,
    },
    h(
      doc,
      'div',
      { class: 'nt-details-h' },
      h(doc, 'b', {}, 'Last sync'),
      h(
        doc,
        'span',
        {},
        `${when(last.at, ctx.now, ctx.locale)} · took ${Math.max(1, Math.round(last.durationMs / 1000))} s`,
      ),
    ),
    items.length
      ? h(doc, 'ul', { class: 'nt-details-dbs' }, items)
      : h(
          doc,
          'p',
          { class: 'nt-muted' },
          'Notion shared no databases in the last sync.',
        ),
    last.general.length > 0 &&
      h(
        doc,
        'div',
        { class: 'nt-details-general' },
        last.general.map(g => warning(doc, g)),
      ),
    raw.length > 0 &&
      h(
        doc,
        'details',
        { class: 'nt-tech' },
        h(doc, 'summary', {}, 'Technical details'),
        h(doc, 'pre', {}, raw.join('\n')),
      ),
  );
}

const warning = (doc: Document, text: Child | Child[]) =>
  h(
    doc,
    'p',
    { class: 'nt-d-warn' },
    icon(doc, 'alert', 'sm'),
    h(doc, 'span', {}, ...[text].flat()),
  );

// ---------------------------------------------------------------- first import

export function renderImport(
  ctx: ViewContext,
  progress: SyncProgress[],
): HTMLElement {
  const { doc } = ctx;
  const active = progress.findIndex(p => p.phase !== 'done');

  return h(
    doc,
    'div',
    { class: 'nt-import' },
    h(doc, 'h2', {}, 'Importing your first rows'),
    h(
      doc,
      'p',
      {},
      'This runs once in full; later syncs only update what changed. You can leave this page: the import stops, and starts again next time.',
    ),
    progress.length
      ? h(
          doc,
          'ul',
          { class: 'nt-progress', 'aria-label': 'Databases' },
          progress.map((p, i) => {
            const done = p.phase === 'done';
            const current = i === active;

            return h(
              doc,
              'li',
              { class: done ? 'is-done' : current ? 'is-active' : undefined },
              icon(doc, 'db'),
              h(doc, 'span', { class: 'nt-p-name' }, p.title),
              h(
                doc,
                'span',
                { class: 'nt-p-state' },
                done
                  ? [icon(doc, 'check', 'ok'), plural(p.pages, 'page')]
                  : current && p.phase !== 'listing'
                    ? [
                        h(
                          doc,
                          'span',
                          { class: 'pl-spin' },
                          icon(doc, 'sync', 'sm'),
                        ),
                        `${p.phase === 'writing' ? 'Saving…' : 'Reading…'} ${plural(p.pages, 'page')}`,
                      ]
                    : 'Waiting',
              ),
              current &&
                h(
                  doc,
                  'span',
                  { class: 'nt-bar is-indeterminate', 'aria-hidden': 'true' },
                  h(doc, 'span'),
                ),
            );
          }),
        )
      : h(
          doc,
          'p',
          { class: 'nt-muted' },
          'Asking Notion which databases it shares…',
        ),
  );
}

// ---------------------------------------------------------------- states

export function stateBanner(ctx: ViewContext): HTMLElement | null {
  const { doc, state } = ctx;
  const rows = state.rows.length;
  const kept = rows
    ? `Your ${plural(rows, 'row')} ${rows === 1 ? 'is' : 'are'} kept`
    : 'Nothing was imported yet';
  const lastGood = state.last
    ? ` Your rows are from the last good sync (${when(
        state.last.at,
        ctx.now,
        ctx.locale,
      )
        .replace(/^Today/, 'today')
        .replace(/^Yesterday/, 'yesterday')}).`
    : '';

  switch (state.kind) {
    case 'disconnected':
      return renderBanner(doc, {
        tone: 'warn',
        title: 'Notion is not connected to this app',
        text: `${kept}${rows ? ' but won’t update' : ''}. Connect Notion again to sync.`,
        action: {
          kind: 'secondary',
          label: 'Connect Notion',
          key: 'reconnect',
          onClick: ctx.connect,
        },
        alert: ctx.alert,
      });
    case 'reauth':
      return renderBanner(doc, {
        tone: 'neg',
        title: 'Notion no longer gives Atomic access',
        text: `Someone removed the connection in Notion, or it expired. ${kept}${rows ? '; they just won’t update.' : '.'}`,
        action: {
          kind: 'danger',
          label: 'Reconnect Notion',
          key: 'reconnect',
          onClick: ctx.connect,
        },
        ...(state.technical ? { technical: state.technical } : {}),
        alert: ctx.alert,
      });
    case 'rate-limited':
      return renderBanner(doc, {
        tone: 'warn',
        title: 'Notion asked Atomic to slow down',
        text: `The sync paused ${state.pagesRead ? `after ${plural(state.pagesRead, 'page')}` : 'before reading any pages'} and tries again at ${clock(state.retryAt, ctx.locale)}. Rows already here stay as they are.`,
        action: {
          kind: 'secondary',
          label: 'Try now',
          key: 'try-now',
          onClick: ctx.sync,
        },
        technical: state.technical,
        alert: ctx.alert,
      });
    case 'failed':
      return renderBanner(doc, {
        tone: 'neg',
        title: state.title,
        text: `${state.message}${lastGood}`,
        action: {
          kind: 'danger',
          label: 'Try again',
          key: 'try-again',
          onClick: ctx.sync,
        },
        technical: state.technical,
        alert: ctx.alert,
      });
    case 'no-databases':
      return rows
        ? renderBanner(doc, {
            tone: 'warn',
            title: 'Notion no longer shares any databases with Atomic',
            text: `${kept}. Share a database with the integration in Notion, then sync again.`,
            action: {
              kind: 'secondary',
              label: 'Choose pages in Notion',
              key: 'choose',
              onClick: ctx.connect,
            },
            alert: ctx.alert,
          })
        : null;
    default:
      return null;
  }
}

export function noDatabases(ctx: ViewContext): HTMLElement {
  const { doc } = ctx;

  return renderEmpty(doc, {
    glyph: emptyGlyph(doc, 'db'),
    title: 'Notion didn’t share any databases with Atomic',
    text: 'The connection works, but Atomic can only see what you share with it in Notion. Pages that aren’t in a database are not imported.',
    action: {
      label: 'Choose pages in Notion',
      key: 'choose',
      onClick: ctx.connect,
    },
    steps: [
      'Open the database in Notion.',
      [
        'Choose ',
        h(doc, 'b', {}, '•••'),
        ' in its top-right corner, then ',
        h(doc, 'b', {}, 'Connections'),
        '.',
      ],
      [
        'Pick the Atomic integration. Come back and choose ',
        h(doc, 'b', {}, 'Sync now'),
        '.',
      ],
    ],
  });
}

/** Empty states before a connection: S1, S2, S3 and loading. */
export function preConnection(
  doc: Document,
  state: Exclude<ViewState, ConnectedState>,
  connect: () => void,
): HTMLElement {
  const mark = h(
    doc,
    'span',
    { class: 'pl-mark is-lg', 'aria-hidden': 'true' },
    'N',
  );

  switch (state.kind) {
    case 'loading':
      return h(
        doc,
        'div',
        { class: 'pl-empty' },
        h(doc, 'p', { class: 'nt-muted' }, 'Loading…'),
      );
    case 'no-proxy':
      return renderEmpty(doc, {
        glyph: emptyGlyph(doc, 'plug'),
        title: 'This Atomic Server can’t connect apps to other services yet',
        text: 'The Notion app needs the server’s integration relay to read from Notion. Nothing was fetched and nothing was stored.',
        secondary:
          'Ask the person who runs this server to update it (the relay arrived in atomic-server PR #1657).',
      });
    case 'not-connected':
      return renderEmpty(doc, {
        glyph: mark,
        title: 'Bring your Notion databases into Atomic',
        text: 'Atomic keeps a copy of the pages in the Notion databases you choose, as rows in this app’s table, where you browse and edit them.',
        facts: [
          {
            icon: 'check',
            text: 'Every property of type text, number, checkbox, select, status, URL, email and phone is copied',
          },
          {
            icon: 'sync',
            text: 'Edits to those rows go back to Notion only after you review them here and press Send',
          },
          {
            icon: 'db',
            text: 'Notion asks you which pages and databases to share; only those are read',
          },
        ],
        action: { label: 'Connect Notion', key: 'connect', onClick: connect },
        secondary:
          'Your Notion sign-in stays with the integration relay. This app only ever sees the pages.',
      });
    case 'connecting':
      return renderEmpty(doc, {
        glyph: mark,
        title: 'Confirm in the bar above',
        text: 'Atomic asks first. Then Notion shows its own page, where you pick the pages and databases to share. You come back here afterwards.',
        action: {
          label: 'Waiting for confirmation…',
          key: 'connect',
          busy: true,
          onClick: () => {},
        },
        secondary: [
          'Changed your mind? Choose ',
          h(doc, 'b', {}, 'Cancel'),
          ' in the bar above.',
        ],
      });
  }
}
