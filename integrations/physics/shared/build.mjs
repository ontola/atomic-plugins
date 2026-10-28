// @wc-ignore-file
/**
 * The build the three physics drive apps share. Each app's own `build.mjs`
 * is `export const build = makeBuild(import.meta.url)`: bundle the `main.ts`
 * beside it, with the shared stylesheet and its own, to one ES module, the
 * string an install flow stores as the App's `plugin-source`.
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild. No npm dependencies. No code splitting and no CSS
 * file: "a plugin in the drive is one module".
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cssRawPlugin } from '../../sync-status/build.mjs';

/** `build({ outfile })` for the app whose build.mjs is at `appUrl`. Bundles in memory; writes only when `outfile` is given. */
export function makeBuild(appUrl) {
  const path = relative => fileURLToPath(new URL(relative, appUrl));
  const root = fileURLToPath(new URL('../../../', import.meta.url));

  return async function build({ outfile } = {}) {
    const require = createRequire(`${root}browser/package.json`);
    const esbuild = require('esbuild');
    const result = await esbuild.build({
      entryPoints: [path('main.ts')],
      // esbuild's `// path` comments are relative to this, so pin it to the
      // repository root: the bytes (and the catalog's integrity hash for
      // them) must not depend on the directory the build was started from.
      absWorkingDir: root,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      splitting: false,
      legalComments: 'none',
      minify: true,
      plugins: [cssRawPlugin(esbuild)],
      write: false,
      outfile: outfile ?? path('dist/ui.js'),
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
  };
}

/** The same `--outfile` command line every app's build.mjs offers. */
export async function runCli(build, selfUrl, defaultOutfile) {
  if (process.argv[1] !== fileURLToPath(selfUrl)) return;
  const at = process.argv.indexOf('--outfile');
  const outfile = at > 0 ? process.argv[at + 1] : defaultOutfile;
  const out = await build({ outfile });
  console.info(`${outfile}: ${out.bytes} bytes, sha256 ${out.sha256}`);
}
