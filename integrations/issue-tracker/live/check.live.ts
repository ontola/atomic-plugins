// @wc-ignore-file
/**
 * Entry point of the GitHub issues live check. Never run bare: it needs
 * `LIVE_CHECK_CONFIRMED` (set by `node integrations/tooling/live-check.mjs
 * issue-tracker --i-understand-this-writes-to <owner/name>`) and the token in
 * `GITHUB_TOKEN`. Only `../vitest.live.config.ts` includes this file.
 */
import { describe, expect, it } from 'vitest';
import { liveSettings } from '../../tooling/live-kit.mjs';
import { runGithubCheck } from './scenario.js';

describe('github issues live check', () => {
  it(
    'runs the scenarios against the disposable repository',
    async () => {
      const settings = liveSettings();
      const { doc, files } = await runGithubCheck({
        repository: settings.target,
        token: process.env.GITHUB_TOKEN ?? '',
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
