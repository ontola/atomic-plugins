// @wc-ignore-file
/**
 * Entry point of the Notion live check. Never run bare: it needs
 * `LIVE_CHECK_CONFIRMED` (set by `node integrations/tooling/live-check.mjs
 * notion --i-understand-this-writes-to <data source id>`) and the integration
 * secret in `NOTION_TOKEN`. Only `../vitest.live.config.ts` includes this file.
 */
import { describe, expect, it } from 'vitest';
import { liveSettings } from '../../tooling/live-kit.mjs';
import { runNotionCheck } from './scenario.js';

describe('notion live check', () => {
  it(
    'runs the scenarios against the disposable data source',
    async () => {
      const settings = liveSettings();
      const { doc, files } = await runNotionCheck({
        dataSource: settings.target,
        token: process.env.NOTION_TOKEN ?? '',
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
