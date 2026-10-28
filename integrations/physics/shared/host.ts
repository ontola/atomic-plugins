// @wc-ignore-file
/**
 * What the three apps share about being a drive app. The host's generated page
 * does `const plugin = await import(js_url); await plugin.view({ root, store })`
 * in a null-origin iframe (atomic-server `server/src/handlers/plugin_ui.rs`),
 * and sends the theme as CSS variables (`--t-color-*`) plus a colour scheme
 * (`store.getTheme()`, `store.onThemeChange()`; `view-client.js`). These apps
 * read and write nothing: they need only the theme from the store.
 */
import base from './base.css?raw';
import { langOf, type Lang } from './lang.js';

export type Scheme = 'light' | 'dark';

/** The part of the host's `store` these apps use. */
export interface ThemeStore {
  getTheme?(): { colorScheme?: Scheme };
  onThemeChange?(
    handler: (theme: { colorScheme?: Scheme }) => void,
  ): () => void;
}

export interface ViewArgs {
  root: HTMLElement;
  store: ThemeStore;
}

export interface Host {
  doc: Document;
  win: Window;
  root: HTMLElement;
  lang: Lang;
}

function addStyle(doc: Document, id: string, css: string): void {
  if (doc.getElementById(id)) return;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = css;
  doc.head.append(style);
}

/** Whether the person asked the system for less motion. */
export const prefersReducedMotion = (win: Window): boolean =>
  win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;

/**
 * Injects the styles, marks the root and follows the host's colour scheme.
 * Returns the document, window and language the app needs.
 */
export function mount(
  { root, store }: ViewArgs,
  app: { id: string; css: string },
): Host {
  const doc = root.ownerDocument;
  const win = doc.defaultView as Window;
  const lang = langOf(win?.navigator?.language);

  addStyle(doc, 'ph-base', base);
  addStyle(doc, `ph-${app.id}`, app.css);

  root.className = `ph-app ph-${app.id}`;
  root.lang = lang;

  const apply = (scheme?: Scheme) => {
    const known =
      scheme ??
      (win?.matchMedia?.('(prefers-color-scheme: dark)')?.matches
        ? 'dark'
        : 'light');
    root.dataset.scheme = known;
    root.style.colorScheme = known;
  };

  apply(store.getTheme?.()?.colorScheme);
  store.onThemeChange?.(theme => apply(theme.colorScheme));

  return { doc, win, root, lang };
}

/** Calls `fn` now and whenever the element's size changes (or the window's, without ResizeObserver). */
export function onResize(win: Window, el: Element, fn: () => void): void {
  const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver;
  if (Observer) new Observer(() => fn()).observe(el);
  else win.addEventListener('resize', fn);
}
