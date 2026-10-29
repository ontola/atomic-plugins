// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error Plain JavaScript build helper.
import { build } from './build.mjs';

describe('Keep view bundle', async () => {
  const { text, bytes } = await build();
  it('exports a single view with embedded minified CSS', async () => {
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(module)).toEqual(['view']);
    expect(text).toContain('.keep-card{');
    expect(text).not.toMatch(/^\s*import\s|\bimport\(|require\(/m);
    // Measured 11,574 bytes minified on 2026-10-29; approximately 10% headroom.
    expect(bytes).toBeLessThan(12_800);
  });
  it('has no provider calls, credentials, persistent browser state or test fixture', () => {
    expect(text).not.toMatch(
      /\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|bearer|authorization/i,
    );
    expect(text).not.toContain('did:test:');
    expect(text).not.toContain('Imaginary groceries');
  });
});
