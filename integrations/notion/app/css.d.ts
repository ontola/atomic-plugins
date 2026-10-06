// @wc-ignore-file
/**
 * `card.css?raw` from the shared sync-status card (`integrations/sync-status/
 * card.ts`): the stylesheet's text, which `build.mjs` minifies (`cssRawPlugin`)
 * and Vitest reads as written (`vitest.config.ts`, `css.include`).
 */
declare module '*.css?raw' {
  const text: string;

  export default text;
}
