// @wc-ignore-file
import { Datatype, validateDatatype } from '@tomic/lib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';
import * as shim from './tomic-lib-shim.js';

describe('Notion drive-plugin bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/\brequire\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource, so the size is capped at
    // the measured size plus about 10% (the owner's rule for bundle limits).
    // Minified by esbuild, JS and embedded CSS; oldest first:
    // 0.1.0 117 969; 0.2.0 133 028 with the #89 browsing views; 0.3.0
    // 107 509; 0.4.0 113 536; 0.4.1 113 988 with syncables 0.18.0; 0.4.2
    // 115 818.
    // 0.5.0 125 712 on 2026-10-06: the shared sync-status card of Q-084
    // with its card.css and the view/status.ts mapping, on top of syncables
    // 0.19.0's read path, the catalog document, devonian's Atomic Data API,
    // the sync-status view of #177 Q9, #8's compare-on-open, review and
    // send, the option Tags of options.ts and #303's retirement of stray
    // columns.
    // 0.5.1 125 914 on 2026-10-08: devonian 0.9.0's compiled devonian/atomic
    // in place of 0.6.1's TypeScript sources.
    // 0.5.2 144 024 on 2026-10-09: syncables 0.21.0's read path (Pagination
    // Schemes 0.4.0/0.5.0 link checks and windows, the Throttling 0.2.0
    // classifier, CRUD Causality fixed reads); the app's own code unchanged.
    // 0.5.3 145 070 on 2026-10-13: formatted text imported as plain text
    // (usertest-findings#19).
    // 0.5.4 179 518 on 2026-10-14: syncables 0.23.0's read path in place of
    // 0.21.0's (+33 811: time zones, runtime schemas, pages, throttling,
    // produced classes, the invalid-auto-detected check, incomplete markers
    // and list tombstones) and the blocked-429 handling (637).
    // 0.5.5 179 723 on 2026-10-14: a blocked 429 is also caught on the
    // pre-PATCH GET and in the read transport (+205).
    // 0.5.6 179 742 on 2026-10-15: the read stops at the first blocked
    // answer instead of requesting every remaining data source (+19).
    // A change that needs more should say why and re-measure.
    expect(bytes).toBeLessThan(197_800);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    // Not /bearer|authorization/: the bundled catalog document names its
    // security schemes (`notionBearer`, `authorizationUrl`). No header is set.
    expect(text).not.toMatch(/connection-code|x-connection/i);
    expect(text).not.toMatch(/["']authorization["']\s*:|Bearer \$\{/i);
    expect(text).not.toMatch(/\bfetch\(/);
    expect(text).not.toMatch(/node:/);
  });

  it("uses the real library's datatype values through the shim", () => {
    for (const [key, value] of Object.entries(shim.Datatype))
      expect(Datatype[key as keyof typeof Datatype]).toBe(value);
  });

  it("validates like the real library's validateDatatype for the lens's datatypes", () => {
    const samples = ['text', '', 0, 1.5, 3, true, false, ['a', 'b'], {}];

    const outcome = (fn: () => void) => {
      try {
        fn();

        return 'ok';
      } catch (error) {
        return (error as Error).message;
      }
    };

    for (const datatype of [
      Datatype.STRING,
      Datatype.MARKDOWN,
      Datatype.FLOAT,
      Datatype.INTEGER,
      Datatype.BOOLEAN,
      Datatype.TIMESTAMP,
      Datatype.JSON,
    ])
      for (const value of samples)
        expect(outcome(() => shim.validateDatatype(value, datatype))).toBe(
          outcome(() => validateDatatype(value as never, datatype)),
        );
    expect(() => shim.validateDatatype('2026-01-01', Datatype.DATE)).toThrow(
      /Unsupported datatype/,
    );
  });

  it("bundles devonian's Atomic Data API only, not its Node/Automerge root", () => {
    expect(text).toMatch(/Conflicting identity mapping/);
    expect(text).not.toMatch(/automerge/i);
    expect(text).not.toMatch(/DevonianClient|DevonianTable/);
  });
});
