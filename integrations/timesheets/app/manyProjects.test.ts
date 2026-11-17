// @wc-ignore-file
/**
 * A workspace with many projects (README, "Not tried: a drive with many
 * projects"). Each sync makes or finds one Projects row per active Clockify
 * project and renames it where Clockify's name differs (sync.ts
 * `projectRows`, links.ts `ensure`). This pins what that costs at
 * `PROJECT_COUNT` projects against the in-memory fake host: the project list
 * pages, one id lookup and one read per project per sync, and a save only
 * for a renamed one. Not tried against a real host or real Clockify.
 */
import { describe, expect, it } from 'vitest';
import {
  PROJECT,
  PROJECT_2,
  USER,
  WORKSPACE,
} from '../fixtures/clockify/scenario.mjs';
import { PAGE_SIZE } from './clockifyApi.js';
import { createController } from './controller.js';
import { APP, fakeStore } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { ensureSchema } from './schema.js';
import type { HostProxyRequest, PluginStore } from './store.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const PROJECT_COUNT = 300;

const hex24 = (n: number) => n.toString(16).padStart(24, '0');

/** The fixture's two projects (its entries use them), then made-up ones. */
const projects = [
  PROJECT,
  PROJECT_2,
  ...Array.from({ length: PROJECT_COUNT - 2 }, (_, i) => ({
    id: hex24(i + 1),
    name: `Project ${i + 1}`,
    color: '#336699',
    clientName: 'Test client',
  })),
];

/** The fixture proxy, with `GET …/projects` paged over `projects`. */
function proxyWithProjects() {
  const base = fixtureProxy(NOW);
  const projectPages: number[] = [];

  const request = async (req: HostProxyRequest) => {
    if (
      (req.method ?? 'GET') === 'GET' &&
      req.path === `/api/v1/workspaces/${WORKSPACE.id}/projects`
    ) {
      const page = Number(req.query?.page ?? 1);
      const size = Number(req.query?.['page-size'] ?? PAGE_SIZE);
      projectPages.push(page);

      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: projects.slice((page - 1) * size, page * size),
      };
    }

    return base.request(req);
  };

  return { request, projectPages };
}

/** The store, counting the lookups and reads the sync makes. */
function counting(store: PluginStore) {
  const ids = new Set(projects.map(p => p.id));
  const counts = { idQueries: 0, projectReads: 0 };
  /** The Projects rows, once the first sync made them. */
  const projectRows = new Set<string>();
  const counted: PluginStore = {
    ...store,
    query: async q => {
      if (typeof q.value === 'string' && ids.has(q.value)) counts.idQueries++;

      return store.query(q);
    },
    getResource: async subject => {
      if (projectRows.has(subject)) counts.projectReads++;

      return store.getResource(subject);
    },
  };

  return { counted, counts, projectRows };
}

describe(`a workspace with ${PROJECT_COUNT} projects`, () => {
  it('makes one Projects row each, then on a later sync looks each up once and saves only the renamed ones', async () => {
    const proxy = proxyWithProjects();
    const store = fakeStore({ proxy: proxy.request });
    const schema = await ensureSchema(store);
    const app = await store.getResource(APP);
    app.set(schema.settings.workspaceId, WORKSPACE.id);
    app.set(schema.settings.userId, USER.id);
    app.set(schema.settings.lookbackDays, 30);
    await app.save();
    const { counted, counts, projectRows } = counting(store);
    const controller = createController(
      counted,
      () => {},
      () => NOW,
    );

    // First sync: every page of 50, then the short (empty) one.
    const { syncing } = await controller.load();
    await syncing;
    expect(controller.state()).toMatchObject({
      kind: 'ready',
      last: { ok: true },
    });
    expect(proxy.projectPages).toEqual(
      Array.from({ length: PROJECT_COUNT / PAGE_SIZE + 1 }, (_, i) => i + 1),
    );
    const table = (await ensureSchema(store)).tables.projects!;
    const rows = () =>
      [...store.resources].filter(
        ([, r]) => r['https://atomicdata.dev/properties/parent'] === table,
      );
    expect(rows()).toHaveLength(PROJECT_COUNT);
    expect(
      store.writes.filter(
        w => w.op === 'create' && rows().some(([s]) => s === w.subject),
      ),
    ).toHaveLength(PROJECT_COUNT);

    // Clockify renames three projects; nothing else changes.
    projects[2] = { ...projects[2]!, name: 'Project 1, renamed' };
    projects[150] = { ...projects[150]!, name: 'Project 149, renamed' };
    projects[299] = { ...projects[299]!, name: 'Project 298, renamed' };
    const renamed = new Set([
      projects[2]!.id,
      projects[150]!.id,
      projects[299]!.id,
    ]);
    proxy.projectPages.length = 0;
    for (const [subject] of rows()) projectRows.add(subject);
    counts.idQueries = 0;
    counts.projectReads = 0;
    const before = store.writes.length;

    await controller.sync();

    expect(controller.state()).toMatchObject({
      kind: 'ready',
      last: { ok: true },
    });
    expect(proxy.projectPages).toHaveLength(PROJECT_COUNT / PAGE_SIZE + 1);
    // One id lookup per project per sync; entries reuse it.
    expect(counts.idQueries).toBe(PROJECT_COUNT);
    // One read per project row to find it, and one more for each rename.
    expect(counts.projectReads).toBe(PROJECT_COUNT + renamed.size);
    expect(rows()).toHaveLength(PROJECT_COUNT);
    const saved = store.writes
      .slice(before)
      .filter(w => rows().some(([s]) => s === w.subject));
    expect(saved.every(w => w.op === 'save')).toBe(true);
    // A save only for a renamed project, each once.
    const idOf = (subject: string) =>
      Object.values(store.resources.get(subject)!).find(
        v => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v),
      );
    expect(new Set(saved.map(w => idOf(w.subject)))).toEqual(renamed);
    expect(saved).toHaveLength(renamed.size);
    for (const [, row] of rows())
      if (
        renamed.has(
          String(
            Object.values(row).find(
              v => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v),
            ),
          ),
        )
      )
        expect(String(row['https://atomicdata.dev/properties/name'])).toMatch(
          /renamed$/,
        );
    if (process.env.PROJECT_STATS)
      console.info(JSON.stringify({ ...counts, saves: saved.length }));
  }, 120_000);
});
