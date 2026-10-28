// @wc-ignore-file
/**
 * Builds the lens drive app to one ES module, `dist/ui.js`.
 *
 *   node integrations/physics/lens/build.mjs [--outfile path]
 *
 * See ../shared/build.mjs.
 */
import { fileURLToPath } from 'node:url';
import { makeBuild, runCli } from '../shared/build.mjs';

export const build = makeBuild(import.meta.url);

await runCli(
  build,
  import.meta.url,
  fileURLToPath(new URL('dist/ui.js', import.meta.url)),
);
