// @wc-ignore-file
const at = (relative: string) => new URL(relative, import.meta.url).pathname;

export default {
  root: at('.'),
  resolve: {
    alias: {
      vitest: at('../../browser/node_modules/vitest/dist/index.js'),
      'devonian/atomic': at('../../devonian/src/atomic/index.ts'),
      'devonian/lenses': at('../../devonian/src/lenses/index.ts'),
      '@tomic/lib': at('../../browser/lib/src/index.ts'),
    },
  },
  test: { include: ['devonian/**/*.test.ts'] },
};
