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
    // Measured 51,026 bytes minified on 2026-10-28; limit is that plus ~10%.
    expect(bytes).toBeLessThan(56_100);
  });

  it('carries the shared skill, lesson and mastery subjects and the starter tree', () => {
    expect(text).toContain('ontology/classes/skill-v1');
    expect(text).toContain('ontology/classes/lesson-v1');
    expect(text).toContain('ontology/classes/mastery-v1');
    expect(text).toContain('Krachten en de wetten van Newton');
  });

  it('has no network, storage or credential handling', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer/i);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket/);
    expect(text).not.toMatch(/store\.proxy|\.proxy\b/);
  });
});
