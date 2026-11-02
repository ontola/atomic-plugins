// @wc-ignore-file
import { test, expect, type Page } from '@playwright/test';
import { before, waitForSynced } from '../../../browser/e2e/tests/test-utils';

async function install(page: Page, id: string, name: string) {
  await page.goto(
    new URL('/app/integrations?preview=plugins', page.url()).href,
  );
  await page
    .getByRole('checkbox', { name: 'Show experimental plugins' })
    .check();
  const card = page.locator(`[data-catalog-app="${id}"]`);
  await card.getByRole('button', { name: `Install ${name}` }).click();
  await expect(page.locator('iframe[title="App"]')).toBeVisible();
  const subject = new URL(page.url()).searchParams.get('subject');
  expect(subject).toBeTruthy();

  return subject!;
}

test.describe('Keep account folder', () => {
  test.beforeEach(before);
  test('keeps installations out of content and opens cards and a single collapsed checklist', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const sync = await install(page, 'google-keep', 'Google Keep');
    await expect(
      page
        .frameLocator('iframe[title="App"]')
        .getByRole('button', { name: 'Connect Google Keep' }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async app => {
          const store = window.store!;
          const P = 'https://atomicdata.dev/properties/';
          const resource = await store.getResource(app);

          for (const id of resource.getSubjects(P + 'isA')) {
            const klass = await store.getResource(id);

            for (const property of klass.getSubjects(P + 'recommends')) {
              const term = await store.getResource(property);
              if (term.get(P + 'shortname') !== 'app-data') continue;
              const folder = await store.getResource(
                String(resource.get(property)),
              );
              const noteClass = await store.getResource(
                String(folder.get(P + 'classtype')),
              );

              return noteClass.get(P + 'shortname');
            }
          }
        }, sync),
      )
      .toBe('google-keep-note');
    const seeded = await page.evaluate(async app => {
      const store = window.store!;
      const P = 'https://atomicdata.dev/properties/';
      const resource = await store.getResource(app);
      const terms: Record<string, string> = {};

      for (const id of resource.getSubjects(P + 'isA')) {
        const klass = await store.getResource(id);

        for (const property of klass.getSubjects(P + 'recommends')) {
          const term = await store.getResource(property);
          terms[String(term.get(P + 'shortname'))] = property;
        }
      }

      const folder = await store.getResource(
        String(resource.get(terms['app-data'])),
      );
      const noteClass = await store.getResource(
        String(folder.get(P + 'classtype')),
      );
      const ontology = await store.getResource(
        String(noteClass.get(P + 'parent')),
      );
      const fields: Record<string, string> = {};

      for (const property of ontology.getSubjects(P + 'properties')) {
        const term = await store.getResource(property);
        fields[String(term.get(P + 'shortname'))] = property;
      }

      folder.set(P + 'name', 'Google Keep michiel@example.com');
      await folder.save();
      resource.set(fields['google-keep-account'], 'michiel@example.com');
      await resource.save();
      let itemClass = '';

      for (const id of ontology.getSubjects(P + 'classes')) {
        const klass = await store.getResource(id);
        if (klass.get(P + 'shortname') === 'google-keep-item') itemClass = id;
      }

      const tables = await store.search('Google Keep list items', {
        parents: [app],
        serverOnly: true,
        limit: 20,
      });
      let itemTable = '';

      for (const id of tables) {
        const table = await store.getResource(id);
        if (table.get(P + 'classtype') === itemClass) itemTable = id;
      }

      if (!itemTable) throw new Error('Keep did not provision its item table');
      const note = await store.newResource({
        parent: folder.subject,
        isA: [noteClass.subject],
        propVals: {
          [P + 'name']: 'Invented groceries',
          [fields['google-keep-kind']]: 'list',
          [fields['google-keep-presence']]: 'present',
        },
      });
      await note.save();

      for (const [position, name, done] of [
        [0, 'Imaginary apples', true],
        [1, 'Fictional bread', false],
        [2, 'Pretend jam', true],
        [3, '', false],
      ] as const) {
        const item = await store.newResource({
          parent: itemTable,
          isA: [itemClass],
          propVals: {
            [P + 'name']: name,
            [fields['google-keep-item-note']]: note.subject,
            [fields['google-keep-done']]: done,
            [fields['google-keep-position']]: position,
          },
        });
        await item.save();
      }

      const other = await store.newResource({
        parent: folder.subject,
        isA: [noteClass.subject],
        propVals: {
          [P + 'name']: 'Invented travel note',
          [P + 'description']: 'Bring an imaginary notebook.',
          [fields['google-keep-kind']]: 'text',
        },
      });
      await other.save();

      return {
        folder: folder.subject,
        note: note.subject,
        other: other.subject,
        renderer: terms['app-resource-view'],
        accountProperty: fields['google-keep-account'],
      };
    }, sync);
    await waitForSynced(page);
    await expect
      .poll(() =>
        page.evaluate(
          async ({ app, property }) => {
            const resource = await window.store!.fetchResourceFromServer(app, {
              noWebSocket: true,
            });

            return resource.get(property);
          },
          { app: sync, property: seeded.accountProperty },
        ),
      )
      .toBe('michiel@example.com');
    const view = await install(page, 'google-keep-view', 'Google Keep View');
    await expect(
      page
        .frameLocator('iframe[title="App"]')
        .getByRole('heading', { name: 'Google Keep', exact: true }),
    ).toBeVisible();
    // Installing a view after notes exist must make card navigation work
    // even while the sync settings page is closed.
    await page.goto(
      new URL(
        '/app/show?subject=' + encodeURIComponent(seeded.folder),
        page.url(),
      ).href,
    );
    const firstView = page.frameLocator('iframe[title="App"]');
    await expect(firstView.getByRole('article')).toHaveCount(2);
    await firstView
      .getByRole('article', { name: 'Invented groceries' })
      .getByRole('button', { name: 'Open note' })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('subject'))
      .toBe(seeded.note);
    await expect(firstView.getByRole('article')).toHaveCount(1);
    // Reopen the sync settings once: it registers the newly installed renderer
    // on the account folder and existing note resources without copying them.
    await page.goto(
      new URL('/app/show?subject=' + encodeURIComponent(sync), page.url()).href,
    );
    await expect
      .poll(() =>
        page.evaluate(async ({ folder, note, renderer }) => {
          const P = 'https://atomicdata.dev/properties/';
          const f = await window.store!.getResource(folder);
          const n = await window.store!.getResource(note);

          return {
            name: f.get(P + 'name'),
            folderView: f.get(renderer),
            noteView: n.get(renderer),
          };
        }, seeded),
      )
      .toEqual({
        name: 'Google Keep michiel@example.com',
        folderView: view,
        noteView: view,
      });
    await waitForSynced(page);
    await page.goto(
      new URL(
        '/app/show?subject=' + encodeURIComponent(seeded.folder),
        page.url(),
      ).href,
    );
    const frame = page.frameLocator('iframe[title="App"]');
    await expect(frame.getByRole('article')).toHaveCount(2);
    await expect(
      frame
        .getByRole('article', { name: 'Invented groceries' })
        .getByText('2 completed items'),
    ).toBeVisible();
    const navigation = page.getByRole('navigation').last();
    await expect(navigation).toBeVisible();
    await expect(
      navigation.getByRole('button', { name: 'Google Keep View', exact: true }),
    ).toHaveCount(0);
    await expect(
      navigation.getByRole('button', { name: 'Google Keep', exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath('keep-account-folder.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await frame
      .getByRole('article', { name: 'Invented groceries' })
      .getByRole('button', { name: 'Open note' })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('subject'))
      .toBe(seeded.note);
    await expect(frame.getByRole('article')).toHaveCount(1);
    await expect(
      frame.getByRole('article', { name: 'Invented groceries' }),
    ).toBeVisible();
    await expect(frame.getByText('2 completed items')).toBeVisible();
    await expect(
      frame.getByRole('checkbox', { name: 'Imaginary apples' }),
    ).toBeHidden();
    await frame.getByText('2 completed items').click();
    await expect(
      frame.getByRole('checkbox', { name: 'Imaginary apples' }),
    ).toBeVisible();
    await frame.getByText('2 completed items').click();
    await page.screenshot({
      path: test.info().outputPath('keep-single-note.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: /Show \/ hide sidebar/ }).click();
    await expect
      .poll(
        async () =>
          (await page.locator('iframe[title="App"]').boundingBox())?.width ?? 0,
      )
      .toBeGreaterThan(300);
    await page.screenshot({
      path: test.info().outputPath('keep-single-note-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
  });
});
