// @wc-ignore-file
/**
 * Builds the Atomic Education (learning) drive app to one ES module, `dist/ui.js`: the string an
 * install flow stores as the App's `plugin-source`.
 *
 *   node integrations/learning/app/build.mjs [--outfile path]
 *
 * Needs an atomic-server checkout's `browser/` beside `integrations/` (see
 * AGENTS.md), for esbuild. No npm dependencies: the core, the starter tree and
 * the shared ontology terms are bundled from this repository.
 * No code splitting and no CSS file: "a plugin in the drive is one module".
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cssRawPlugin } from '../../sync-status/build.mjs';
import { build as buildLens } from '../../physics/lens/build.mjs';
import { build as buildMagnet } from '../../physics/magnet/build.mjs';
import { build as buildSpring } from '../../physics/spring/build.mjs';

/**
 * `import sources from 'virtual-physics-modules'`: the three physics drive
 * apps, built in memory, as strings. The starter tree stores them as Apps in
 * the drive (`miniapps.ts`), so they travel inside this one module.
 */
export function physicsModulesPlugin() {
  const name = 'virtual-physics-modules';

  return {
    name,
    setup(esbuild) {
      esbuild.onResolve({ filter: /^virtual-physics-modules$/ }, () => ({
        path: name,
        namespace: name,
      }));
      esbuild.onLoad({ filter: /.*/, namespace: name }, async () => {
        const [lens, magnet, spring] = await Promise.all([
          buildLens(),
          buildMagnet(),
          buildSpring(),
        ]);

        return {
          loader: 'js',
          contents: `export default ${JSON.stringify({
            lens: lens.text,
            magnet: magnet.text,
            spring: spring.text,
          })};`,
        };
      });
    },
  };
}

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

/** Bundles in memory; writes only when `outfile` is given. */
export async function build({ outfile } = {}) {
  const require = createRequire(path('../../../browser/package.json'));
  const esbuild = require('esbuild');
  const result = await esbuild.build({
    entryPoints: [path('main.ts')],
    // esbuild's `// path` comments are relative to this, so pin it to the
    // repository root: the bytes (and the catalog's integrity hash for them)
    // must not depend on the directory the build was started from.
    absWorkingDir: path('../../..'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    splitting: false,
    legalComments: 'none',
    // Every drive app is minified (AGENTS.md, "Bundle size"); `styles.css?raw`
    // goes through esbuild's CSS minifier in `cssRawPlugin`.
    minify: true,
    plugins: [cssRawPlugin(esbuild), physicsModulesPlugin()],
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--outfile');
  const outfile = at > 0 ? process.argv[at + 1] : path('dist/ui.js');
  const out = await build({ outfile });
  console.info(`${outfile}: ${out.bytes} bytes, sha256 ${out.sha256}`);
}
