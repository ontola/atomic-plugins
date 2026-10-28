// @wc-ignore-file
/**
 * Provided by `build.mjs` (an esbuild plugin that builds the three physics
 * drive apps in memory) and, in unit tests, by the stub vitest.config.ts
 * aliases it to. Never a real module on disk.
 */
declare module 'virtual-physics-modules' {
  const sources: { lens: string; magnet: string; spring: string };

  export default sources;
}
