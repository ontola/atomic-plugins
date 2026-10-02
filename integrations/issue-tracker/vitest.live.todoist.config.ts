// @wc-ignore-file
import base from './vitest.config.ts';

/**
 * Only the Todoist live check, never the unit tests (the GitHub issues one is
 * vitest.live.config.ts). Started by tooling/live-check.mjs.
 */
export default {
  ...base,
  test: {
    css: base.test.css,
    include: ['live/todoist/check.live.ts'],
    testTimeout: 12 * 60_000,
  },
};
