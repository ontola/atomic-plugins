// @wc-ignore-file
/**
 * The drive-app entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module exports
 * `view` and renders nothing on import. One module; its CSS is injected as
 * one `<style>` element, since the frame serves no stylesheet.
 */
import css from './styles.css?raw';
import { createController } from './controller.js';
import { stringsFor } from './strings.js';
import type { ViewArgs } from './store.js';
import { page, type Actions } from './view.js';

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;
  const ui = stringsFor(doc.defaultView?.navigator?.language);

  if (!doc.getElementById('lb-styles')) {
    const style = doc.createElement('style');
    style.id = 'lb-styles';
    style.textContent = css;
    doc.head.append(style);
  }

  root.classList.add('lb-app');

  const scheme = (theme?: { colorScheme?: string }) => {
    if (theme?.colorScheme) root.style.colorScheme = theme.colorScheme;
  };

  scheme(store.getTheme?.());
  store.onThemeChange?.(scheme);

  const render = () => {
    const tree = root.querySelector<HTMLElement>('.lb-tree');
    const [left, top] = [tree?.scrollLeft ?? 0, tree?.scrollTop ?? 0];
    const focused = (doc.activeElement as HTMLElement | null)?.dataset?.id;
    root.replaceChildren(...page(doc, controller.state(), ui, actions));
    const again = root.querySelector<HTMLElement>('.lb-tree');
    if (again) [again.scrollLeft, again.scrollTop] = [left, top];
    if (focused)
      root
        .querySelector<HTMLElement>(
          `.lb-node[data-id="${CSS.escape(focused)}"]`,
        )
        ?.focus({ preventScroll: true });
  };

  const controller = createController(store, render);
  const actions: Actions = {
    select: id => controller.select(id),
    setGoal: id => controller.setGoal(id),
    toggleMastery: id => void controller.toggleMastery(id),
    loadStarter: () => void controller.loadStarter(),
    reload: () => void controller.load(),
    open: lesson => {
      const target = lesson.content ?? lesson.subject;
      // A DID is a resource in the drive; any other URL is a link out.
      if (target.startsWith('did:')) void store.openResource?.(target);
      else if (/^https?:\/\//.test(target)) void store.openExternal?.(target);
    },
    openRow: id => void store.openResource?.(id),
  };

  render();
  await controller.load();

  // Someone else's edit, or this app's own, arrives as a ping: reload, debounced.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void controller.load(), 300);
  };

  const state = controller.state();

  if (state.kind === 'ready')
    for (const subject of new Set([
      state.tables.skills,
      state.tables.lessons,
      state.tables.mastery,
    ]))
      store.subscribe(subject, later);
}
