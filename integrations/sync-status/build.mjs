// @wc-ignore-file
/**
 * Build helper for apps that use the shared sync-status card (`card.ts`
 * imports `card.css?raw`). Apps add `cssRawPlugin(esbuild)` to their esbuild
 * plugins; it also serves an app's own `*.css?raw` imports.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `import css from './x.css?raw'` as the stylesheet's text, run through
 * esbuild's CSS minifier first (deterministic, so the committed bundle can
 * still be rebuilt byte for byte). Used by `ui/theme.ts`.
 */
export function cssRawPlugin(esbuild) {
  return {
    name: 'css-raw-minified',
    setup(b) {
      b.onResolve({ filter: /\.css\?raw$/ }, args => ({
        path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
        namespace: 'css-raw',
      }));
      b.onLoad({ filter: /.*/, namespace: 'css-raw' }, async args => {
        const { code } = await esbuild.transform(
          readFileSync(args.path, 'utf8'),
          { loader: 'css', minify: true, legalComments: 'none' },
        );

        return { contents: code.trim(), loader: 'text' };
      });
    },
  };
}
