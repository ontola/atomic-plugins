// @wc-ignore-file
/**
 * The browser-safe part of the npm `devonian` package (0.9.0, pinned in
 * ../../../package.json): its native Atomic Data API, the `devonian/atomic`
 * entry point.
 *
 * Not `import ... from 'devonian'`: the package root also exports the row
 * API and its Automerge-backed storage, which the drive-plugin bundle must
 * not include. `devonian/atomic` (since 0.7.0) has only the Atomic Data API
 * and resolves to compiled JS with `.d.ts`, so the deep paths into
 * node_modules/devonian/src that 0.6.1 needed are gone.
 */
export * from 'devonian/atomic';
