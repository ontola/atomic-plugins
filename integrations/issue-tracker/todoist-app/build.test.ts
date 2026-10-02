// @wc-ignore-file
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Datatype } from '../../../browser/lib/src/index';
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';
import * as shim from './atomic-lib-shim.js';
import { ISSUE_V1 } from './drive.js';

describe('Todoist drive-app bundle', async () => {
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
    // Measured 26,857 bytes minified on 2026-10-02 for 0.1.1, at the
    // a12b74a6783b pin: ../todoist.ts, ontology-kit's terms and resolver,
    // the issue-v1 provisioning and the plain-DOM view, plus (0.1.1) the
    // hand-made and incomplete rows with "Open row" (0.1.0 was 25,926
    // bytes). The limit is that plus about 10%, rounded up.
    expect(bytes).toBeLessThan(29_600);
  });

  it('carries no credential handling, network access or fixture data', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest/);
    expect(text).not.toMatch(/synthetic-task|Synthetic house/);
  });

  it('bundles the shim, not the atomic library, and the published issue-v1 subject', () => {
    expect(text).not.toMatch(/Conflicting identity mapping|class Store\b/);
    expect(text).toContain(ISSUE_V1);
  });

  it("uses the real library's Datatype values through the shim", () => {
    for (const [key, value] of Object.entries(shim.Datatype))
      expect(Datatype[key as keyof typeof Datatype]).toBe(value);
  });
});

describe('Todoist drive-app types', () => {
  // vitest strips types without checking them; the lane has no typecheck
  // tier for todoist-app/, so its tsconfig is checked here.
  it('typechecks', () => {
    const tsc = fileURLToPath(
      new URL('../../../browser/node_modules/.bin/tsc', import.meta.url),
    );
    const result = spawnSync(
      tsc,
      ['-p', fileURLToPath(new URL('tsconfig.json', import.meta.url))],
      { encoding: 'utf8' },
    );
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  }, 120_000);
});
