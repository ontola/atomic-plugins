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
    // the measured size plus about 10%: 73 416 bytes on 2026-10-13 for 0.1.5,
    // minified, with syncables 0.22.0. Its read path grew by 29 434 bytes over
    // 0.21.0 (the app's own code is unchanged), mainly: read/time-zone (8 250,
    // new), read/runtime-schemas (7 489, new), read/pages (+5 626),
    // throttling (+1 867), pagination/validate (+1 665), read/collections
    // (+1 513), read/produced-classes (1 599, new). readCollections calls
    // them on every read, so they do not shake out; making them opt-in is a
    // 0.23.0 design question. 43 982 for 0.1.4 with syncables 0.21.0;
    // 52 630 for 0.1.3 unminified with syncables 0.19.0, 48 273 for 0.1.2
    // with syncables 0.18.0. A change that needs more should say why and
    // re-measure.
    expect(bytes).toBeLessThan(80_800);
  });

  it('carries no credential handling or network access of its own', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(/);
  });
});
