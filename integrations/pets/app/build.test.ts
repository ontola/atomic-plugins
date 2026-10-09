// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';

describe('pets drive-plugin bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/node:|require\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource, so the size is capped at
    // the measured size plus about 10%: 85 203 bytes on 2026-10-09 for 0.1.4,
    // not minified (syncables 0.21.0's read path, about 70 kB of it: the
    // Throttling 0.2.0 classifier, Pagination Schemes 0.4.0/0.5.0 link
    // checks and windows, the larger scheme validator; no change to the
    // app's own code). 52 630 for 0.1.3 with syncables 0.19.0, 48 273 for
    // 0.1.2 with syncables 0.18.0. A change that needs more should say why
    // and re-measure.
    expect(bytes).toBeLessThan(93_800);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });
});
