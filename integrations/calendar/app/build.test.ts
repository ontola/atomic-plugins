// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';

describe('calendar drive-plugin bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    // `__require` is esbuild's wrapper for fast-json-stable-stringify (a
    // CommonJS dependency of plugin-reconcile.ts), not a module loader.
    expect(text).not.toMatch(/node:|(?<![\w$])require\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource: keep an eye on the size.
    // Measured 111,872 bytes (about 109 KiB) with minified JS and CSS
    // (2026-10-01, 0.1.4: the #89 designed UI, the pin-007869464 host
    // operations, compare on open and the declared-operations check in the
    // relay). The limit is that plus about 10%, rounded up to 120 KiB, so a
    // real growth fails here instead of passing silently.
    expect(bytes).toBeLessThan(120 * 1024);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/bearer|connection-code/i);
    // Since 0.1.4 the adapter has no sandbox manifest and no credential
    // placeholder: the bundle names no credential at all. The frame names a
    // connection id, and `If-Match` is the only header it sets. The word
    // boundary leaves out `unsupported_authorization`, a retired proxy
    // refusal code the controller still recognises (relay.ts).
    expect(text).not.toMatch(/\bauthorization\b|secret:/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });
});
