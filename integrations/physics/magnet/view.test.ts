// @wc-ignore-file
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeStore,
  frames,
  press,
  setLanguage,
  setVisibility,
  settle,
  text,
  type Frames,
} from '../shared/testing.js';
import { view } from './main.js';

let clock: Frames;
beforeEach(() => {
  clock = frames();
});
afterEach(() => {
  clock.restore();
  setVisibility(document, 'visible');
  setLanguage('en-US');
});

async function open(language = 'en-US') {
  setLanguage(language);
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  document.head.replaceChildren();
  await view({ root, store: fakeStore('dark') });
  await settle();

  return root;
}

const handle = (root: HTMLElement, name: string) =>
  root.querySelector<SVGElement>(`[data-handle="${name}"]`)!;

const radio = (root: HTMLElement, value: string) => {
  const input = [
    ...root.querySelectorAll<HTMLInputElement>('input[type=radio]'),
  ].find(i => i.value === value)!;
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

const verdict = (root: HTMLElement) =>
  text(root.querySelector('[data-verdict]'));
const needle = (root: HTMLElement) =>
  root.querySelector('[data-needle]')!.getAttribute('transform');

describe('magnet app', () => {
  it('draws field lines with arrowheads for one magnet and tells you to add a second', async () => {
    const root = await open();
    expect(root.dataset.scheme).toBe('dark');
    const d = root.querySelector('[data-layer=lines]')!.getAttribute('d')!;
    expect(d.split('M').length - 1).toBeGreaterThan(10);
    expect(
      root.querySelector('[data-layer=arrows]')!.getAttribute('d'),
    ).toBeTruthy();
    expect(verdict(root)).toMatch(/second magnet/);
    expect(handle(root, 'magnet-2').style.display).toBe('none');
  });

  it('shows attraction when north faces south, and repulsion after flipping magnet 2', async () => {
    const root = await open();
    radio(root, '2');
    expect(verdict(root)).toBe('Attraction');
    expect(text(root.querySelector('[data-facing]'))).toContain(
      'north pole of magnet 1 and the south pole of magnet 2',
    );
    expect(
      root.querySelector('.ph-magnet')!.getAttribute('data-interaction'),
    ).toBe('attract');
    const flip = [...root.querySelectorAll('button')].find(b =>
      /Flip/.test(text(b)),
    )!;
    flip.click();
    expect(verdict(root)).toBe('Repulsion');
    expect(text(root.querySelector('[data-why]'))).toBe('Like poles repel.');
    expect(
      root.querySelector<HTMLElement>('[data-force="2"]')!.style.display,
    ).toBe('');
  });

  it('moves a magnet and the compass with the arrow keys, and turns a magnet with Shift', async () => {
    const root = await open();
    const magnet = handle(root, 'magnet-1');
    const before = magnet.getAttribute('aria-label');
    press(magnet, 'ArrowRight');
    expect(magnet.getAttribute('aria-label')).not.toBe(before);
    expect(magnet.getAttribute('aria-label')).toContain('0.3');
    press(magnet, 'ArrowLeft', { shiftKey: true });
    expect(magnet.getAttribute('aria-label')).toContain('angle 5 degrees');
    const compass = handle(root, 'compass');
    const field = text(root.querySelector('[data-field]'));
    press(compass, 'ArrowLeft');
    press(compass, 'ArrowLeft');
    expect(compass.getAttribute('aria-label')).toContain('x 4.0');
    expect(text(root.querySelector('[data-field]'))).not.toBe(field);
    press(handle(root, 'rotate-1'), 'ArrowLeft');
    expect(handle(root, 'rotate-1').getAttribute('aria-valuenow')).toBe('10');
  });

  it('swings the compass needle to the field direction over a few frames, then stops asking for frames', async () => {
    const root = await open();
    const compass = handle(root, 'compass');
    press(compass, 'ArrowUp');
    const first = needle(root);
    clock.run(2);
    expect(clock.pending()).toBeGreaterThan(0);
    clock.run(300);
    expect(clock.pending()).toBe(0);
    expect(needle(root)).not.toBe(first);
    const target = Number(
      text(root.querySelector('[data-direction]')).split(' ')[0],
    );
    const shown = -Number(/rotate\(([-\d.]+)\)/.exec(needle(root)!)![1]);
    expect((((shown % 360) + 360) % 360) - target).toBeCloseTo(0, 0);
  });

  it('asks for no animation frames while hidden', async () => {
    const root = await open();
    setVisibility(document, 'hidden');
    press(handle(root, 'compass'), 'ArrowUp');
    expect(clock.pending()).toBe(0);
    setVisibility(document, 'visible');
    expect(clock.pending()).toBeGreaterThan(0);
  });

  it('switches the background between filings and field strength', async () => {
    const root = await open();
    radio(root, 'filings');
    clock.run(2);
    const f = root.querySelector<HTMLElement>('[data-layer=filings]')!;
    expect(f.style.display).toBe('');
    const total = [...f.querySelectorAll('path')].reduce(
      (n, p) => n + p.getAttribute('d')!.length,
      0,
    );
    expect(total).toBeGreaterThan(5000);
    radio(root, 'strength');
    clock.run(2);
    expect(
      root.querySelector<HTMLElement>('[data-layer=filings]')!.style.display,
    ).toBe('none');
    expect(
      root.querySelector<HTMLElement>('[data-layer=strength]')!.style.display,
    ).toBe('');
    expect(
      root
        .querySelector('[data-layer=strength] path[data-level="7"]')!
        .getAttribute('d'),
    ).toBeTruthy();
  });

  it('can hide the field lines', async () => {
    const root = await open();
    const box = root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    clock.run(2);
    expect(root.querySelector('[data-layer=lines]')!.getAttribute('d')).toBe(
      '',
    );
  });

  it('speaks Dutch with Z for the south pole and no dash characters', async () => {
    const root = await open('nl');
    expect(text(root.querySelector('h1'))).toBe('Magneten');
    radio(root, '2');
    expect(verdict(root)).toBe('Aantrekking');
    expect(root.textContent).not.toMatch(/[–—]/);
    expect([...root.querySelectorAll('text')].map(text)).toContain('Z');
  });

  it('labels every control', async () => {
    const root = await open();
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[type=range]',
    ))
      expect(root.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    for (const name of ['magnet-1', 'rotate-1', 'compass'])
      expect(handle(root, name).getAttribute('aria-label')).toBeTruthy();
  });
});
