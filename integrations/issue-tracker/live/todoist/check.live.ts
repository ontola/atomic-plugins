// @wc-ignore-file
/**
 * Entry point of the Todoist live check. Never run bare: it needs
 * `LIVE_CHECK_CONFIRMED` (set by `node integrations/tooling/live-check.mjs
 * todoist --i-understand-this-writes-to <project id>`) and the token in
 * `TODOIST_API_TOKEN`. Only `../../vitest.live.todoist.config.ts` includes
 * this file.
 */
import { describe, expect, it } from 'vitest';
import { liveSettings } from '../../../tooling/live-kit.mjs';
import { runTodoistCheck } from './scenario.js';

describe('todoist live check', () => {
  it(
    'runs the scenarios against the disposable project',
    async () => {
      const settings = liveSettings();
      const { doc, files } = await runTodoistCheck({
        project: settings.target,
        token: process.env.TODOIST_API_TOKEN ?? '',
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
