// @wc-ignore-file
/**
 * Entry point of the spring drive app. The host does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`,
 * so this module exports `view` and renders nothing on import.
 */
import css from './styles.css?raw';
import {
  mount,
  onResize,
  prefersReducedMotion,
  type ViewArgs,
} from '../shared/host.js';
import { stringsFor } from './strings.js';
import { createSpringApp } from './view.js';

export async function view(args: ViewArgs): Promise<void> {
  const host = mount(args, { id: 'spring', css });
  const ui = stringsFor(host.lang);
  const app = createSpringApp(
    host.doc,
    ui,
    host.lang,
    prefersReducedMotion(host.win),
  );
  host.root.replaceChildren(app.el);

  const fit = () => {
    const box = host.root.querySelector('.ph-spring-plot');
    const width = box ? box.getBoundingClientRect().width : 0;
    if (width) app.resize(width);
  };

  fit();
  onResize(host.win, host.root, fit);
}
