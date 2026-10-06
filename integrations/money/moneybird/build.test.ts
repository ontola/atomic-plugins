// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';

describe('moneybird drive-app bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/node:|require\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    // Measured 31,943 bytes minified on 2026-10-06 (0.2.0, which bundles
    // ontology-kit/terms.mjs), at the a12b74a6783b pin; the limit is that
    // plus about 10%, rounded up.
    expect(bytes).toBeLessThan(35_200);
  });

  it('carries no credential handling, network access or fixture data', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest/);
    expect(text).not.toMatch(/Synthetic Studio|example\.invalid/);
  });
});
