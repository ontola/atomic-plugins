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

/** Root padding and tree card padding in styles.css, in px. */
const PAD = 16;
const CARD_PAD = 9;

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

  let seen: string | undefined;

  const render = () => {
    const tree = root.querySelector<HTMLElement>('.lb-tree');
    const [left, top] = [tree?.scrollLeft ?? 0, tree?.scrollTop ?? 0];
    const focused = (doc.activeElement as HTMLElement | null)?.dataset?.id;
    // The tree card sits inside the root's padding and its own.
    const width = Math.max(0, root.clientWidth - 2 * PAD - 2 * CARD_PAD);
    // A ping redraws everything: keep what was typed in a link field.
    const typed = [...root.querySelectorAll<HTMLInputElement>('.lb-input')].map(
      i =>
        [
          i.getAttribute('aria-label'),
          i.value,
          i === doc.activeElement,
        ] as const,
    );
    root.replaceChildren(...page(doc, controller.state(), ui, actions, width));

    for (const [label, value, active] of typed)
      for (const i of root.querySelectorAll<HTMLInputElement>('.lb-input'))
        if (i.getAttribute('aria-label') === label) {
          i.value = value;
          if (active) i.focus({ preventScroll: true });
        }

    const again = root.querySelector<HTMLElement>('.lb-tree');

    if (again) {
      [again.scrollLeft, again.scrollTop] = [left, top];
      const overflows = again.scrollWidth > again.clientWidth + 1;
      again.parentElement?.toggleAttribute('data-scroll', overflows);
      const s = controller.state();
      const at = s.kind === 'ready' ? s.selected : undefined;

      // A skill picked from a chip may sit off screen: bring it into view.
      if (at && at !== seen && overflows) {
        const n = again.querySelector<HTMLElement>(
          `.lb-node[data-id="${CSS.escape(at)}"]`,
        );
        const [r, t] = [
          n?.getBoundingClientRect(),
          again.getBoundingClientRect(),
        ];
        if (r && (r.left < t.left || r.right > t.right))
          again.scrollLeft += r.left - t.left - (t.width - r.width) / 2;
      }

      seen = at;
    }

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
    link: (lesson, target) => void controller.linkLesson(lesson, target),
  };

  // The tree fits the width it is given, so draw again when the frame resizes.
  let frame = 0;
  let last = root.clientWidth;
  doc.defaultView?.addEventListener('resize', () => {
    if (root.clientWidth === last) return;
    last = root.clientWidth;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  });

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
