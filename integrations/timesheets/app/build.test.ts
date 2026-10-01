// @wc-ignore-file
import { Datatype } from '@tomic/lib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';
import * as shim from './tomic-lib-shim.js';

describe('drive-plugin bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Stored as a string property on a resource: keep an eye on the size.
    // Measured 160,904 bytes minified on 2026-10-01 (0.5.0; JS by esbuild,
    // the stylesheet ui/theme.css by esbuild's CSS minifier); limit is that
    // plus ~10%. It was 64 KB before the #89 views, 91 KB before #123 M3's
    // write-back (edit form, "Changes to send", writeBack.ts), 118 KB
    // before M4's range edits (planner, new rows, resolve actions), 135 KB
    // before M5's lease, range-edit intents and log merging, and 144 KB
    // before #177's shared classes (ontology-kit's terms and resolver
    // inlined, project and person links, the first-open move and the
    // read-only view of another table).
    expect(bytes).toBeLessThan(177_000);
  });

  it('carries no credential handling of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });

  it("uses the real library's datatype values through the shim", () => {
    expect(shim.Datatype.TIMESTAMP).toBe(Datatype.TIMESTAMP);
  });
});
