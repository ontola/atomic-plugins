import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadLanes,
  validateConfig,
  lanePorts,
  sharedPorts,
  activeLanes,
  unlanedDirectories,
  danglingLanes,
  laneFilter,
  laneDir,
  filtersYaml,
  matrixFor,
  needsPluginRoutesBuild,
  pluginRoutesLevels,
  sidecarsFor,
  sidecarDockerfile,
  sidecarImageEnv,
  root,
  PLUGIN_BUILD_DEPENDENCIES,
  ROUTE_INSTALL_HELPER,
  SHARED_PACKAGES,
} from './lanes.mjs';

const config = loadLanes();

// The case that would have caught integrations/calendar/ shipping without a
// path filter: a new plugin directory with no lane is invisible to CI.
test('every plugin directory has a lane', () => {
  assert.deepEqual(
    unlanedDirectories(config.lanes),
    [],
    'add these to integrations/lanes.json',
  );
});

test('unlanedDirectories skips gitignored output but reports a real unlaned plugin', () => {
  const base = mkdtempSync(join(tmpdir(), 'lanes-'));

  try {
    spawnSync('git', ['init', '-q'], { cwd: base });
    writeFileSync(join(base, '.gitignore'), 'playwright-report/\n');
    for (const d of ['pets', 'playwright-report', 'newplugin'])
      mkdirSync(join(base, 'integrations', d), { recursive: true });

    assert.deepEqual(unlanedDirectories([{ id: 'pets' }], base), ['newplugin']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('every lane names a directory that exists', () => {
  assert.deepEqual(danglingLanes(config.lanes), []);
});

test('lane port blocks never overlap', () => {
  const seen = new Map();

  for (const lane of config.lanes)
    for (const [role, port] of Object.entries(lanePorts(lane, config))) {
      const owner = seen.get(port);
      assert.equal(
        owner,
        undefined,
        `port ${port} claimed by both ${owner} and ${lane.id}:${role}`,
      );
      seen.set(port, `${lane.id}:${role}`);
    }
});

// The non-lane CI jobs run beside the lanes, so their block must be disjoint.
test('the shared block collides with no lane', () => {
  const shared = new Set(Object.values(sharedPorts(config)));
  for (const lane of config.lanes)
    for (const port of Object.values(lanePorts(lane, config)))
      assert.ok(!shared.has(port), `${lane.id} derives shared port ${port}`);
});

test('a lane may not claim the reserved shared index', () => {
  assert.throws(
    () => validateConfig({ ...cfg(lane({ index: 9 })), sharedIndex: 9 }),
    /reserved for the non-lane CI jobs/,
  );
});

test('declared e2e specs exist', () => {
  for (const lane of config.lanes)
    for (const spec of lane.e2e ?? [])
      assert.ok(existsSync(resolve(root, spec)), `missing spec ${spec}`);
});

test('a lane declaring typecheck or unit has the config that tier runs', () => {
  for (const lane of config.lanes) {
    if (lane.tiers.includes('typecheck'))
      assert.ok(
        existsSync(resolve(root, `${laneDir(lane)}/tsconfig.json`)),
        `${lane.id} declares typecheck but has no tsconfig.json`,
      );
    if (lane.tiers.includes('unit') || lane.tiers.includes('live'))
      assert.ok(
        existsSync(resolve(root, `${laneDir(lane)}/vitest.config.ts`)),
        `${lane.id} declares unit/live but has no vitest.config.ts`,
      );
  }
});

test('a lane filter covers its own directory and only explicit sibling dependencies', () => {
  for (const lane of config.lanes) {
    // A tooling lane names its files; none of them is a plugin's. It may
    // also depend on a shared package (the `ontology` lane on ontology/).
    if (lane.dir) {
      for (const path of laneFilter(lane))
        assert.ok(
          path === '.atomic-server-ref' ||
            SHARED_PACKAGES.some(pkg => path.startsWith(`${pkg}/`)) ||
            (path.startsWith('integrations/tooling/') &&
              path !== 'integrations/tooling/**'),
          `${lane.id} claims ${path}`,
        );
      continue;
    }

    const [own, ...extra] = laneFilter(lane);
    assert.equal(own, `integrations/${lane.id}/**`);
    // Under integrations/ a lane may claim only its declared build
    // dependency or a shared package that lives there (sync-status, Q-084),
    // never another plugin's folder.
    for (const path of extra)
      assert.ok(
        !path.startsWith('integrations/') ||
          PLUGIN_BUILD_DEPENDENCIES[lane.id]?.includes(path) ||
          SHARED_PACKAGES.some(pkg => path.startsWith(`${pkg}/`)),
        `${lane.id} claims ${path}`,
      );
  }
});

const lane = (over = {}) => ({ id: 'a', index: 0, tiers: [], ...over });

test('activeLanes drops tier-less lanes', () => {
  // Synthetic, not a real lane: which real lanes have tiers changes when one
  // gains its first tier (money did, for #95).
  assert.deepEqual(
    activeLanes([
      lane({ id: 'idle' }),
      lane({ id: 'busy', tiers: ['unit'] }),
    ]).map(l => l.id),
    ['busy'],
  );
});
const cfg = (...lanes) => ({ portBase: 19100, sharedIndex: 9, lanes });

test('duplicate indexes are rejected, and the message names both lanes', () => {
  assert.throws(
    () => validateConfig(cfg(lane(), lane({ id: 'b' }))),
    /duplicate lane index 0 \(a and b\)/,
  );
});

test('duplicate ids are rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane(), lane({ index: 1 }))),
    /duplicate lane id: a/,
  );
});

test('an unknown tier is rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['smoke'] }))),
    /unknown tier smoke/,
  );
});

test('an e2e tier without a spec list is rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['e2e'] }))),
    /needs an e2e spec list/,
  );
  assert.doesNotThrow(() =>
    validateConfig(cfg(lane({ tiers: ['e2e'], e2e: ['x.spec.ts'] }))),
  );
});

test('a live tier without a liveEnv is rejected', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['live'] }))),
    /needs a liveEnv name/,
  );
});

test('lane paths are limited to shared packages', () => {
  assert.deepEqual(laneFilter(lane({ paths: ['devonian/src/**'] })), [
    'integrations/a/**',
    'devonian/src/**',
  ]);
  assert.throws(
    () => validateConfig(cfg(lane({ paths: ['integrations/b/**'] }))),
    /not in a shared package/,
  );
  assert.throws(
    () => validateConfig(cfg(lane({ paths: 'devonian/**' }))),
    /paths must be an array/,
  );
});

test('the shared route-install e2e helper is listed by exactly the lanes that import it', () => {
  const importers = config.lanes
    .filter(l => laneFilter(l).includes(ROUTE_INSTALL_HELPER))
    .map(l => l.id)
    .sort();
  const expected = [
    'atproto',
    'fediverse',
    'open-cloud-mesh',
    'remotestorage',
    'solid',
    'willow',
    'willow-drop',
  ];
  assert.deepEqual(importers, expected);

  for (const id of expected) {
    const dir = resolve(root, `integrations/${id}/e2e`);
    const text = readdirSync(dir)
      .filter(f => f.endsWith('.ts'))
      .map(f => readFileSync(resolve(dir, f), 'utf8'))
      .join('\n');
    assert.match(text, /tooling\/e2e\/route-install/, id);
  }

  assert.throws(
    () =>
      validateConfig(cfg(lane({ id: 'pets', paths: [ROUTE_INSTALL_HELPER] }))),
    /not in a shared package/,
  );
});

test('Willow WILLIAM3 dependency is exact, lane-specific and included in CI filters', () => {
  const path = 'integrations/willow-drop/william3.ts';
  const approved = lane({ id: 'willow', paths: [path] });
  assert.doesNotThrow(() => validateConfig(cfg(approved)));
  assert.ok(laneFilter(approved).includes(path));
  assert.match(
    filtersYaml(cfg(approved)),
    /integrations\/willow-drop\/william3\.ts/,
  );
  for (const wrong of [
    lane({ id: 'other', paths: [path] }),
    lane({ id: 'willow', paths: ['integrations/willow-drop/**'] }),
    lane({ id: 'willow', paths: ['integrations/willow-drop/drop.ts'] }),
  ])
    assert.throws(() => validateConfig(cfg(wrong)), /not in a shared package/);
});

// build-server, which every lane job needs, runs only when `any` matched, so
// a change to a lane's shared-package path must match `any` as well.
test('lane paths are also in the any filter', () => {
  const yaml = filtersYaml(cfg(lane({ paths: ['devonian/src/**'] })));
  const any = yaml.slice(yaml.indexOf('any:'));
  assert.match(any, /- 'devonian\/src\/\*\*'/);
});

test('node tiers require explicit plugin-owned test files', () => {
  assert.throws(
    () => validateConfig(cfg(lane({ tiers: ['node'] }))),
    /nodeTests/,
  );
  for (const path of [
    'integrations/b/x.test.mjs',
    'integrations/a/../b/x.test.mjs',
    'integrations/a/*.test.mjs',
    'integrations/a/source.mjs',
  ])
    assert.throws(
      () => validateConfig(cfg(lane({ tiers: ['node'], nodeTests: [path] }))),
      /nodeTests/,
    );
  assert.doesNotThrow(() =>
    validateConfig(
      cfg(lane({ tiers: ['node'], nodeTests: ['integrations/a/x.test.mjs'] })),
    ),
  );
});

test('node suite paths exist in every declared lane', () => {
  for (const entry of config.lanes)
    for (const path of entry.nodeTests ?? [])
      assert.ok(existsSync(resolve(root, path)), `missing test suite ${path}`);
});

test('a tooling lane owns integrations/tooling or a directory under it', () => {
  assert.equal(laneDir(lane()), 'integrations/a');
  assert.equal(
    laneDir(lane({ dir: 'integrations/tooling' })),
    'integrations/tooling',
  );
  const paths = ['integrations/tooling/x.mjs'];
  for (const dir of ['integrations/tooling', 'integrations/tooling/fixtures/x'])
    assert.doesNotThrow(() => validateConfig(cfg(lane({ dir, paths }))));
  for (const dir of [
    'integrations/pets',
    'integrations/toolingx',
    'integrations/tooling/../pets',
    7,
  ])
    assert.throws(
      () => validateConfig(cfg(lane({ dir, paths }))),
      /dir must be integrations\/tooling or a directory under it/,
    );
});

test('a tooling lane lists its own paths, and only tooling files, the pin and shared packages', () => {
  const dir = 'integrations/tooling';
  assert.throws(
    () => validateConfig(cfg(lane({ dir }))),
    /must list the paths it depends on/,
  );
  assert.doesNotThrow(() =>
    validateConfig(
      cfg(
        lane({
          dir,
          paths: [
            'integrations/tooling/serve.mjs',
            '.atomic-server-ref',
            'devonian/src/**',
          ],
        }),
      ),
    ),
  );
  for (const path of ['integrations/pets/**', 'integrations/tooling/../pets/x'])
    assert.throws(
      () => validateConfig(cfg(lane({ dir, paths: [path] }))),
      /not in a shared package/,
    );
  // A plugin lane still may not name tooling files.
  assert.throws(
    () =>
      validateConfig(cfg(lane({ paths: ['integrations/tooling/serve.mjs'] }))),
    /not in a shared package/,
  );
  assert.deepEqual(
    laneFilter(lane({ dir, paths: ['integrations/tooling/serve.mjs'] })),
    ['integrations/tooling/serve.mjs'],
  );
});

test('shared changes select plugin lanes only; a tooling lane needs its own paths or `all`', () => {
  const tooling = lane({
    id: 'tool',
    index: 1,
    dir: 'integrations/tooling',
    paths: ['integrations/tooling/serve.mjs'],
    tiers: ['e2e'],
    e2e: ['x.spec.ts'],
  });
  const plugin = lane({ id: 'plain', tiers: ['unit'] });
  const both = cfg(plugin, tooling);
  const ids = changed => matrixFor(both, changed).map(l => l.lane);

  assert.deepEqual(ids(['shared']), ['plain']);
  assert.deepEqual(ids(['shared', 'tool']), ['plain', 'tool']);
  assert.deepEqual(ids(['shared', 'all']), ['plain', 'tool']);
  assert.deepEqual(ids(['tool']), ['tool']);
});

test('pluginRoutes takes one level or a list of distinct levels, for live or e2e tiers', () => {
  const e2e = { tiers: ['e2e'], e2e: ['x.spec.ts'] };
  assert.deepEqual(pluginRoutesLevels(lane()), []);
  assert.deepEqual(pluginRoutesLevels(lane({ pluginRoutes: 'read-only' })), [
    'read-only',
  ]);
  assert.deepEqual(
    pluginRoutesLevels(lane({ pluginRoutes: ['off', 'read-write'] })),
    ['off', 'read-write'],
  );
  for (const pluginRoutes of ['read-only', ['off', 'read-only']])
    assert.doesNotThrow(() =>
      validateConfig(cfg(lane({ ...e2e, pluginRoutes }))),
    );
  for (const pluginRoutes of ['on', [], ['off', 'off'], ['read-only', 'rw']])
    assert.throws(
      () => validateConfig(cfg(lane({ ...e2e, pluginRoutes }))),
      /pluginRoutes must be one of off, read-only, read-write/,
    );
  assert.throws(
    () =>
      validateConfig(cfg(lane({ tiers: ['unit'], pluginRoutes: 'read-only' }))),
    /only affects the live and e2e tiers/,
  );
});

test('serverEnv maps ATOMIC_* names to strings, never the reserved ones, for live or e2e tiers', () => {
  const e2e = { tiers: ['e2e'], e2e: ['x.spec.ts'] };
  for (const serverEnv of [
    { ATOMIC_PLUGIN_E2E_LOOPBACK_PEERS: 'true' },
    { ATOMIC_SOLID_OIDC_ISSUERS: 'http://127.0.0.1:{mockProxy}' },
  ])
    assert.doesNotThrow(
      () => validateConfig(cfg(lane({ ...e2e, serverEnv }))),
      JSON.stringify(serverEnv),
    );
  for (const serverEnv of [
    {},
    [],
    'ATOMIC_PLUGIN_E2E_X',
    { SOLID_ISSUER: 'x' },
    { atomic_x: 'y' },
    { ATOMIC_PLUGIN_ROUTES: 'read-write' },
    { ATOMIC_DATA_DIR: '/tmp' },
    { ATOMIC_PORT: '1' },
    { ATOMIC_PLUGIN_E2E_X: true },
  ])
    assert.throws(
      () => validateConfig(cfg(lane({ ...e2e, serverEnv }))),
      /serverEnv maps ATOMIC_\* names to strings/,
      JSON.stringify(serverEnv),
    );
  assert.throws(
    () =>
      validateConfig(
        cfg(lane({ tiers: ['unit'], serverEnv: { ATOMIC_PLUGIN_E2E_X: '1' } })),
      ),
    /serverEnv only affects the live and e2e tiers/,
  );
});

test('only a run with a pluginRoutes lane asks for the plugin-routes build', () => {
  const routes = lane({
    id: 'routes',
    index: 1,
    tiers: ['e2e'],
    e2e: ['x.spec.ts'],
    pluginRoutes: 'read-only',
  });
  const plain = lane({ id: 'plain', tiers: ['unit'] });
  const both = cfg(plain, routes);

  assert.deepEqual(matrixFor(both, ['plain']), [
    { lane: 'plain', tiers: 'unit' },
  ]);
  assert.deepEqual(matrixFor(both, ['routes']), [
    { lane: 'routes', tiers: 'e2e', 'plugin-routes': 'true' },
  ]);
  assert.equal(needsPluginRoutesBuild(both, ['plain']), false);
  assert.equal(needsPluginRoutesBuild(both, ['routes']), true);
  assert.equal(needsPluginRoutesBuild(both, ['shared']), true);
  assert.equal(needsPluginRoutesBuild(both, ['all']), true);
  assert.equal(needsPluginRoutesBuild(both, []), false);
});

test('sidecars need read-write and one name, at the lane sidecar port', () => {
  const e2e = { tiers: ['e2e'], e2e: ['integrations/p/e2e/p.spec.ts'] };
  const ported = l => ({
    ...cfg(l),
    roleOffsets: { atomicServer: 0, sidecar: 3 },
  });
  const ok = lane({
    ...e2e,
    pluginRoutes: 'read-write',
    sidecars: ['nextgraph'],
  });
  assert.doesNotThrow(() => validateConfig(ported(ok)));
  assert.throws(() => validateConfig(cfg(ok)), /roleOffsets.sidecar/);
  for (const [extra, message] of [
    [{ pluginRoutes: 'read-only', sidecars: ['nextgraph'] }, /read-write/],
    [{ sidecars: ['nextgraph'] }, /read-write/],
    [{ pluginRoutes: 'read-write', sidecars: [] }, /one sidecar name/],
    [{ pluginRoutes: 'read-write', sidecars: ['Next'] }, /one sidecar name/],
    [{ pluginRoutes: 'read-write', sidecars: ['a', 'b'] }, /one sidecar name/],
  ])
    assert.throws(
      () => validateConfig(ported(lane({ ...e2e, ...extra }))),
      message,
    );
  const ng = config.lanes.find(l => l.id === 'nextgraph');
  assert.deepEqual(ng.sidecars, ['nextgraph']);
  assert.equal(
    lanePorts(ng, config).sidecar,
    lanePorts(ng, config).atomicServer + 3,
  );
});

// ci.yml's build-sidecars builds each sidecar from this Dockerfile before the
// lane runs, and the lane hands the image to the spec in this variable. A
// lane naming a sidecar with no recipe would only fail in CI.
test('each declared sidecar has an image recipe, and its spec reads the prebuilt image', () => {
  const declared = [...new Set(config.lanes.flatMap(l => l.sidecars ?? []))];
  assert.ok(declared.length > 0);

  for (const name of declared) {
    assert.ok(
      existsSync(sidecarDockerfile(name)),
      `no ${sidecarDockerfile(name)}`,
    );
    for (const withSidecar of config.lanes.filter(l =>
      l.sidecars?.includes(name),
    ))
      for (const spec of withSidecar.e2e ?? [])
        assert.match(
          readFileSync(resolve(root, spec), 'utf8'),
          new RegExp(`process\\.env\\.${sidecarImageEnv(name)}\\b`),
          `${spec} does not read ${sidecarImageEnv(name)}`,
        );
  }

  assert.equal(sidecarImageEnv('nextgraph'), 'NEXTGRAPH_SIDECAR_IMAGE');
  assert.equal(sidecarImageEnv('my-store'), 'MY_STORE_SIDECAR_IMAGE');
});

test('the matrix names each lane sidecar, and the sidecar build list follows it', () => {
  const e2e = { tiers: ['e2e'], e2e: ['integrations/p/e2e/p.spec.ts'] };
  const both = {
    ...cfg(
      lane({ id: 'plain', ...e2e }),
      lane({
        id: 'ng',
        ...e2e,
        pluginRoutes: 'read-write',
        sidecars: ['nextgraph'],
      }),
      lane({
        id: 'ng2',
        ...e2e,
        pluginRoutes: 'read-write',
        sidecars: ['nextgraph'],
      }),
    ),
    roleOffsets: { atomicServer: 0, sidecar: 3 },
  };
  assert.deepEqual(
    matrixFor(both, ['ng']).map(l => l.sidecars),
    ['nextgraph'],
  );
  assert.equal(matrixFor(both, ['plain'])[0].sidecars, undefined);
  assert.deepEqual(sidecarsFor(both, ['all']), ['nextgraph']);
  assert.deepEqual(sidecarsFor(both, ['plain']), []);
  assert.deepEqual(sidecarsFor(config, ['nextgraph']), ['nextgraph']);
});

test('the plugin-routes lane runs its e2e at read-only, then off', () => {
  const routes = config.lanes.find(l => l.id === 'plugin-routes');
  // read-only first: the off run checks that its installation is degraded.
  assert.deepEqual(pluginRoutesLevels(routes), ['read-only', 'off']);
  assert.equal(laneDir(routes), 'integrations/tooling');
  assert.deepEqual(routes.platforms, []);
  // Not every tooling change: only what the lane depends on.
  assert.ok(!laneFilter(routes).includes('integrations/tooling/**'));
  for (const path of [
    'integrations/tooling/e2e/plugin-routes.spec.ts',
    'integrations/tooling/server-build.mjs',
    '.atomic-server-ref',
  ])
    assert.ok(laneFilter(routes).includes(path), path);
  // A shared change runs every plugin lane (remotestorage needs the build
  // too), but not this tooling lane.
  assert.ok(
    !matrixFor(config, ['shared']).some(l => l.lane === 'plugin-routes'),
  );
  assert.equal(
    needsPluginRoutesBuild(config, ['shared']),
    config.lanes.some(l => !l.dir && pluginRoutesLevels(l).length > 0),
  );
  assert.equal(needsPluginRoutesBuild(config, ['shared', 'all']), true);
});
