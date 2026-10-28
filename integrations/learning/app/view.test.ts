// @wc-ignore-file
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fakeStore } from './fakeStore.js';
import { view } from './main.js';

const settle = async () => {
  for (let i = 0; i < 20; i += 1)
    await new Promise(resolve => setTimeout(resolve, 0));
};

const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

async function open() {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  document.head.replaceChildren();
  await view({ root, store: fakeStore() });
  await settle();

  return root;
}

const button = (root: HTMLElement, label: string | RegExp) =>
  [...root.querySelectorAll('button')].find(b =>
    typeof label === 'string' ? text(b) === label : label.test(text(b)),
  )!;
const node = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('.lb-node')].find(b =>
    text(b).includes(name),
  )!;

describe('Atomic Education view', () => {
  it('starts empty and loads the starter tree on request', async () => {
    const root = await open();
    expect(text(root.querySelector('.lb-empty'))).toMatch(/No skills yet/);
    button(root, 'Load starter tree').click();
    await settle();
    // Once loaded the button is gone: it is an empty-state action only.
    expect(button(root, 'Load starter tree')).toBeUndefined();
    expect(text(root.querySelector('.lb-progress'))).toBe('0 of 30 mastered');
    expect(root.querySelectorAll('.lb-node').length).toBe(30);
    expect(text(root.querySelector('.lb-notices'))).toBe(
      'Starter tree loaded: 30 new skills.',
    );
  });

  it('dims locked skills but keeps them clickable, and shows lessons with an icon per format', async () => {
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();

    const locked = node(root, 'relativiteit') as HTMLButtonElement;
    expect(locked.classList.contains('is-locked')).toBe(true);
    expect(locked.disabled).toBe(false);
    expect(
      node(root, 'Rekenen met getallen').classList.contains('is-available'),
    ).toBe(true);

    locked.click();
    await settle();
    const panel = root.querySelector('.lb-detail')!;
    expect(text(panel.querySelector('h2'))).toBe(
      'Inleiding relativiteitstheorie',
    );
    expect(text(panel)).toMatch(/This is advice/);
    expect(text(panel)).toMatch(/Advised first/);
    const lessons = [...panel.querySelectorAll('.lb-lessons li')];
    expect(lessons).toHaveLength(2);
    expect(lessons[0]!.querySelector('.lb-icon')!.textContent).toBe(
      '\u{1F3AC}',
    );
    expect(text(lessons[0])).toContain('Video · 25 min');
    expect(text(lessons[0])).toContain('no material yet');
  });

  it('writes mastery for "I master this" and unlocks what follows', async () => {
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();
    expect(node(root, 'Breuken').classList.contains('is-locked')).toBe(true);

    node(root, 'Rekenen met getallen').click();
    await settle();
    button(root, 'I master this').click();
    await settle();
    expect(
      node(root, 'Rekenen met getallen').classList.contains('is-mastered'),
    ).toBe(true);
    expect(node(root, 'Breuken').classList.contains('is-available')).toBe(true);
    expect(text(root.querySelector('.lb-next'))).toMatch(/Breuken/);

    button(root, 'No longer mastered').click();
    await settle();
    expect(node(root, 'Breuken').classList.contains('is-locked')).toBe(true);
  });

  it('highlights the route to a goal', async () => {
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();
    node(root, 'Procenten en verhoudingen').click();
    await settle();
    button(root, 'Path to this goal').click();
    await settle();
    const onPath = [...root.querySelectorAll('.lb-node.on-path')].map(n =>
      text(n),
    );
    expect(onPath).toEqual(
      expect.arrayContaining([
        'Rekenen met getallen',
        'Breuken',
        'Procenten en verhoudingen',
      ]),
    );
    expect(onPath).toHaveLength(3);
    expect(text(root.querySelector('.lb-path'))).toMatch(/3 steps/);
    expect(root.querySelectorAll('.lb-edge.on-path').length).toBe(2);
    expect(text(root.querySelector('.lb-next'))).toMatch(
      /Next steps toward your goal: Procenten/,
    );
  });

  it('marks the selected skill and its edges, and fades the rest', async () => {
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();
    expect(root.querySelectorAll('.lb-edge.is-near').length).toBe(0);
    node(root, 'Breuken').click();
    await settle();
    // Breuken needs one skill and two skills need it: three highlighted edges.
    expect(root.querySelectorAll('.lb-edge.is-near').length).toBe(3);
    expect(node(root, 'Breuken').classList.contains('is-selected')).toBe(true);
    expect(node(root, 'Breuken').getAttribute('aria-label')).toBe(
      'Breuken, Not yet due',
    );
  });

  it('shows an unlinked interactive lesson, links a resource and then starts it', async () => {
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();
    node(root, 'Optica').click();
    await settle();
    const row = () =>
      [...root.querySelectorAll('.lb-lesson')].find(li =>
        text(li).includes('Lenzen (interactief)'),
      )!;
    expect(text(row())).toMatch(/not linked yet/);
    expect(row().querySelector('.lb-icon')!.textContent).toBe('\u25B6\uFE0E');
    expect(button(root, 'Start')).toBeUndefined();

    const input = row().querySelector('input')!;
    input.value = 'not a resource';
    row().querySelector<HTMLButtonElement>('.lb-linkform button')!.click();
    await settle();
    expect(text(root.querySelector('.lb-notices'))).toMatch(/not a resource/);

    row().querySelector('input')!.value = 'did:ad:lens';
    row()
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(text(row())).not.toMatch(/not linked yet/);
    expect(row().querySelector('input')).toBeNull();
    expect(text(row().querySelector('button'))).toBe('Start');
  });

  it('keeps a half-typed link when the view redraws', async () => {
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();
    node(root, 'Optica').click();
    await settle();
    root.querySelector('input')!.value = 'did:ad:half';
    button(root, 'Path to this goal').click();
    await settle();
    expect(root.querySelector('input')!.value).toBe('did:ad:half');
  });
});
