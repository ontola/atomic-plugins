export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // Same as integrations/timesheets/vitest.config.ts: the lens in
      // devonian/notion/, and the npm `devonian` it imports, use @tomic/lib
      // (devonian's optional peer, not installed here), which resolves to the
      // atomic-server checkout's source. `syncables` and `devonian` resolve
      // from this folder's node_modules (npm; `pnpm install` here).
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    include: [
      '*.test.ts',
      'app/**/*.test.ts',
      'host/*.test.ts',
      'devonian/**/*.test.ts',
      // The live check's offline tests (the mock Notion); never the live run.
      'live/*.test.ts',
    ],
    // The shared sync-status card (app/view/app.ts) imports card.css?raw;
    // without this Vitest stubs CSS to ''.
    css: { include: [/card\.css/] },
    // devonian 0.9.0's `devonian/atomic` is compiled JS that imports
    // @tomic/lib. Node would load it from node_modules directly, past the
    // alias above, and find no built @tomic/lib; inlining it lets Vite apply
    // the alias, as for this folder's own sources.
    server: { deps: { inline: ['devonian'] } },
  },
};
