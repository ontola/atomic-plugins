// @wc-ignore-file
/**
 * Entry point of the lens drive app. The host does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`,
 * so this module exports `view` and renders nothing on import.
 */
import css from './styles.css?raw';
import { mount, onResize, type ViewArgs } from '../shared/host.js';
import { stringsFor } from './strings.js';
import { createLensApp } from './view.js';

export async function view(args: ViewArgs): Promise<void> {
  const host = mount(args, { id: 'lens', css });
  const ui = stringsFor(host.lang);
  const app = createLensApp(host.doc, ui, host.lang);
  host.root.replaceChildren(app.el);

  const fit = () => {
    const box = host.root.querySelector('.ph-scene');
    const width = box ? box.getBoundingClientRect().width - 2 : 0;
    if (width) app.resize(width);
  };

  fit();
  onResize(host.win, host.root, fit);
}
