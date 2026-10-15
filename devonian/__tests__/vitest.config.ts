import {
  configDefaults,
  coverageConfigDefaults,
  defineConfig,
} from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'build/**/*',
      // Playwright specs: `pnpm run test:real-browser`.
      '__tests__/real-browser/**',
    ],
    coverage: {
      provider: 'v8',
      exclude: [...coverageConfigDefaults.exclude, 'build/**/*'],
    },
  },
});
