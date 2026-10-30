// @wc-ignore-file
/** One self-contained table view module; uses the host checkout's esbuild.
 * node integrations/google-keep-view/app/build.mjs [--outfile path]
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cssRawPlugin } from '../../sync-status/build.mjs';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

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
    plugins: [cssRawPlugin(esbuild)],
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
    `${outfile ?? 'google-keep-view app'}: ${out.bytes} bytes, sha256 ${out.sha256}`,
  );
}
