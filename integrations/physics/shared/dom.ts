// @wc-ignore-file
/** Small DOM helpers: elements, SVG, and the few form controls the three apps share. */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Attr = string | number | boolean | null | undefined;
export type Attrs = Record<string, Attr | ((event: Event) => void)>;

function apply(el: Element, attrs: Attrs): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(name.slice(2), value);
    else if (value === true) el.setAttribute(name, '');
    else if (value !== false && value !== null && value !== undefined)
      el.setAttribute(name, String(value));
  }
}

/** An HTML element with attributes (`onclick` style names add listeners) and children. */
export function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  apply(el, attrs);
  el.append(...kids);

  return el;
}

/** An SVG element, same conventions. */
export function snode<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...kids: (Node | string)[]
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  el.append(...kids);

  return el;
}

/** Sets several attributes at once; `null` or `undefined` removes one. */
export function setAttrs(el: Element, attrs: Record<string, Attr>): void {
  for (const [name, value] of Object.entries(attrs))
    if (value === null || value === undefined || value === false)
      el.removeAttribute(name);
    else el.setAttribute(name, value === true ? '' : String(value));
}

/** Rounds for use in path data: one decimal is under a tenth of a pixel. */
export const r1 = (x: number) => Math.round(x * 10) / 10;

let counter = 0;

/** A document-unique id for label/input pairs. */
export const uid = (prefix: string) => `${prefix}-${(counter += 1)}`;

export interface Slider {
  el: HTMLElement;
  input: HTMLInputElement;
  /** Sets the value and the readout without firing `onInput`. */
  set(value: number): void;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** The readout, for example `2,5 cm`. */
  format: (value: number) => string;
  onInput: (value: number) => void;
}

/** A labelled range input with a live readout; the readout is also its `aria-valuetext`. */
export function slider(doc: Document, o: SliderOptions): Slider {
  const id = uid('ph-slider');
  const out = node(doc, 'output', { for: id, class: 'ph-readout' });
  const input = node(doc, 'input', {
    id,
    type: 'range',
    min: o.min,
    max: o.max,
    step: o.step,
    class: 'ph-range',
  });

  const show = (value: number) => {
    input.value = String(value);
    out.textContent = o.format(value);
    input.setAttribute('aria-valuetext', o.format(value));
  };

  show(o.value);
  input.addEventListener('input', () => {
    const value = Number(input.value);
    show(value);
    o.onInput(value);
  });

  return {
    el: node(
      doc,
      'div',
      { class: 'ph-field' },
      node(doc, 'label', { for: id }, o.label),
      out,
      input,
    ),
    input,
    set: show,
  };
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(value: T): void;
}

/** A group of radio buttons drawn as a segmented control. Arrow keys move between options natively. */
export function segmented<T extends string>(
  doc: Document,
  o: {
    label: string;
    options: { value: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
  },
): Segmented<T> {
  const name = uid('ph-seg');
  const inputs = o.options.map(option => {
    const input = node(doc, 'input', {
      type: 'radio',
      name,
      value: option.value,
      checked: option.value === o.value,
    });
    input.addEventListener('change', () => {
      if (input.checked) o.onChange(option.value);
    });

    return { option, input };
  });

  return {
    el: node(
      doc,
      'fieldset',
      { class: 'ph-seg' },
      node(doc, 'legend', {}, o.label),
      node(
        doc,
        'div',
        { class: 'ph-seg-row' },
        ...inputs.map(({ option, input }) =>
          node(
            doc,
            'label',
            { class: 'ph-seg-opt' },
            input,
            node(doc, 'span', {}, option.label),
          ),
        ),
      ),
    ),
    set(value) {
      for (const { option, input } of inputs)
        input.checked = option.value === value;
    },
  };
}

/** A labelled checkbox. */
export function checkbox(
  doc: Document,
  o: { label: string; checked: boolean; onChange: (checked: boolean) => void },
): { el: HTMLElement; input: HTMLInputElement } {
  const input = node(doc, 'input', { type: 'checkbox', checked: o.checked });
  input.addEventListener('change', () => o.onChange(input.checked));

  return {
    el: node(
      doc,
      'label',
      { class: 'ph-check' },
      input,
      node(doc, 'span', {}, o.label),
    ),
    input,
  };
}

/** A push button. */
export function button(
  doc: Document,
  label: string,
  onClick: () => void,
  className = 'ph-btn',
): HTMLButtonElement {
  const el = node(doc, 'button', { type: 'button', class: className }, label);
  el.addEventListener('click', onClick);

  return el;
}
