// Files this repo keeps a verbatim copy of from the pinned atomic-server.
//
// A published package here cannot import atomic-server's `browser/` by
// relative path (that tree only exists in a linked checkout), and the npm
// `@tomic/lib` it could depend on instead does not export these yet. Until it
// does, the copy stays, and this test is what keeps it from drifting: bumping
// `.atomic-server-ref` past a change to the host file fails here until the copy
// is updated to match.
//
// Needs the `browser` link (`node integrations/tooling/link-atomic-server.mjs`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './lanes.mjs';

const copies = [
  {
    // devonian exports reconcileRecord from its package root; the
    // integrations import the host's through @integration-host.
    copy: 'devonian/src/reconcileRecord.ts',
    host: 'browser/lib/src/plugin-reconcile.ts',
  },
];

for (const { copy, host } of copies) {
  test(`${copy} matches ${host} at the pinned atomic-server`, () => {
    const copied = readFileSync(resolve(root, copy), 'utf8');
    const original = readFileSync(resolve(root, host), 'utf8');
    assert.ok(
      copied === original,
      `${copy} differs from ${host} at .atomic-server-ref. Copy the host file ` +
        'over it (and release devonian if its behaviour changed).',
    );
  });
}
