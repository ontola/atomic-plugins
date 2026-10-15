/**
 * Proves every public entry point of the package runs in a browser:
 *
 * 1. Each `exports` subpath is bundled with esbuild `platform: 'browser'` and
 *    no Node polyfills; a plugin fails the build on any import of a Node
 *    built-in (`node:*` or a bare `fs`, `events`, ...).
 * 2. A small driver per entry point (fixtures/*.mjs) is bundled the same way
 *    and run in a `node:vm` context that has the browser globals it needs
 *    (timers, `structuredClone`, `TextEncoder`, `URL`, `crypto`) and none of
 *    Node's (`process`, `Buffer`, `require`, `module`, `global`).
 *
 * The bare `devonian*` specifiers resolve through package.json's own
 * `exports`, honouring the `browser` condition, so the export map is under
 * test too. By default each `./build/src/X.js` target is mapped back to
 * `src/X.ts` so this runs before `pnpm build`; with DEVONIAN_TEST_BUILD=1
 * (set by CI after `pnpm build`) the compiled `build/` output is bundled
 * instead, which is what npm consumers get.
 *
 * A real engine is ../real-browser/ (headless Chromium, Playwright,
 * `pnpm run test:real-browser`), which runs the same drivers against the
 * same `expected` results (./bundling.ts), plus Web Locks, IndexedDB and a
 * service worker.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  bundle,
  drivers,
  expected,
  exportTarget,
  packagesIn,
  root,
  subpaths,
  useBuild,
} from './bundling.js';

/** A context with browser-provided globals only: no Node ones. */
function browserLikeContext(): vm.Context {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    EventTarget,
    Event,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
  });
  vm.runInContext('globalThis.self = globalThis.window = globalThis;', context);
  return context;
}

describe(`browser bundles (${useBuild ? 'build/' : 'src/'})`, () => {
  it('has a driver for every exported entry point', () => {
    expect(Object.keys(drivers).sort()).toEqual([...subpaths].sort());
  });

  it.each(subpaths)(
    '%s bundles for the browser without Node built-ins',
    async (subpath) => {
      const { nodeImports, text } = await bundle(
        exportTarget(subpath, ['browser']),
        'esm',
      );
      expect(nodeImports).toEqual([]);
      expect(text.length).toBeGreaterThan(0);
    },
  );

  it('the guard catches Node built-ins (reflect without the browser condition)', async () => {
    const { nodeImports } = await bundle(
      exportTarget('./reflect', []),
      'esm',
      [],
    );
    expect(nodeImports.some((i) => i.startsWith('node:fs/promises'))).toBe(
      true,
    );
  });

  it('never bundles Automerge from any entry point', async () => {
    for (const subpath of subpaths) {
      const { metafile } = await bundle(
        exportTarget(subpath, ['browser']),
        'esm',
      );
      expect(
        packagesIn(metafile).filter((p) => p.startsWith('@automerge/')),
      ).toEqual([]);
    }
  });

  it('keeps devonian/atomic free of effect and the row API', async () => {
    const { metafile, text } = await bundle(
      `${root}__tests__/browser/fixtures/atomic.mjs`,
      'esm',
    );
    expect(packagesIn(metafile)).toEqual(['@tomic/lib']);
    expect(text).not.toContain('DevonianTable');
  });

  it('the vm context has no Node globals', () => {
    const context = browserLikeContext();
    expect(
      vm.runInContext(
        '[typeof process, typeof Buffer, typeof require, typeof module, typeof global]',
        context,
      ),
    ).toEqual([
      'undefined',
      'undefined',
      'undefined',
      'undefined',
      'undefined',
    ]);
  });

  it('keeps the lens algebra free of runtime packages', async () => {
    const { metafile } = await bundle(
      exportTarget('./lenses', ['browser']),
      'esm',
    );
    expect(packagesIn(metafile)).toEqual([]);
  });

  it.each(Object.entries(drivers))(
    '%s runs in a browser-like context',
    async (subpath, driver) => {
      const { text, nodeImports } = await bundle(
        `${root}__tests__/browser/fixtures/${driver}.mjs`,
        'iife',
      );
      expect(nodeImports).toEqual([]);
      const context = browserLikeContext();
      vm.runInContext(text, context, { filename: `${driver}.bundle.js` });
      const result = JSON.parse(
        JSON.stringify(await (context.__result as Promise<unknown>)),
      );
      expect(result).toEqual(expected[subpath]);
    },
  );
});
