// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs files are plain JS with no declaration file.
import { build as buildLens } from '../lens/build.mjs';
// @ts-expect-error see above
import { build as buildMagnet } from '../magnet/build.mjs';
// @ts-expect-error see above
import { build as buildSpring } from '../spring/build.mjs';

type Built = { text: string; bytes: number };

const apps: [string, () => Promise<Built>][] = [
  ['lens', buildLens],
  ['magnet', buildMagnet],
  ['spring', buildSpring],
];

describe.each(apps)('physics %s drive-app bundle', (_name, build) => {
  it('is one self-contained ES module exporting only view()', async () => {
    const { text, bytes } = await build();
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/["']node:|require\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Measured 2026-10-28 at 20 to 30 kB minified; a generous ceiling.
    expect(bytes).toBeLessThan(40_000);
  });

  it('has no network, storage, credential or ontology code, and no external assets', async () => {
    const { text } = await build();
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    expect(text).not.toMatch(/authorization|bearer|\.proxy\b/i);
    expect(text).not.toMatch(
      /atomicdata\.dev|ontology\/classes|ontola\.github\.io/,
    );
    expect(text).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(text).not.toMatch(/@import|url\(/);
  });
});
