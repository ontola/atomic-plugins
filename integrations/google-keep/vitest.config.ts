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
    include: ['app/*.test.ts', 'fixtures/**/*.test.ts'],
    // The shared sync-status card imports its stylesheet as text
    // (`card.css?raw`); Vitest otherwise empties every .css import.
    css: { include: [/card\.css/] },
  },
};
