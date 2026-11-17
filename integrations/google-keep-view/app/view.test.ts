// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// Host workspace's existing test DOM, not a runtime dependency of the app.
import { JSDOM } from '../../../browser/data-browser/node_modules/jsdom/lib/api.js';
import { fixture, importedFixture } from './fixture.js';
import { view } from './main.js';

async function mount(table?: 'items' | 'notes') {
  const fake = fixture();
  if (table) fake.attach(table);
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const root = dom.window.document.getElementById('root')!;
  await view({ root, store: fake.store });

  return { ...fake, dom, root };
}

describe('Keep view DOM', () => {
  it('renders unchecked items above collapsible completed items and preserves indentation', async () => {
    const { root, dom } = await mount();
    const note = root.querySelector('article')!;
    expect(
      [...note.querySelectorAll('li')].map(item => item.textContent),
    ).toEqual([
      'Fictional bread',
      'Pretend jam',
      'Imaginary apples',
      'Made-up tea',
    ]);
    expect(note.querySelector('.keep-indented')?.textContent).toBe(
      'Pretend jam',
    );
    expect(note.querySelector('details')?.open).toBe(false);
    expect(note.querySelector('summary')?.textContent).toBe(
      '2 completed items',
    );
    expect(note.querySelector<HTMLInputElement>('input')?.disabled).toBe(true);
    expect(root.querySelector('.keep-body')?.textContent).toContain(
      '\nBring a notebook.',
    );
    dom.window.close();
  });
  it('searches without replacing the input and switches layout', async () => {
    const { root, dom } = await mount();
    const input = root.querySelector<HTMLInputElement>('input[type=search]')!;
    input.focus();
    input.value = 'scenic';
    input.dispatchEvent(new dom.window.Event('input'));
    expect(root.querySelectorAll('article')).toHaveLength(1);
    expect(dom.window.document.activeElement).toBe(input);
    const layout = [...root.querySelectorAll('button')].find(
      node => node.textContent === 'List view',
    )!;
    layout.click();
    expect(
      root.querySelector('.keep-grid')?.classList.contains('keep-list'),
    ).toBe(true);
    expect(layout.textContent).toBe('Grid view');
    input.value = 'no imaginary match';
    input.dispatchEvent(new dom.window.Event('input'));
    expect(root.querySelector('[role=status]')?.textContent).toBe(
      'No matching notes.',
    );
    dom.window.close();
  });
  it('offers editing on the items table and moves a ticked item into completed', async () => {
    const { root, dom, resources, done } = await mount('items');
    const allow = [...root.querySelectorAll('button')].find(
      node => node.textContent === 'Allow editing',
    )!;
    expect(allow.hidden).toBe(false);
    allow.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const input = root.querySelector<HTMLInputElement>(
      'input[aria-label="Fictional bread"]',
    )!;
    expect(input.disabled).toBe(false);
    input.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resources['did:test:item-1'][done]).toBe(true);
    expect(root.querySelector('details summary')?.textContent).toBe(
      '3 completed items',
    );
    expect(
      root.querySelector('ul[aria-label="Unchecked items"]')?.textContent,
    ).toBe('Pretend jam');
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    dom.window.close();
  });
  it('renders note content literally and reports failed loads with a retry', async () => {
    const fake = fixture();
    fake.resources['did:test:thought'][
      'https://atomicdata.dev/properties/description'
    ] = '<img src=x onerror=alert(1)>';
    const dom = new JSDOM('<div id="root"></div>');
    const root = dom.window.document.getElementById('root')!;
    await view({ root, store: fake.store });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');

    fake.store.getData = async () => {
      throw new Error('Temporarily unavailable');
    };

    [...root.querySelectorAll('button')]
      .find(node => node.textContent === 'Refresh')!
      .click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector('[role=status]')?.textContent).toBe(
      'Temporarily unavailable',
    );
    expect(
      root.querySelector<HTMLButtonElement>('button:last-child')?.disabled,
    ).not.toBe(true);
    dom.window.close();
  });
  it('explains how to start when no Keep data exists', async () => {
    const fake = fixture();
    fake.store.query = async () => [];
    const dom = new JSDOM('<div id="root"></div>');
    const root = dom.window.document.getElementById('root')!;
    await view({ root, store: fake.store });
    expect(root.querySelector('[role=status]')?.textContent).toContain(
      'Import your Keep data',
    );
    expect(root.querySelectorAll('article')).toHaveLength(0);
    dom.window.close();
  });
});

it('discovers an imported list on first open and can tick it when added as a table view', async () => {
  const fake = importedFixture();
  const dom = new JSDOM('<div id="root"></div>');
  const root = dom.window.document.getElementById('root')!;
  await view({ root, store: fake.store });
  expect(root.querySelector('h2')?.textContent).toBe(
    'Invented groceries · List',
  );
  expect(fake.resources['did:test:view-app']['did:test:renders']).toEqual([
    fake.rowClass,
  ]);
  expect(
    root.querySelector<HTMLInputElement>('input[aria-label="Pretend toast"]')
      ?.disabled,
  ).toBe(true);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  fake.attachTable(fake.table);
  await view({ root, store: fake.store });
  const allow = [...root.querySelectorAll('button')].find(
    button => button.textContent === 'Allow editing',
  )!;
  expect(allow.hidden).toBe(false);
  allow.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  root
    .querySelector<HTMLInputElement>('input[aria-label="Pretend toast"]')!
    .click();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fake.resources['did:test:import-toast'][fake.checked]).toBe(true);
  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
});

it('does not silently show another list when the attached table no longer has a checkbox column', async () => {
  const fake = importedFixture();
  fake.attachTable(fake.table);
  fake.resources[fake.checked]['https://atomicdata.dev/properties/datatype'] =
    'https://atomicdata.dev/datatypes/string';
  const dom = new JSDOM('<div id="root"></div>');
  const root = dom.window.document.getElementById('root')!;
  await view({ root, store: fake.store });
  expect(root.querySelector('[role=status]')?.textContent).toContain(
    'This table needs',
  );
  expect(root.querySelectorAll('article')).toHaveLength(0);
  dom.window.close();
});
