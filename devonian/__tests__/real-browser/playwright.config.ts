import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser checks (#259 item 5): Chromium in its new headless mode
 * (`channel: 'chromium'`, the full browser `playwright install chromium`
 * fetches). The separate headless shell, Playwright's default, answers
 * "Background Sync is disabled" to `registration.sync.register`. Run after
 * `pnpm build` with `pnpm run test:real-browser`; the specs bundle the
 * compiled build/ (DEVONIAN_TEST_BUILD=1). Each spec serves its own pages on
 * 127.0.0.1 with an OS-chosen port.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  outputDir: '../../tmp/real-browser',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: true,
        channel: 'chromium',
      },
    },
  ],
});
