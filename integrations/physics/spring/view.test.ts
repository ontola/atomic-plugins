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
  await view({ root, store: fakeStore('light') });
  await settle();

  return root;
}

const slider = (root: HTMLElement, label: RegExp) =>
  [...root.querySelectorAll<HTMLInputElement>('input[type=range]')].find(i =>
    label.test(text(root.querySelector(`label[for="${i.id}"]`))),
  )!;

const set = (input: HTMLInputElement, value: number) => {
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const values = (root: HTMLElement) =>
  [...root.querySelectorAll('.ph-values dd')].map(text);
const toggle = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>('[data-toggle]')!;

describe('spring app', () => {
  it('shows T = 2 pi sqrt(m/C) for m = 0.5 and C = 20', async () => {
    const root = await open();
    expect(values(root)[0]).toBe('0.99 s');
    expect(text(root.querySelector('[data-formula]'))).toBe(
      'T = 2π√(m/C) = 2π√(0.50/20.0) = 0.99 s',
    );
    expect(text(root.querySelector('[data-regime]'))).toMatch(
      /Without damping/,
    );
    expect(values(root)[1]).toMatch(/not yet/);
  });

  it('animates while visible and measures the period from the plotted motion', async () => {
    const root = await open();
    expect(clock.pending()).toBe(1);
    clock.run(260, 16);
    // About 4.2 s of simulated time: two upward zero crossings have happened.
    expect(values(root)[1]).toBe('0.99 s');
    expect(values(root)[3]).toMatch(/^4\.\d\d s$/);
    expect(
      root.querySelector('[data-curve]')!.getAttribute('d')!.length,
    ).toBeGreaterThan(200);
    expect(
      root.querySelector('svg:nth-of-type(1) [data-spring]'),
    ).not.toBeNull();
  });

  it('keeps the measured period equal to T when the mass changes', async () => {
    const root = await open();
    set(slider(root, /Mass/), 2);
    expect(values(root)[0]).toBe('1.99 s');
    clock.run(520, 16);
    expect(values(root)[1]).toBe('1.99 s');
  });

  it('pauses, and resumes', async () => {
    const root = await open();
    clock.run(5);
    toggle(root).click();
    expect(toggle(root).textContent).toBe('Start');
    clock.tick();
    expect(clock.pending()).toBe(0);
    const t = values(root)[3];
    clock.run(5);
    expect(values(root)[3]).toBe(t);
    toggle(root).click();
    expect(clock.pending()).toBe(1);
  });

  it('asks for no frames while hidden and picks up without a jump', async () => {
    const root = await open();
    clock.run(10);
    const t = values(root)[3];
    setVisibility(document, 'hidden');
    expect(clock.pending()).toBe(0);
    clock.run(5, 5000);
    expect(values(root)[3]).toBe(t);
    setVisibility(document, 'visible');
    clock.run(2);
    expect(Number(values(root)[3].replace(' s', ''))).toBeLessThan(
      Number(t.replace(' s', '')) + 0.2,
    );
  });

  it('restarts from the amplitude when a slider moves, and the period follows C', async () => {
    const root = await open();
    clock.run(60);
    set(slider(root, /Spring constant/), 80);
    expect(values(root)[0]).toBe('0.50 s');
    expect(values(root)[3]).toBe('0.00 s');
    expect(values(root)[4]).toBe('8.0 cm');
  });

  it('describes damping: underdamped has a longer period, critical and over do not oscillate', async () => {
    const root = await open();
    set(slider(root, /Damping/), 2);
    expect(text(root.querySelector('[data-regime]'))).toMatch(
      /Underdamped.*1\.0\d s/,
    );
    expect(
      root.querySelector('[data-envelope-legend]') as HTMLElement,
    ).toHaveProperty('style');
    clock.run(400);
    // The measured period is the damped one, a little above T.
    expect(Number(values(root)[1].replace(' s', ''))).toBeGreaterThan(0.99);
    set(slider(root, /Damping/), 7);
    expect(text(root.querySelector('[data-regime]'))).toMatch(
      /Overdamped|Critically/,
    );
    clock.run(300);
    expect(values(root)[1]).toMatch(/not yet/);
  });

  it('changes the amplitude with the arrow keys on the mass', async () => {
    const root = await open();
    const mass = root.querySelector<SVGElement>('[data-handle="mass"]')!;
    press(mass, 'ArrowUp');
    expect(slider(root, /Amplitude/).value).toBe('8.5');
    press(mass, 'ArrowDown', { shiftKey: true });
    expect(slider(root, /Amplitude/).value).toBe('8.4');
    press(mass, ' ');
    expect(toggle(root).textContent).toBe('Start');
  });

  it('speaks Dutch with decimal commas and no dash characters', async () => {
    const root = await open('nl-NL');
    expect(text(root.querySelector('h1'))).toBe('Trillingen');
    expect(values(root)[0]).toBe('0,99 s');
    expect(root.textContent).not.toMatch(/[–—]/);
  });

  it('labels every slider', async () => {
    const root = await open();
    for (const input of root.querySelectorAll<HTMLInputElement>(
      'input[type=range]',
    ))
      expect(root.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
  });
});
