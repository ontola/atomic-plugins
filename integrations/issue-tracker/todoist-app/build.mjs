// @wc-ignore-file
/**
 * Builds the Todoist drive app to one ES module: the string an install flow
 * stores as the App's `plugin-source`. Prints its size and hash; writes a
 * file only when asked to.
 *
 *   node integrations/issue-tracker/todoist-app/build.mjs [--outfile path]
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild. No npm dependencies of its own: it bundles
 * ../todoist.ts, ontology-kit's terms and resolver, and the small
 * `Datatype` shim that stands in for the atomic library ../todoist.ts
 * imports (atomic-lib-shim.ts). No code splitting and no CSS file: "a plugin
 * in the drive is one module".
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

/** `../../browser/lib/src/index.js` (as ../todoist.ts and read.ts import it) -> the shim. */
const atomicLibShim = {
  name: 'atomic-lib-shim',
  setup(bundle) {
    bundle.onResolve({ filter: /browser\/lib\/src\/index\.js$/ }, () => ({
      path: path('atomic-lib-shim.ts'),
    }));
  },
};

/** Bundles in memory; writes only when `outfile` is given. */
export async function build({ outfile } = {}) {
  const require = createRequire(path('../../../browser/package.json'));
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    entryPoints: [path('main.ts')],
    // esbuild's `// path` comments and any path it embeds are relative to
    // this, so pin it to the repository root: the bytes (and the catalog's
    // integrity hash for them) must not depend on the directory the build
    // was started from.
    absWorkingDir: path('../../..'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: false,
    minify: true,
    legalComments: 'none',
    write: false,
    outfile: outfile ?? path('dist/ui.js'),
    plugins: [atomicLibShim],
    logLevel: 'silent',
  });
  const text = result.outputFiles[0].text;

  if (outfile) {
    mkdirSync(dirname(outfile), { recursive: true });
    writeFileSync(outfile, text);
  }

  return {
    text,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--outfile');
  const outfile = at > 0 ? process.argv[at + 1] : undefined;
  const out = await build({ outfile });
  console.info(
    `${outfile ?? 'todoist app'}: ${out.bytes} bytes, sha256 ${out.sha256}`,
  );
}
