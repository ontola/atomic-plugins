#!/usr/bin/env bash
set -euo pipefail

playwright=browser/e2e/node_modules/.bin/playwright
"$playwright" install chromium

# Hosted runners usually have the shared libraries Chromium needs. Prove
# that the pinned browser launches before depending on the Ubuntu mirrors.
check_chromium() {
  node <<'NODE'
const { chromium } = require('./browser/e2e/node_modules/@playwright/test');

async function check() {
  const browser = await chromium.launch();
  await browser.close();
}

check().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE
}

if ! check_chromium; then
  "$playwright" install-deps chromium
  check_chromium
fi
