// @wc-ignore-file
/**
 * The Notion app's view: a small sync-status view (#177 Q9). It renders a
 * controller `ViewState` into the frame: header (status pill, Sync now),
 * connection bar (databases, Sync details, menu), the state's banner, the
 * "Changes to send" strip with its review, and one status card. It owns only
 * the UI state those need (menu, details, review, the disconnect question)
 * and keeps focus, scroll and the one live region stable across re-renders.
 * The rows are browsed and edited in the host's own table and views.
 */
import { isConnected, isRunning, type ViewState } from '../controller.js';
import { byKey, h, icon } from '../ui/dom.js';
import { plural } from '../ui/format.js';
import { sprite } from '../ui/icons.js';
import {
  pillElement,
  renderConnbar,
  renderHeader,
  renderBanner,
  renderMenu,
  updatePill,
} from '../ui/shell.js';
import { PL_CSS } from '../ui/styles.js';
import { pill, sources as listSources, syncAction } from './model.js';
import {
  noDatabases,
  preConnection,
  renderDetails,
  renderImport,
  renderStatus,
  stateBanner,
  type UiState,
  type ViewContext,
} from './parts.js';
import { NT_CSS } from './styles.js';
import { renderChangesBar, renderReview } from './review.js';

export interface AppActions {
  sync(): void;
  connect(): void;
  /** Sends the reviewed changes to Notion. */
  send(): void;
  /** Puts a row's unsent edits back to what Notion has. */
  discard(subject: string): void;
  /** Resolves a field changed both here and in Notion. */
  resolve(subject: string, shortname: string, keep: 'mine' | 'notion'): void;
  /** Shows the app's data table in the host (`store.openResource`). */
  openTable?(): void;
  /** Stops this app using Notion (`store.proxy.disconnect`). */
  disconnect?(): void;
}

export interface AppOptions {
  now?: () => number;
  locale?: string;
}

export interface App {
  render(state?: ViewState): void;
  /** The host's light or dark setting (`store.getTheme`, `onThemeChange`). */
  setColorScheme(scheme: 'light' | 'dark'): void;
  /** Shows a load failure in place of the view. */
  fatal(message: string): void;
  ui(): Readonly<UiState>;
  destroy(): void;
}

export function createApp(
  root: HTMLElement,
  actions: AppActions,
  { now = Date.now, locale }: AppOptions = {},
): App {
  const doc = root.ownerDocument;
  const style = h(doc, 'style', { 'data-notion-app': '' }, PL_CSS + NT_CSS);
  (doc.head ?? root).appendChild(style);
  if (doc.body) doc.body.style.margin = '0';
  const app = h(doc, 'div', { class: 'pl-app' });
  root.replaceChildren(sprite(doc), app);

  const pillEl = pillElement(doc);
  const ui: UiState = { details: false, menu: false };
  let state: ViewState = { kind: 'loading' };
  let alertFor: ViewState | undefined;
  let focusAfter: string | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const update = (patch: Partial<UiState>) => {
    Object.assign(ui, patch);
    render();
  };

  // On click, not pointerdown: a re-render between pointerdown and click
  // would replace the button under the pointer and lose the click.
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const patch: Partial<UiState> = {};
    if (ui.menu && !target?.closest?.('.pl-menu-wrap')) patch.menu = false;
    if (
      ui.details &&
      !target?.closest?.(
        '.nt-details, [data-key="details-toggle"], .pl-menu-wrap',
      )
    )
      patch.details = false;
    if (Object.keys(patch).length) update(patch);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !(ui.menu || ui.details)) return;
    if (ui.details) focusAfter = 'details-toggle';
    else focusAfter = 'menu:More';
    update({ menu: false, details: false });
  };

  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKey);

  // "Synced 4 min ago" keeps up without a state change.
  const tick = setInterval(() => {
    if (state.kind === 'ready') render();
  }, 60_000);

  function scheduleRetry() {
    clearTimeout(retry);
    retry = undefined;
    if (state.kind !== 'rate-limited') return;
    retry = setTimeout(
      () => actions.sync(),
      Math.max(0, state.retryAt - now()),
    );
  }

  const review = {
    open: () => {
      focusAfter = 'review';
      update({ review: true, details: false });
    },
    close: () => {
      focusAfter = 'review-open';
      update({ review: false });
    },
    send: () => actions.send(),
    discard: (subject: string) => actions.discard(subject),
    resolve: (subject: string, shortname: string, keep: 'mine' | 'notion') =>
      actions.resolve(subject, shortname, keep),
  };

  function header(): HTMLElement {
    const sync = syncAction(state);

    return renderHeader(doc, {
      mark: 'N',
      name: 'Notion',
      pill: pillEl,
      ...(sync.shown
        ? {
            action: {
              label: 'Sync now',
              icon: 'sync',
              key: 'sync-now',
              disabled: !sync.enabled,
              onClick: actions.sync,
            },
          }
        : {}),
    });
  }

  function connbar(): HTMLElement | null {
    if (!isConnected(state)) return null;
    const databases =
      state.kind === 'importing' && state.progress.length
        ? state.progress.length
        : (state.last?.dataSources.length ?? listSources(state.rows).length);

    return renderConnbar(
      doc,
      [
        [
          h(doc, 'span', {
            class: 'pl-dot',
            'aria-hidden': 'true',
            style:
              state.kind === 'reauth'
                ? 'background:var(--pl-neg)'
                : state.kind === 'disconnected'
                  ? 'background:var(--pl-muted)'
                  : undefined,
          }),
          'Notion',
        ],
        plural(databases, 'database'),
        state.kind === 'reauth'
          ? 'Access revoked'
          : state.kind === 'disconnected'
            ? 'Not connected'
            : [icon(doc, 'sync', 'sm'), 'Edits sent after review'],
      ],
      [
        h(
          doc,
          'button',
          {
            type: 'button',
            class: 'pl-cb-btn pl-cb-hide-narrow',
            'aria-expanded': ui.details ? 'true' : 'false',
            disabled: !state.last,
            title: state.last ? undefined : 'Available after the first sync',
            'data-key': 'details-toggle',
            onclick: () => update({ details: !ui.details, menu: false }),
          },
          'Sync details',
          icon(doc, 'chev'),
        ),
        renderMenu(
          doc,
          'More',
          [
            {
              label: 'Sync details',
              icon: 'info',
              disabled: !state.last,
              onClick: () => update({ details: true }),
            },
            ...(state.connectionId
              ? [
                  {
                    label: 'Choose pages in Notion',
                    icon: 'ext',
                    onClick: actions.connect,
                  },
                ]
              : []),
            ...(actions.openTable
              ? [
                  {
                    label: 'Open data table',
                    icon: 'table',
                    onClick: actions.openTable,
                  },
                ]
              : []),
            ...(actions.disconnect && state.connectionId
              ? [
                  {
                    label: 'Disconnect Notion…',
                    icon: 'plug',
                    disabled: isRunning(state),
                    onClick: () => {
                      focusAfter = 'disconnect-cancel';
                      update({ confirmDisconnect: true });
                    },
                  },
                ]
              : []),
          ],
          ui.menu,
          menuOpen => update({ menu: menuOpen, details: false }),
        ),
      ],
    );
  }

  /** The status card, or what stands in for it before the first rows. */
  function content(ctx: ViewContext): HTMLElement {
    const s = ctx.state;
    if (
      s.kind === 'importing' ||
      (s.kind === 'ready' && !s.last && !s.rows.length)
    )
      return renderImport(ctx, s.kind === 'importing' ? s.progress : []);
    if (s.kind === 'no-databases' && !s.rows.length) return noDatabases(ctx);

    return renderStatus(ctx);
  }

  function render(next?: ViewState) {
    if (next && next !== state) {
      if (isRunning(state) && !isRunning(next) && next.kind !== 'ready')
        alertFor = next;
      state = next;
      scheduleRetry();
    }

    const active = doc.activeElement as HTMLElement | null;
    const focusKey =
      focusAfter ??
      active?.closest?.('[data-key]')?.getAttribute('data-key') ??
      undefined;
    focusAfter = undefined;
    const scrolls = new Map(
      [...app.querySelectorAll<HTMLElement>('[data-scroll-key]')].map(el => [
        el.getAttribute('data-scroll-key'),
        [el.scrollTop, el.scrollLeft] as const,
      ]),
    );

    updatePill(doc, pillEl, pill(state, now(), locale));
    const children: (Node | null)[] = [header()];

    if (!isConnected(state)) {
      children.push(preConnection(doc, state, actions.connect));
    } else {
      const ctx: ViewContext = {
        doc,
        now: now(),
        ...(locale ? { locale } : {}),
        state,
        sources: listSources(state.rows, state.last),
        alert: alertFor === state,
        update,
        sync: actions.sync,
        connect: actions.connect,
        ...(actions.openTable ? { openTable: actions.openTable } : {}),
      };
      children.push(
        connbar(),
        h(
          doc,
          'div',
          { class: 'nt-main' },
          ui.confirmDisconnect && actions.disconnect
            ? renderBanner(doc, {
                tone: 'warn',
                title: 'Disconnect Notion from this app?',
                text: `Syncing stops. The ${plural(state.rows.length, 'row')} already here stay${state.rows.length === 1 ? 's' : ''}. The Notion connection itself stays for other apps; connect again to resume.`,
                action: {
                  kind: 'danger',
                  label: 'Disconnect',
                  key: 'disconnect-confirm',
                  onClick: () => {
                    ui.confirmDisconnect = false;
                    actions.disconnect!();
                  },
                },
                secondary: {
                  kind: 'secondary',
                  label: 'Cancel',
                  key: 'disconnect-cancel',
                  onClick: () => update({ confirmDisconnect: false }),
                },
              })
            : // One banner at a time: the confirmation stands in for the state's.
              stateBanner(ctx),
          ui.details ? renderDetails(ctx) : null,
          renderChangesBar(doc, state, !!ui.review, review),
          h(
            doc,
            'div',
            { class: 'nt-content', 'data-scroll-key': 'content' },
            ui.review ? renderReview(doc, state, review) : content(ctx),
          ),
        ),
      );
    }

    app.replaceChildren(...children.filter((c): c is Node => !!c));

    for (const el of app.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      const saved = scrolls.get(el.getAttribute('data-scroll-key'));
      if (saved) [el.scrollTop, el.scrollLeft] = saved;
    }

    if (focusKey) {
      const el = app.querySelector<HTMLElement>(byKey(focusKey));
      if (el && el !== doc.activeElement) el.focus({ preventScroll: true });
    }
  }

  return {
    render,
    setColorScheme(scheme) {
      app.dataset.scheme = scheme;
    },
    fatal(message) {
      app.replaceChildren(
        renderHeader(doc, { mark: 'N', name: 'Notion' }),
        h(
          doc,
          'div',
          { class: 'pl-empty' },
          h(doc, 'h2', {}, 'The Notion app could not load'),
          h(doc, 'p', {}, message),
        ),
      );
    },
    ui: () => ui,
    destroy() {
      clearInterval(tick);
      clearTimeout(retry);
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKey);
      style.remove();
    },
  };
}
