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
    // the measured size plus about 10%: 43 982 bytes on 2026-10-12 for 0.1.4,
    // minified by esbuild (syncables 0.21.0's read path; 85 203 for the same
    // code unminified). 52 630 for 0.1.3 unminified with syncables 0.19.0,
    // 48 273 for 0.1.2 with syncables 0.18.0. A change that needs more
    // should say why and re-measure.
    expect(bytes).toBeLessThan(48_400);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });
});
