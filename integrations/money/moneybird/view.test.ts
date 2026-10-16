// @wc-ignore-file
/**
 * `main.ts`'s `view()` in jsdom (from the atomic-server checkout's
 * data-browser workspace; no dependency of our own), against the in-memory
 * fake store: the shared sync-status card comes first under the heading, is
 * read-only in every state, carries each collection's result after an
 * import, and is absent on a table the app cannot sync. The `role="status"`
 * line stays the one live region, visually hidden while the card holds the
 * same words.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { fakeStore } from './fakeStore.js';
import { WORK_PROJECT } from './hours.js';
import { view } from './main.js';

const { JSDOM } = createRequire(
  new URL('../../../browser/data-browser/package.json', import.meta.url),
)('jsdom') as typeof import('jsdom');

const A = '100000000000000001';

const text = (node: Element | null | undefined) =>
  (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Polls until `root`'s status line matches, or fails after a second. */
async function until(root: HTMLElement, pattern: RegExp) {
  for (let i = 0; i < 200; i++) {
    if (pattern.test(text(root.querySelector('[role="status"]')))) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  throw new Error(
    `status never matched ${pattern}: ${text(root.querySelector('[role="status"]'))}`,
  );
}

async function open(store = fakeStore()) {
  const doc = new JSDOM('<!doctype html><body><div id="root"></div></body>')
    .window.document;
  const root = doc.getElementById('root') as HTMLElement;
  await view({ root, store });

  return { doc, root };
}

const card = (root: HTMLElement) =>
  root.querySelector('section[aria-label="Sync status"]');

describe('the Moneybird view', () => {
  it('puts the sync-status card first under the heading, read-only before any sync', async () => {
    const { root } = await open();
    await until(root, /Choose the Moneybird administration/);
    expect(root.children[0].tagName).toBe('STYLE');
    expect(root.children[0].textContent).toMatch(/\.ss-head\b/);
    expect(root.children[1].tagName).toBe('H1');
    expect(root.children[2].firstElementChild).toBe(card(root));
    expect(text(card(root)!.querySelector('[data-key="headline"]'))).toBe(
      'Not synced yet',
    );
    expect(text(card(root)!.querySelector('[data-key="mode"]'))).toBe(
      'Read-only: edits here stay in Atomic. Nothing is sent to Moneybird, and the next sync overwrites edits made here in the columns it imports.',
    );
    // One live region, visible while the card does not hold its words.
    expect(root.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(
      root.querySelector('[role="status"]')!.classList.contains('mb-sr'),
    ).toBe(false);
  });

  it('after an import, the card counts each collection and the status line is hidden, not removed', async () => {
    const store = fakeStore({ outage: false });
    const { root } = await open(store);
    await until(root, /Choose the Moneybird administration/);
    (root.querySelector('select') as HTMLSelectElement).value = A;
    const importButton = [...root.querySelectorAll('button')].find(
      b => b.textContent === 'Import',
    )!;
    importButton.click();
    await until(root, /Last synced/);
    const status = root.querySelector('[role="status"]')!;
    expect(status.classList.contains('mb-sr')).toBe(true);
    expect(text(status)).toMatch(/5 contacts \(5 added/);
    const section = card(root)!;
    expect(text(section.querySelector('[data-key="headline"]'))).toBe(
      'Synced just now',
    );
    expect(text(section.querySelector('[data-key="rows"]'))).toBe(
      '15 rows imported: 5 contacts, 4 time entries, 6 mutations',
    );
    expect(text(section.querySelector('[data-key="counts"]'))).toBe(
      'Last sync: 15 added, 0 updated, 0 unchanged',
    );
    expect(section.getAttribute('data-tone')).toBe('ok');
    expect(section.querySelectorAll('button')).toHaveLength(0);

    // Change settings: the card keeps the last sync while they are open.
    [...root.querySelectorAll('button')]
      .find(b => b.textContent === 'Change settings')!
      .click();
    await until(root, /Choose the Moneybird administration/);
    expect(text(card(root)!.querySelector('[data-key="headline"]'))).toBe(
      'Synced just now',
    );
    expect(
      root.querySelector('[role="status"]')!.classList.contains('mb-sr'),
    ).toBe(false);
  });

  it('names a failed collection next to the others, with its rows kept', async () => {
    const store = fakeStore();
    const first = await open(store);
    await until(first.root, /Choose the Moneybird administration/);
    (first.root.querySelector('select') as HTMLSelectElement).value = A;
    [...first.root.querySelectorAll('button')]
      .find(b => b.textContent === 'Import')!
      .click();
    await until(first.root, /Last synced/);

    // A second open (reload) hits the fixture's synthetic 503 on contacts.
    const { root } = await open(store);
    await until(root, /refresh failed/);
    const section = card(root)!;
    expect(section.getAttribute('data-tone')).toBe('neg');
    expect(text(section.querySelector('[data-key="headline"]'))).toBe(
      'Synced just now',
    );
    expect(text(section.querySelector('[data-key="rows"]'))).toBe(
      '10 rows imported: 4 time entries, 6 mutations',
    );
    const problem = section.querySelector('.ss-problem')!;
    expect(text(problem)).toContain('Contacts: refresh failed.');
    expect(text(problem)).toContain('503');
    expect(text(problem)).toContain('The contacts imported earlier are kept');
    expect(text(problem)).toContain('Press Sync now to try again.');
  });

  it('shows no card on a table this app cannot sync', async () => {
    const { root } = await open(
      fakeStore({ ownShared: { rowClass: WORK_PROJECT, name: 'Projects' } }),
    );
    await until(root, /own projects table/);
    expect(card(root)).toBeNull();
  });
});
