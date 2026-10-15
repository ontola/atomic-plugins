// @wc-ignore-file
/**
 * Bundles the webhook inbox sandbox plugin (`plugin.ts`) as one ES module,
 * the way certify.mjs bundles a plugin (esm, neutral platform, es2022).
 * `syncables/browser` is this repository's `syncables/src/browser.ts`: the
 * inbox consumer is not in a published syncables release yet.
 *
 *   node integrations/issue-tracker/inbox/build.mjs [--proxy-origin <origin>] [--out <file>]
 *
 * `--proxy-origin` (default https://localthought.io) is the integration
 * proxy the declared operations name; the e2e passes the lane's mock proxy.
 * TODO(ontola/atomic-server#2228): the origin goes away with `atomic-proxy:`
 * consumer routes. Without `--out` the bundle goes to stdout.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path => fileURLToPath(new URL(path, import.meta.url));
const require = createRequire(here('../../../browser/package.json'));
const { build } = require('esbuild');

export async function bundle({ proxyOrigin } = {}) {
  const result = await build({
    entryPoints: [here('./plugin.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    alias: { 'syncables/browser': here('../../../syncables/src/browser.ts') },
    define: proxyOrigin
      ? { __INBOX_PROXY_ORIGIN__: JSON.stringify(proxyOrigin) }
      : {},
  });

  return result.outputFiles[0].text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = name => {
    const index = process.argv.indexOf(name);

    return index < 0 ? undefined : process.argv[index + 1];
  };

  const text = await bundle({ proxyOrigin: arg('--proxy-origin') });
  const out = arg('--out');
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
