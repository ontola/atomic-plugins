// @wc-ignore-file
/**
 * Entry point of the Timesheets live check. Never run bare: it needs
 * `LIVE_CHECK_CONFIRMED` (set by `node integrations/tooling/live-check.mjs
 * timesheets --i-understand-this-writes-to <workspace id>`) and the key in
 * `CLOCKIFY_API_KEY`. Only `../vitest.live.config.ts` includes this file.
 */
import { describe, expect, it } from 'vitest';
import { liveSettings } from '../../tooling/live-kit.mjs';
import { runTimesheetsCheck } from './scenario.js';

describe('timesheets live check', () => {
  it(
    'runs the scenarios against the dedicated test workspace',
    async () => {
      const settings = liveSettings();
      const { doc, files } = await runTimesheetsCheck({
        workspaceId: settings.target,
        apiKey: process.env.CLOCKIFY_API_KEY ?? '',
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
