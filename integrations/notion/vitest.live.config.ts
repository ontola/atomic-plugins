// @wc-ignore-file
import base from './vitest.config.ts';

/** Only the live check, never the unit tests. Started by tooling/live-check.mjs. */
export default {
  ...base,
  test: { include: ['live/check.live.ts'], testTimeout: 12 * 60_000 },
};
