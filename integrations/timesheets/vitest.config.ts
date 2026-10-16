export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      // The Clockify lens in devonian/clockify/ imports the npm `devonian`
      // package, pinned in app/package.json and installed in app/node_modules
      // (CI's "Install plugin npm dependencies"). The drive app does not
      // import it, so its bundle is unaffected.
      'devonian/lenses': new URL(
        'app/node_modules/devonian/build/src/lenses/index.js',
        import.meta.url,
      ).pathname,
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
      // The Clockify lens in devonian/clockify/ is written against devonian's
      // @tomic/lib peer dependency, which is only installed inside devonian's
      // own workspace. Reached from here it resolves to the symlinked
      // atomic-server checkout, the same source every other package under
      // integrations/ imports by relative path. Mirrored by `paths` in
      // tsconfig.json.
      '@tomic/lib': new URL('../../browser/lib/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    include: [
      '*.test.ts',
      'app/**/*.test.ts',
      'devonian/**/*.test.ts',
      // The live check's offline tests (the mock Clockify); never the live run.
      'live/*.test.ts',
    ],
    // app/ui/theme.ts imports theme.css?raw and the shared sync-status
    // card's card.css?raw; without this Vitest stubs CSS.
    css: { include: [/theme\.css/, /card\.css/] },
  },
};
