// @wc-ignore-file
import { describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from './build.mjs';
import { ISSUE_V1 } from './drive.js';

describe('Google Tasks drive-app bundle', async () => {
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
    // Measured 41,471 bytes minified on 2026-10-06 for 0.1.0, at the
    // a12b74a6783b pin: ontology-kit's terms and resolver, the issue-v1
    // provisioning, the reader with its rate-limit handling, the task list
    // picker and the plain-DOM view, plus the shared sync-status card with
    // its minified CSS and the status mapping (incl. the last-pass time and
    // the partial-pass problem). The limit is that plus about 10%, rounded
    // up.
    expect(bytes).toBeLessThan(45_700);
  });

  it('bundles the shared sync-status card and its minified stylesheet', () => {
    expect(text).toContain('Sync status');
    expect(text).toContain('.ss-head{');
    // Minified: no CSS comment survives.
    expect(text).not.toContain('/* The sync-status card');
  });

  it('carries no credential handling, network access or fixture data', () => {
    expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(text).not.toMatch(/authorization|bearer|connection-code/i);
    expect(text).not.toMatch(/\bfetch\(|XMLHttpRequest/);
    expect(text).not.toMatch(/synthetic-task|imaginary ferns/);
  });

  it('bundles the published issue-v1 subject and names Google by its proxy path only', () => {
    expect(text).toContain(ISSUE_V1);
    expect(text).toContain('/tasks/v1/');
    // No absolute Google URL: every call goes to the host's relay by path.
    expect(text).not.toMatch(/https:\/\/[a-z.]*googleapis\.com/);
  });
});
