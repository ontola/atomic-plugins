// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';

describe('learning drive-app bundle', async () => {
  const { text, bytes } = (await build()) as { text: string; bytes: number };

  it('is one self-contained ES module exporting view()', async () => {
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text).not.toMatch(/["']node:|require\(/);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    );
    expect(Object.keys(mod)).toEqual(['view']);
    expect(typeof mod.view).toBe('function');
    // Measured 127,403 bytes minified on 2026-10-28: the app itself (about
    // 51 kB) plus the three physics modules (70,862 bytes) it carries as
    // strings. The limit is that plus ~10%.
    expect(bytes).toBeLessThan(140_200);
  });

  it('carries the shared skill, lesson and mastery subjects and the starter tree', () => {
    expect(text).toContain('ontology/classes/skill-v1');
    expect(text).toContain('ontology/classes/lesson-v1');
    expect(text).toContain('ontology/classes/mastery-v1');
    expect(text).toContain('Krachten en de wetten van Newton');
  });

  it('carries the three physics drive apps as module source it stores in the drive', () => {
    // Markers only the built physics modules contain: the lens rays, the
    // magnet field layer and the spring curve, and each one's export.
    expect(text).toContain('data-rays');
    expect(text).toContain('data-layer');
    expect(text).toContain('data-curve');
    // This module's own export, and one inside each embedded string.
    expect(text.match(/export\{[^}]*as view\}/g)).toHaveLength(4);
  });

  it('has no network, storage or credential handling', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer/i);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
    expect(text).not.toMatch(/store\.proxy|\.proxy\b/);
  });
});
