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
      'core/*.test.ts',
      'shared/*.test.ts',
      'lens/*.test.ts',
      'magnet/*.test.ts',
      'spring/*.test.ts',
    ],
  },
};
