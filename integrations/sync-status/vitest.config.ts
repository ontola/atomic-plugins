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
    include: ['*.test.ts'],
    // card.ts imports card.css?raw; without this Vitest stubs CSS to ''.
    css: { include: [/card\.css/] },
  },
};
