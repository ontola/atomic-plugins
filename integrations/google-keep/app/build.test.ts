// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';

describe('Google Keep drive-app bundle', async () => {
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
    // Measured 56,274 bytes minified on 2026-10-20 for 0.1.0 with list
    // items merged item by item (lists.ts), the read-only and one-note
    // settings and the shared sync-status card included; the limit is that
    // plus about 10%, rounded up.
    expect(bytes).toBeLessThan(62_000);
  });

  it('bundles the shared sync-status card and its minified stylesheet', () => {
    expect(text).toContain('Sync status');
    expect(text).toContain('.ss-head{');
    expect(text).not.toContain('/* The sync-status card');
  });

  it('carries no credential handling, network access or fixture data', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest/);
    expect(text).not.toMatch(/synthetic-note|example\.com/);
  });

  it('names Google by its proxy path only', () => {
    expect(text).toContain('/v1/notes');
    expect(text).not.toMatch(/https:\/\/[a-z.]*googleapis\.com/);
  });
});
