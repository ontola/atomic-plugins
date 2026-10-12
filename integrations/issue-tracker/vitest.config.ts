const at = (relative: string) => new URL(relative, import.meta.url).pathname;

export default {
  root: at('.'),
  resolve: {
    alias: {
      vitest: at('../../browser/node_modules/vitest/dist/index.js'),
      // The lenses in devonian/github-issues/ and devonian/todoist/, and the
      // drive app (app/), import the npm `devonian` package, pinned in
      // app/package.json and installed in app/node_modules (`pnpm install
      // --frozen-lockfile` in app/; CI's "Install plugin npm dependencies"
      // does it). The lens folders have no package of their own, so their
      // bare specifiers are aliased to that install's compiled entry points:
      // tests, the app's bundle and the lenses all run the same published
      // devonian. Listed before `devonian`, which would otherwise match them
      // as a prefix.
      'devonian/atomic': at(
        'app/node_modules/devonian/build/src/atomic/index.js',
      ),
      'devonian/lenses': at(
        'app/node_modules/devonian/build/src/lenses/index.js',
      ),
      devonian: at('app/node_modules/devonian/build/src/main.js'),
      // devonian's @tomic/lib peer, and the host modules the lens was written
      // against (its consumer used to supply them), resolve to the symlinked
      // atomic-server checkout, like every other import under integrations/.
      '@tomic/lib': at('../../browser/lib/src/index.ts'),
      '@integration-host/import-records': at(
        '../../browser/lib/src/import-records.ts',
      ),
      '@integration-host/loro-loader': at(
        '../../browser/lib/src/loro-loader.ts',
      ),
      '@integration-host/plugin-connection': at(
        '../../browser/lib/src/plugin-connection.ts',
      ),
      '@integration-host/plugin-reconcile': at(
        '../../browser/lib/src/plugin-reconcile.ts',
      ),
      '@integration-host/plugin-manifest': at(
        '../../browser/lib/src/plugin-manifest.ts',
      ),
      '@integration-host/integration-automation': at(
        '../../browser/data-browser/src/chunks/PluginRuns/integrationAutomation.ts',
      ),
    },
  },
  test: {
    // The drive app imports its stylesheets as text (`./x.css?raw`);
    // Vitest otherwise empties every .css import, `?raw` included.
    css: true,
    // devonian/atomic's compiled JS imports @tomic/lib; inlining devonian
    // lets Vite apply the @tomic/lib alias above instead of Node loading it
    // from node_modules, where no built @tomic/lib is installed.
    server: { deps: { inline: [/[\\/]node_modules[\\/]devonian[\\/]/] } },
    include: [
      '*.test.ts',
      'app/**/*.test.ts',
      'todoist-app/**/*.test.ts',
      'devonian/**/*.test.{ts,mjs}',
      'fixtures/**/*.test.ts',
      // The live check's offline tests (the mock GitHub); never the live run.
      'live/*.test.ts',
      // The Todoist live check's offline tests (the mock Todoist fixture).
      'live/todoist/*.test.ts',
    ],
  },
};
