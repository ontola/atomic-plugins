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

async function open(store = fakeStore()) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  document.head.replaceChildren();
  await view({ root, store });
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
      'Starter tree loaded: 30 new skills and 3 mini apps.',
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
    node(root, 'Elektriciteit').click();
    await settle();
    const row = () =>
      [...root.querySelectorAll('.lb-lesson')].find(li =>
        text(li).includes('Interactief: Elektriciteit'),
      )!;
    expect(text(row())).toMatch(/not linked yet/);
    expect(row().querySelector('.lb-icon')!.textContent).toBe('\u25B6\uFE0E');
    expect(button(root, 'Start')).toBeUndefined();

    const input = row().querySelector('input')!;
    input.value = 'not a resource';
    row().querySelector<HTMLButtonElement>('.lb-linkform button')!.click();
    await settle();
    expect(text(root.querySelector('.lb-notices'))).toMatch(/not a resource/);

    row().querySelector('input')!.value = 'did:ad:electricity';
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
    node(root, 'Elektriciteit').click();
    await settle();
    root.querySelector('input')!.value = 'did:ad:half';
    button(root, 'Path to this goal').click();
    await settle();
    expect(root.querySelector('input')!.value).toBe('did:ad:half');
  });

  it('links the starter physics lessons to mini apps in the drive, and Start opens that app', async () => {
    const store = fakeStore();
    const opened: string[] = [];

    store.openResource = async subject => {
      opened.push(subject);

      return { status: 'opened', subject };
    };

    const root = await open(store);
    button(root, 'Load starter tree').click();
    await settle();
    node(root, 'Optica').click();
    await settle();
    const row = [...root.querySelectorAll('.lb-lesson')].find(li =>
      text(li).includes('Lenzen (interactief)'),
    )!;
    expect(text(row)).not.toMatch(/not linked yet/);
    row.querySelector<HTMLButtonElement>('button')!.click();
    await settle();
    // The fake drive's subjects are not did:, so Start would go out as a link
    // unless it recognises the app: it must open the resource.
    expect(opened).toHaveLength(1);
    expect(store.resources.get(opened[0]!)).toMatchObject({
      'https://atomicdata.dev/properties/name': 'Lenzen',
    });
  });

  it('offers "Create with AI" on an unlinked interactive lesson: shows the request and copies it when it can', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void written.push(t) },
    });
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();
    node(root, 'Elektriciteit').click();
    await settle();
    const row = () =>
      [...root.querySelectorAll('.lb-lesson')].find(li =>
        text(li).includes('Interactief: Elektriciteit'),
      )!;
    // Linked lessons have no such button.
    node(root, 'Optica').click();
    await settle();
    expect(button(root, /Create with AI/)).toBeUndefined();
    node(root, 'Elektriciteit').click();
    await settle();

    button(root, /^Create with AI/).click();
    await settle();
    const prompt = row().querySelector('textarea')!.value;
    expect(prompt).toMatch(
      /^Make an interactive mini app \(drive app\) that explains Elektriciteit for my students, and link it to the lesson Interactief: Elektriciteit \(fake:r\d+\)/,
    );
    expect(written).toEqual([prompt]);
    expect(text(row())).toMatch(/on your clipboard/);

    button(root, 'Close').click();
    await settle();
    expect(row().querySelector('textarea')).toBeNull();
  });

  it('shows the request with a hint when the clipboard is refused', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
    const root = await open();
    button(root, 'Load starter tree').click();
    await settle();
    node(root, 'Elektriciteit').click();
    await settle();
    button(root, /^Create with AI/).click();
    await settle();
    expect(text(root.querySelector('.lb-ai'))).toMatch(
      /Copy this request, open the Atomic assistant and paste it there/,
    );
    expect(root.querySelector('textarea')!.value).toMatch(/Elektriciteit/);
  });

  it('opens a lesson linked to an atomic: or did: subject as a resource, not as a link', async () => {
    const store = fakeStore();
    const opened: string[] = [];
    const away: string[] = [];

    store.openResource = async subject => {
      opened.push(subject);

      return { status: 'opened', subject };
    };

    store.openExternal = async url => {
      away.push(url);

      return { status: 'opened' };
    };

    const root = await open(store);
    button(root, 'Load starter tree').click();
    await settle();

    for (const [skill, target] of [
      ['Elektriciteit', 'atomic:abc123'],
      ['Functies en grafieken', 'did:ad:abc123'],
    ] as const) {
      node(root, skill).click();
      await settle();
      root.querySelector('input')!.value = target;
      root.querySelector<HTMLButtonElement>('.lb-linkform button')!.click();
      await settle();
      button(root, /^Start/).click();
      await settle();
    }

    expect(opened).toEqual(['atomic:abc123', 'did:ad:abc123']);
    expect(away).toEqual([]);
  });
});
