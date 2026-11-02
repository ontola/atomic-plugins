// @wc-ignore-file
/**
 * The Google Keep drive app (`../app/`, two-way sync while the view is
 * open) end to end, against the mock integration proxy serving the
 * SYNTHETIC google-keep fixture (`../fixtures/google-keep/`, hand-written
 * from the Keep API v1 reference, not a recording).
 *
 * Installed from the catalog's Drive apps section, as the Google Tasks spec
 * does; the lane's dev-server serves the committed
 * `apps/google-keep/<version>/ui.js` and the entry enabled.
 *
 * Journey:
 * 1. Install and connect: the five notes become rows of the app's own
 *    `google-keep-note` class, a list note's items rows of the app's
 *    `google-keep-item` table.
 * 2. Reload: nothing changed, no row is written, nothing is sent.
 * 3. A note edited in Keep (`editNote`): its row takes the edit.
 * 4. A list edited on both sides, item by item: an item moved in Keep
 *    (`moveItem`) and another ticked here come out moved and ticked. While
 *    sending is off (the default) nothing reaches Keep; once "Send edits to
 *    Google Keep" is turned on (it asks first), the list is sent as a
 *    replacement note; the old note is deleted there, the row follows the
 *    new one.
 * 5. A shared note's row edited here: held back, nothing sent.
 * 6. A note edited on both sides: a conflict; "Keep mine" sends the row's
 *    version.
 * 7. A row made here: created in Keep.
 * 8. A note trashed in Keep (`trashNote`): marked trashed, row kept.
 *
 *   node integrations/tooling/run-lane.mjs google-keep --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import { appVersion } from '../../tooling/apps.mjs';

const APP_FRAME = 'iframe[title="App"]';
const VERSION = appVersion('google-keep');
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const CLASSTYPE = 'https://atomicdata.dev/properties/classtype';

interface KeepNote {
  name: string;
  title?: string;
  body: unknown;
}

test.describe('Google Keep drive app', () => {
  test.beforeEach(before);

  test('imports notes, syncs edits both ways, holds back what it may not replace, and settles conflicts and trashed notes', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    const synced = status.filter({ hasText: 'Last synced' });
    const card = app.getByRole('region', { name: 'Sync status' });
    const rows = app.locator('tr[data-subject]');
    const sync = app.getByRole('button', { name: 'Sync now' });
    await fixture('reset', []);

    // 1. Install, connect, import.
    await installFromCatalog(page);
    await expect(app.getByRole('heading', { name: 'Google Keep' })).toBeVisible(
      { timeout: 30_000 },
    );
    await expect(status).toContainText('Not connected');
    await expect(card).toContainText(
      'Google offers the Keep API to Google Workspace accounts only.',
    );
    await app.getByRole('button', { name: 'Connect Google Keep' }).click();
    const consent = page.getByRole('dialog', { name: 'Connect Google Keep' });
    await expect(consent).toContainText('Google Keep');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Google Keep with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    await expect(synced).toContainText(
      '5 notes (5 added, 0 updated, 0 unchanged).',
      { timeout: 60_000 },
    );
    await expect(rows).toHaveCount(5);
    await expect(card).toContainText('5 notes from Google Keep');
    await expect(card).toContainText('Read-only: Google Keep’s changes');
    const packing = rows.filter({ hasText: 'Synthetic packing list' });
    await expect(packing).toHaveAttribute(
      'data-note',
      'notes/synthetic-note-2',
    );
    await expect(packing).toContainText('list');

    const subjects = await rows.evaluateAll(trs =>
      trs.map(tr => (tr as HTMLElement).dataset.subject!),
    );
    const packingSubject = (await packing.getAttribute('data-subject'))!;
    const typed = await page.evaluate(
      async a => {
        const store = window.store!;
        await store.reloadResource(a.row);
        const row = await store.getResource(a.row);
        const table = await store.getResource(row.get(a.parent) as string);

        return {
          isA: row.get(a.isA),
          classtype: table.get(a.classtype),
          body: row.get(a.description),
        };
      },
      {
        row: packingSubject,
        parent: PARENT,
        isA: IS_A,
        classtype: CLASSTYPE,
        description: DESCRIPTION,
      },
    );
    expect(typed.isA).toEqual([typed.classtype]);
    expect(typed.body).toBe('');
    expect(await itemLines(page, packingSubject)).toEqual([
      '[x] Imaginary passport',
      '[ ] Made-up charger',
      '  [ ] Fictional adapter',
    ]);

    // 2. Reload: nothing changed, nothing written.
    const first = await propsOf(page, subjects);
    await page.reload();
    await expect(synced).toContainText(
      '5 notes (0 added, 0 updated, 5 unchanged).',
      { timeout: 60_000 },
    );
    expect(await propsOf(page, subjects)).toEqual(first);

    // 3. Edited in Keep.
    await fixture('editNote', [
      'synthetic-note-1',
      'Synthetic shopping ideas',
      'Invented cheese\nPretend bread\nMade-up jam',
    ]);
    await sync.click();
    await expect(synced).toContainText('(0 added, 1 updated, 4 unchanged)', {
      timeout: 60_000,
    });
    const shopping = rows.filter({ hasText: 'Synthetic shopping ideas' });
    const shoppingSubject = (await shopping.getAttribute('data-subject'))!;
    expect(
      (await propsOf(page, [shoppingSubject]))[shoppingSubject][DESCRIPTION],
    ).toBe('Invented cheese\nPretend bread\nMade-up jam');

    // 4. A list edited on both sides: moved in Keep, ticked here.
    await fixture('moveItem', ['synthetic-note-2', 1, 0]);
    await tickItem(page, packingSubject, 'Made-up charger');
    await sync.click();
    await expect(synced).toContainText('1 not sent', { timeout: 60_000 });
    expect(
      ((await fixture('snapshot', [])) as { deleted: string[] }).deleted,
    ).toEqual([]);
    await expect(card).toContainText('sending to Google Keep is off');
    page.once('dialog', dialog => void dialog.accept());
    await app.getByLabel('Send edits to Google Keep').check();
    await app.getByRole('button', { name: 'Save settings' }).click();
    await expect(synced).toContainText('1 sent to Google Keep', {
      timeout: 60_000,
    });
    await expect(card).toContainText(
      'Two-way: edits here are sent to Google Keep',
    );
    await expect(packing).toHaveAttribute('data-note', 'notes/synthetic-new-1');
    let keep = (await fixture('snapshot', [])) as {
      notes: KeepNote[];
      deleted: string[];
    };
    expect(keep.deleted).toContain('notes/synthetic-note-2');
    expect(
      keep.notes.find(n => n.name === 'notes/synthetic-new-1'),
    ).toMatchObject({
      title: 'Synthetic packing list',
      body: {
        list: {
          listItems: [
            {
              text: { text: 'Made-up charger' },
              checked: true,
              childListItems: [
                { text: { text: 'Fictional adapter' }, checked: false },
              ],
            },
            { text: { text: 'Imaginary passport' }, checked: true },
          ],
        },
      },
    });

    // 5. A shared note's row edited here: held back.
    const team = rows.filter({ hasText: 'Synthetic team plan' });
    await setProps(page, (await team.getAttribute('data-subject'))!, {
      [DESCRIPTION]: 'Edited here.',
    });
    await sync.click();
    await expect(synced).toContainText('1 not sent', { timeout: 60_000 });
    await expect(team).toHaveAttribute('data-hold', 'blocked');
    await expect(team).toContainText('It is shared');
    keep = (await fixture('snapshot', [])) as {
      notes: KeepNote[];
      deleted: string[];
    };
    expect(
      keep.notes.find(n => n.name === 'notes/synthetic-note-4')?.body,
    ).toEqual({
      text: { text: 'Shared with an invented friend.' },
    });

    // 6. A conflict, settled for this row's version.
    await setProps(page, shoppingSubject, { [NAME]: 'Shopping, edited here' });
    await fixture('editNote', [
      'synthetic-note-1',
      'Shopping, edited in Keep',
      'Invented cheese',
    ]);
    await sync.click();
    const conflicted = app.locator('tr[data-hold="conflict"]');
    await expect(conflicted).toHaveCount(1, { timeout: 60_000 });
    await expect(card).toContainText('changed both here and in Google Keep');
    await conflicted
      .getByRole('button', { name: /Keep this table's version/ })
      .click();
    await expect(app.locator('tr[data-hold="conflict"]')).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(synced).toContainText('1 sent to Google Keep', {
      timeout: 60_000,
    });
    keep = (await fixture('snapshot', [])) as {
      notes: KeepNote[];
      deleted: string[];
    };
    expect(keep.deleted).toContain('notes/synthetic-note-1');
    expect(keep.notes.some(n => n.title === 'Shopping, edited here')).toBe(
      true,
    );

    // 7. A row made here: created in Keep.
    const table = await page.evaluate(
      async a => {
        const store = window.store!;
        const row = await store.getResource(a.row);

        return {
          table: row.get(a.parent) as string,
          klass: (row.get(a.isA) as string[])[0],
        };
      },
      { row: packingSubject, parent: PARENT, isA: IS_A },
    );
    await page.evaluate(
      async a => {
        const store = window.store!;
        const row = await store.newResource({
          parent: a.table,
          isA: [a.klass],
          propVals: {
            [a.name]: 'Made in the drive',
            [a.description]: 'An invented thought.',
          },
        });
        await row.save();
      },
      { ...table, name: NAME, description: DESCRIPTION },
    );
    await sync.click();
    await expect(rows.filter({ hasText: 'Made in the drive' })).toHaveAttribute(
      'data-presence',
      'present',
      {
        timeout: 60_000,
      },
    );
    keep = (await fixture('snapshot', [])) as {
      notes: KeepNote[];
      deleted: string[];
    };
    expect(keep.notes.find(n => n.title === 'Made in the drive')?.body).toEqual(
      {
        text: { text: 'An invented thought.' },
      },
    );

    // 8. Trashed in Keep: marked, row kept.
    await fixture('trashNote', ['synthetic-note-3']);
    await sync.click();
    const untitled = app.locator('tr[data-note="notes/synthetic-note-3"]');
    await expect(untitled).toHaveAttribute('data-presence', 'trashed', {
      timeout: 60_000,
    });
    await expect(card).toContainText('in Google Keep’s trash');
    await expect(rows).toHaveCount(6);
  });
});

async function propsOf(
  page: Page,
  subjects: string[],
): Promise<Record<string, Record<string, unknown>>> {
  return page.evaluate(async list => {
    const store = window.store!;
    const out: Record<string, Record<string, unknown>> = {};

    for (const subject of list) {
      await store.reloadResource(subject);
      out[subject] = { ...(await store.getResource(subject)).getPropVals() };
    }

    return out;
  }, subjects);
}

/** An edit made in the drive, as a person editing the table would. */
async function setProps(
  page: Page,
  subject: string,
  values: Record<string, string>,
) {
  await page.evaluate(
    async a => {
      const store = window.store!;
      const row = await store.getResource(a.subject);
      for (const [k, v] of Object.entries(a.values)) await row.set(k, v);
      await row.save();
    },
    { subject, values },
  );
}

/** The items of a list note's row, in order: `[x] text`, a child indented. */
async function itemLines(page: Page, note: string): Promise<string[]> {
  return page.evaluate(async noteSubject => {
    const store = window.store!;
    const P = 'https://atomicdata.dev/properties/';
    const short = async (property: string) =>
      (await store.getResource(property)).get(`${P}shortname`);
    const row = await store.getResource(noteSubject);
    // The notes container may be a root account folder; ownership is in
    // the note class's ontology, independent of its current data parent.
    const klass = await store.getResource((row.get(`${P}isA`) as string[])[0]);
    const ontology = await store.getResource(klass.get(`${P}parent`) as string);
    const app = await store.getResource(ontology.get(`${P}parent`) as string);
    const children = await (
      await app.getChildrenCollection(500)
    ).getAllMembers();
    const out: { position: number; line: string }[] = [];

    for (const child of children) {
      const items = await store.fetchResourceFromServer(child, {
        noWebSocket: true,
      });
      if (items.get(`${P}name`) !== 'Google Keep list items') continue;

      for (const member of await (
        await items.getChildrenCollection(500)
      ).getAllMembers()) {
        const item = await store.fetchResourceFromServer(member, {
          noWebSocket: true,
        });
        const named: Record<string, unknown> = {};
        for (const [property, value] of Object.entries(item.getPropVals()))
          named[String((await short(property)) ?? property)] = value;
        if (named['google-keep-item-note'] !== noteSubject) continue;
        out.push({
          position: named['google-keep-position'] as number,
          line: `${named['google-keep-under'] ? '  ' : ''}${named['google-keep-done'] ? '[x]' : '[ ]'} ${named.name as string}`,
        });
      }
    }

    return out.sort((a, b) => a.position - b.position).map(o => o.line);
  }, note);
}

/** An item of a list note ticked in the drive, as a person would. */
async function tickItem(page: Page, note: string, text: string) {
  await page.evaluate(
    async a => {
      const store = window.store!;
      const P = 'https://atomicdata.dev/properties/';
      const row = await store.getResource(a.note);
      const klass = await store.getResource(
        (row.get(`${P}isA`) as string[])[0],
      );
      const ontology = await store.getResource(
        klass.get(`${P}parent`) as string,
      );
      const app = await store.getResource(ontology.get(`${P}parent`) as string);

      for (const child of await (
        await app.getChildrenCollection(500)
      ).getAllMembers()) {
        const items = await store.getResource(child);
        if (items.get(`${P}name`) !== 'Google Keep list items') continue;

        for (const member of await (
          await items.getChildrenCollection(500)
        ).getAllMembers()) {
          const item = await store.getResource(member);
          if (item.get(`${P}name`) !== a.text) continue;
          const props = Object.keys(item.getPropVals());
          if (!props.some(p => item.get(p) === a.note)) continue;

          for (const property of props)
            if (
              (await store.getResource(property)).get(`${P}shortname`) ===
              'google-keep-done'
            ) {
              await item.set(property, true);
              await item.save();

              return;
            }
        }
      }

      throw new Error(`No item ${a.text}`);
    },
    { note, text },
  );
}

/** One google-keep fixture driver on the mock proxy: someone working in Keep. */
async function fixture(name: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/fixture/google-keep/${name}`,
    {
      method: 'POST',
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  return response.json();
}

async function installFromCatalog(page: Page) {
  await page.goto(
    new URL('/app/integrations?preview=plugins', page.url()).href,
  );
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  await expect(experimental).toBeEnabled({ timeout: 30_000 });
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="google-keep"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Google Keep' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });
}
