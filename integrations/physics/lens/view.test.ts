// @wc-ignore-file
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeStore,
  layOut,
  press,
  setLanguage,
  pointer,
  settle,
  text,
} from '../shared/testing.js';
import { view } from './main.js';

async function open(language = 'en-US', scheme?: 'light' | 'dark') {
  setLanguage(language);
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  document.head.replaceChildren();
  const store = fakeStore(scheme);
  await view({ root, store });
  await settle();

  return { root, store };
}

const handle = (root: HTMLElement, name: string) =>
  root.querySelector<SVGElement>(`[data-handle="${name}"]`)!;
const readout = (root: HTMLElement) => ({
  values: [...root.querySelectorAll('.ph-values dd')].map(text),
  formula: text(root.querySelector('[data-formula]')),
  verdict: text(root.querySelector('[data-verdict]')),
});
const slider = (root: HTMLElement, label: RegExp) =>
  [...root.querySelectorAll<HTMLInputElement>('input[type=range]')].find(i =>
    label.test(text(root.querySelector(`label[for="${i.id}"]`))),
  )!;

beforeEach(() => document.body.replaceChildren());
afterEach(() => setLanguage('en-US'));

describe('lens app', () => {
  it('renders a convex lens with the three rays, the image and the values for f = 6, v = 14', async () => {
    const { root } = await open();
    expect(root.classList.contains('ph-app')).toBe(true);
    expect(text(root.querySelector('h1'))).toBe('Lenses');
    expect(root.querySelectorAll('[data-rays] line').length).toBe(9);
    // v = 14, f = 6 -> b = 10.5, N = 0.75, real, inverted, reduced.
    expect(readout(root).values).toEqual([
      '14.0 cm',
      '10.5 cm',
      '6.0 cm',
      '0.75',
      '2.3 cm',
    ]);
    expect(readout(root).verdict).toBe(
      'The image is real, inverted and reduced (N = 0.75).',
    );
    expect(readout(root).formula).toBe(
      '1/f = 1/v + 1/b → 0.167 = 0.071 + 0.095 (per cm)',
    );
  });

  it('speaks Dutch with decimal commas for a Dutch browser, and uses no dash characters', async () => {
    const { root } = await open('nl-NL');
    expect(text(root.querySelector('h1'))).toBe('Lenzen');
    expect(readout(root).values[1]).toBe('10,5 cm');
    expect(readout(root).verdict).toBe(
      'Het beeld is reëel, omgekeerd en verkleind (N = 0,75).',
    );
    expect(text(root)).not.toMatch(/[–—]/);
  });

  it('moves the object with the arrow keys: left is farther away, right is nearer, Shift is a small step', async () => {
    const { root } = await open();
    const object = handle(root, 'object');
    press(object, 'ArrowRight');
    expect(readout(root).values[0]).toBe('13.5 cm');
    press(object, 'ArrowLeft', { shiftKey: true });
    expect(readout(root).values[0]).toBe('13.6 cm');
    press(object, 'ArrowUp');
    expect(readout(root).values[4]).not.toBe('2.3 cm');
    expect(slider(root, /Object distance/).value).toBe('13.6');
    expect(object.getAttribute('aria-label')).toContain('13.6');
  });

  it('keeps v inside its limits', async () => {
    const { root } = await open();
    const object = handle(root, 'object');
    for (let i = 0; i < 80; i += 1) press(object, 'ArrowRight');
    expect(slider(root, /Object distance/).value).toBe('1');
    expect(readout(root).values[0]).toBe('1.0 cm');
    // Inside the focal length: virtual, upright, enlarged.
    expect(readout(root).verdict).toBe(
      'The image is virtual, upright and enlarged (N = 1.20).',
    );
  });

  it('moves a focal point with the arrow keys in the direction of the arrow', async () => {
    const { root } = await open();
    press(handle(root, 'focus-image'), 'ArrowRight');
    expect(readout(root).values[2]).toBe('6.5 cm');
    press(handle(root, 'focus-object'), 'ArrowLeft');
    expect(readout(root).values[2]).toBe('7.0 cm');
    press(handle(root, 'focus-object'), 'ArrowRight');
    expect(readout(root).values[2]).toBe('6.5 cm');
    expect(handle(root, 'focus-image').getAttribute('aria-valuenow')).toBe(
      '6.5',
    );
  });

  it('says so when the object stands in the focal point, and draws only two rays', async () => {
    const { root } = await open();
    const f = slider(root, /Focal length/);
    f.value = '10';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    const v = slider(root, /Object distance/);
    v.value = '10';
    v.dispatchEvent(new Event('input', { bubbles: true }));
    expect(readout(root).values[1]).toBe('∞');
    expect(readout(root).verdict).toMatch(/stands in the focal point/);
    const rays = [...root.querySelectorAll<SVGElement>('[data-rays] line')];
    // Two rays, incoming and outgoing each; no dashed extensions.
    expect(rays.filter(l => l.style.display !== 'none').length).toBe(4);
  });

  it('switches to a concave lens: negative f, virtual upright reduced image, dashed extensions', async () => {
    const { root } = await open();
    const hollow = [
      ...root.querySelectorAll<HTMLInputElement>('input[type=radio]'),
    ].find(i => i.value === 'concave')!;
    hollow.checked = true;
    hollow.dispatchEvent(new Event('change', { bubbles: true }));
    const { values, verdict } = readout(root);
    expect(values[2]).toBe('-6.0 cm');
    // 1/b = 1/f - 1/v = -1/6 - 1/14 -> b = -4.2
    expect(values[1]).toBe('-4.2 cm');
    expect(verdict).toBe(
      'The image is virtual, upright and reduced (N = 0.30).',
    );
    expect(
      root.querySelector<HTMLElement>('[data-virtual-legend]')!.style.display,
    ).toBe('');
    const image = root.querySelector('[data-image] line')!;
    expect(image.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(root.querySelector('.ph-lens')!.getAttribute('data-real')).toBe(
      'false',
    );
  });

  it('follows the sliders', async () => {
    const { root } = await open();
    const f = slider(root, /Focal length/);
    f.value = '5';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    // v = 14, f = 5 -> b = 7.78
    expect(readout(root).values[1]).toBe('7.8 cm');
    expect(f.getAttribute('aria-valuetext')).toBe('5.0 cm');
  });

  it('moves the object when dragged', async () => {
    const { root } = await open();
    const svg = root.querySelector('svg')!;
    const [w, h] = [
      Number(svg.getAttribute('width')),
      Number(svg.getAttribute('height')),
    ];
    layOut(svg, w, h);
    const scale = Math.min(22, w / 40);
    const object = handle(root, 'object');
    const [tipX, tipY] = [w / 2 - 14 * scale, h / 2 - 3 * scale];
    pointer(object, 'pointerdown', tipX, tipY);
    // Drag 4 cm towards the lens and 1 cm up.
    pointer(object, 'pointermove', tipX + 4 * scale, tipY - 1 * scale);
    pointer(object, 'pointerup', tipX + 4 * scale, tipY - 1 * scale);
    expect(readout(root).values[0]).toBe('10.0 cm');
    expect(slider(root, /Object height/).value).toBe('4');
  });

  it('follows the host colour scheme', async () => {
    const { root, store } = await open('en-US', 'dark');
    expect(root.dataset.scheme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    store.switchTo('light');
    expect(root.dataset.scheme).toBe('light');
  });

  it('makes every control reachable: sliders have labels, handles are focusable with a name', async () => {
    const { root } = await open();
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[type=range]',
    ))
      expect(root.querySelector(`label[for="${input.id}"]`)).not.toBeNull();

    for (const name of ['object', 'focus-object', 'focus-image']) {
      const el = handle(root, name);
      expect(el.getAttribute('tabindex')).toBe('0');
      expect(el.getAttribute('aria-label')).toBeTruthy();
    }

    expect(root.querySelector('fieldset legend')).not.toBeNull();
  });
});
