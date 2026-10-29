// @wc-ignore-file
/** Standalone synthetic browser check; does not start or use atomic-server. */
import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  grep: /synthetic Keep view/,
  outputDir: '../tooling/test-results/google-keep-view',
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
        (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
    },
  },
});
