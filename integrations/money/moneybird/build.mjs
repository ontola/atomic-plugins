// @wc-ignore-file
/**
 * Builds the Moneybird drive app to one ES module: the string an install
 * flow stores as the App's `plugin-source`. Prints its size and hash; writes
 * a file only when asked to.
 *
 *   node integrations/money/moneybird/build.mjs [--outfile path]
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild. No npm dependencies of its own.
 * No code splitting and no CSS file: "a plugin in the drive is one module";
 * the shared sync-status card's `card.css?raw` is embedded as minified text
 * by `cssRawPlugin` (`integrations/sync-status/build.mjs`).
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
    // Any path esbuild embeds is relative to this; pinned to the repository
    // root so the bytes do not depend on where the build was started.
    absWorkingDir: path('../../..'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: false,
    minify: true,
    legalComments: 'none',
    write: false,
    outfile: outfile ?? path('ui.js'),
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
    `${outfile ?? 'moneybird app'}: ${out.bytes} bytes, sha256 ${out.sha256}`,
  );
}
