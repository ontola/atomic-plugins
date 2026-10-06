export default {
  root: new URL('.', import.meta.url).pathname,
  resolve: {
    alias: {
      vitest: new URL(
        '../../browser/node_modules/vitest/dist/index.js',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: [
      '*.test.ts',
      'app/*.test.ts',
      'app/ui/*.test.ts',
      'moneybird/*.test.ts',
      // The Moneybird live check's offline tests (the in-memory fake); never the live run.
      'live/*.test.ts',
    ],
    // moneybird/main.ts bundles the shared sync-status card, whose card.ts
    // imports card.css?raw; without this Vitest stubs CSS to ''.
    css: { include: [/card\.css/] },
  },
};
