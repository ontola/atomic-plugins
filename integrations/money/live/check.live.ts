// @wc-ignore-file
/**
 * Entry point of the Moneybird live check. Never run bare: it needs
 * `LIVE_CHECK_CONFIRMED` (set by `node integrations/tooling/live-check.mjs
 * moneybird --i-understand-this-writes-to <administration id>`) and the token
 * in `MONEYBIRD_API_TOKEN`. Only `../vitest.live.config.ts` includes this file.
 */
import { describe, expect, it } from 'vitest';
import { liveSettings } from '../../tooling/live-kit.mjs';
import { runMoneybirdCheck } from './scenario.js';

describe('moneybird live check', () => {
  it(
    'runs the scenarios against the disposable administration',
    async () => {
      const settings = liveSettings();
      const { doc, files } = await runMoneybirdCheck({
        administration: settings.target,
        token: process.env.MONEYBIRD_API_TOKEN ?? '',
        ...(settings.outDir ? { outDir: settings.outDir } : {}),
        ...(settings.maxMutations
          ? { maxMutations: settings.maxMutations }
          : {}),
        ...(settings.maxMs ? { maxMs: settings.maxMs } : {}),
        preflightOnly: settings.preflightOnly,
        log: line => process.stderr.write(line),
      });
      process.stderr.write(
        `evidence: ${files.json}\n          ${files.markdown}\n`,
      );
      expect(['passed', 'preflight-only']).toContain(doc.status);
    },
    12 * 60_000,
  );
});
