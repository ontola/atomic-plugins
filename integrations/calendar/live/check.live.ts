// @wc-ignore-file
/**
 * Entry point of the Calendar live check. Never run bare: it needs
 * `LIVE_CHECK_CONFIRMED` (set by `node integrations/tooling/live-check.mjs
 * calendar --i-understand-this-writes-to <calendar id>`) and the credential
 * in `GOOGLE_CALENDAR_ACCESS_TOKEN`. The default unit config does not include
 * this file (`*.live.ts`); `../vitest.live.config.ts` does.
 */
import { describe, expect, it } from 'vitest';
import { liveSettings } from '../../tooling/live-kit.mjs';
import { runCalendarCheck } from './scenario.js';

describe('calendar live check', () => {
  it(
    'runs the scenarios against the disposable calendar',
    async () => {
      const settings = liveSettings();
      const token = process.env.GOOGLE_CALENDAR_ACCESS_TOKEN ?? '';
      const { doc, files } = await runCalendarCheck({
        calendarId: settings.target,
        token,
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
